import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Config, Entry, Change, UserError, excluded, remoteFile, safeRelative } from './core';
import { Transport } from './transport';
import { SyncCache } from './cache';
import { crc32File } from './checksum';
import { RemoteComparison } from './comparison';
export { crc32File } from './checksum';

export async function localPath(root: string, relative: string): Promise<string> {
  safeRelative(relative);
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error(`Symbolic link not allowed: ${relative}`); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  return current;
}
export async function scanLocal(root: string, c: Config, cancelled: () => void, scope = '', log: (message: string) => void = () => {}): Promise<Map<string, Entry>> {
  const result = new Map<string, Entry>();
  if (scope && excluded(scope,c.exclude,c.legacyIgnore)) return result;
  async function walk(dir: string, prefix: string): Promise<void> {
    cancelled();
    log(`Reading local directory: ${dir}`);
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      cancelled();
      const relative = prefix + e.name;
      if (excluded(relative, c.exclude, c.legacyIgnore) || e.isSymbolicLink()) { log(`Skipped (exclusion or symbolic link): ${relative}`); continue; }
      safeRelative(relative);
      if (e.isDirectory()) await walk(path.join(dir,e.name), relative + '/');
      else if (e.isFile()) { const s = await fs.stat(path.join(dir,e.name)); result.set(relative,{ size:s.size, mtime:s.mtimeMs }); }
    }
  }
  const start = scope ? await localPath(root,safeRelative(scope)) : root;
  await walk(start,scope ? scope+'/' : ''); return result;
}
export async function scanRemote(t: Transport, c: Config, cancelled: () => void, scope = ''): Promise<Map<string, Entry>> {
  const result = new Map<string, Entry>();
  if (scope && excluded(scope,c.exclude,c.legacyIgnore)) return result;
  let start = c.remote_path;
  if (scope) {
    for (const part of safeRelative(scope).split('/')) {
      cancelled();
      const entry = (await t.list(start)).find(e => e.name === part);
      if (!entry) return result;
      if (entry.symlink || !entry.directory) throw new Error('Incompatible remote directory or symbolic link.');
      start = path.posix.join(start,part);
    }
  }
  async function walk(dir: string, prefix: string, depth: number): Promise<void> {
    cancelled();
    if (depth > 64) throw new Error('Remote directory tree is too deep.');
    for (const e of await t.list(dir)) {
      cancelled();
      if (e.name === '.' || e.name === '..') continue;
      safeRelative(e.name);
      if (e.name.includes('/')) throw new Error('Invalid remote name.');
      const relative = prefix + e.name;
      if (excluded(relative,c.exclude,c.legacyIgnore) || e.symlink) continue;
      if (e.directory) await walk(remoteFile(c,relative),relative+'/',depth+1);
      else result.set(relative,{ size:e.size,mtime:e.mtime });
    }
  }
  await walk(start,scope ? scope+'/' : '',0); return result;
}
export async function download(t: Transport, c: Config, root: string, relative: string, mtime?: number): Promise<void> {
  const destination = await localPath(root,relative);
  await fs.mkdir(path.dirname(destination),{ recursive:true });
  const temporary = path.join(path.dirname(destination),`.wsftp-${randomUUID()}.tmp`);
  try {
    await t.download(remoteFile(c,relative),temporary);
    if (mtime && mtime > 0) await fs.utimes(temporary,new Date(),new Date(mtime));
    await localPath(root,relative);
    await fs.rename(temporary,destination);
  } finally { await fs.rm(temporary,{ force:true }); }
}

export async function planSync(t: Transport, c: Config, root: string, local: Map<string, Entry>, remote: Map<string, Entry>, direction: 'upload' | 'download', cancelled: () => void, log: (message: string) => void = () => {}, cache?: SyncCache): Promise<Change[]> {
  const source = direction === 'upload' ? local : remote;
  const target = direction === 'upload' ? remote : local;
  const candidates: Change[] = [...source].map(([relative,entry]) => ({relative,source:entry,target:target.get(relative),reason:target.has(relative) ? 'changed' : 'new'}));
  candidates.sort((a,b) => a.relative.localeCompare(b.relative));
  const changes: Change[] = [];
  const observations = cache ?? new SyncCache();
  const comparison = new RemoteComparison(t,c,observations,cancelled,log);
  try {
    for (const change of candidates) {
      cancelled();
      await comparison.checkpoint();
      if (!change.target || change.source.size !== change.target.size) {
        log(`${change.relative}: ${!change.target ? 'missing destination' : `size differs (${change.source.size} vs ${change.target.size} bytes)`}`);
        changes.push(change); continue;
      }
      // Equal sizes need content verification, regardless of modification time.
      log(`CRC32 verification: ${change.relative}; size=${change.source.size}; source mtime=${change.source.mtime}; target mtime=${change.target.mtime}`);
      const file = await localPath(root,change.relative);
      const expectedLocal = local.get(change.relative)!;
      const expectedRemote = remote.get(change.relative)!;
      const stableLocal = async () => {
        const current = await fs.stat(await localPath(root,change.relative));
        if (current.size !== expectedLocal.size || current.mtimeMs !== expectedLocal.mtime) throw new UserError('Local file changed during content verification. Run synchronization again.');
      };
      const cachedLocal = cache?.get('local',change.relative,expectedLocal);
      const cachedRemote = cache?.get('remote',change.relative,expectedRemote);
      if (cachedLocal !== undefined && cachedRemote !== undefined) {
        log(`Cache hit: ${change.relative}; local CRC32=${cachedLocal}; remote CRC32=${cachedRemote}`);
        if (cachedLocal !== cachedRemote) changes.push(change);
        else comparison.acknowledge(change.relative,`${expectedLocal.size}:${cachedLocal}`);
        continue;
      }
      await stableLocal();
      // Local disk hashing and a single remote transfer may run concurrently;
      // never overlap two commands on the same FTP control connection.
      const hashes = await Promise.allSettled([
        cachedLocal !== undefined ? Promise.resolve(cachedLocal) : crc32File(file,cancelled),
        comparison.hash(change.relative,expectedRemote)
      ]);
      for (const result of hashes) if (result.status === 'rejected') throw result.reason;
      const localHash = (hashes[0] as PromiseFulfilledResult<string>).value;
      const remoteHash = (hashes[1] as PromiseFulfilledResult<string>).value;
      await stableLocal();
      cancelled();
      observations.set('local',change.relative,expectedLocal,localHash);
      log(`${change.relative}: local CRC32=${localHash}; remote CRC32=${remoteHash}`);
      if (localHash !== remoteHash) { changes.push(change); log(`Content differs: ${change.relative}`); }
      else { comparison.acknowledge(change.relative,`${expectedLocal.size}:${localHash}`); log(`Already synchronized (matching size and CRC32): ${change.relative}`); }
    }
    await comparison.flush();
    await observations.checkpoint(true);
    return changes;
  } catch (error) {
    // Only fully verified batches and local hashes have reached the cache.
    try { await observations.checkpoint(true); } catch { /* Preserve the comparison failure. */ }
    throw error;
  }
}
