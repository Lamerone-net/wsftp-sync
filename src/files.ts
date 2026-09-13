import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import os from 'node:os';
import { Config, Entry, Change, UserError, excluded, remoteFile, safeRelative } from './core';
import { Transport, inspectRemote } from './transport';

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
  let start = c.remotePath;
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

// CRC-32/ISO-HDLC, processed incrementally to keep memory usage bounded.
const crcTable = Uint32Array.from({length:256}, (_,index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});
export async function crc32File(file: string, cancelled: () => void): Promise<string> {
  let crc = 0xffffffff;
  for await (const chunk of createReadStream(file)) {
    cancelled();
    for (const byte of chunk as Buffer) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  }
  cancelled();
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8,'0');
}

export async function planSync(t: Transport, c: Config, root: string, local: Map<string, Entry>, remote: Map<string, Entry>, direction: 'upload' | 'download', cancelled: () => void, log: (message: string) => void = () => {}): Promise<Change[]> {
  const source = direction === 'upload' ? local : remote;
  const target = direction === 'upload' ? remote : local;
  const candidates: Change[] = [...source].map(([relative,entry]) => ({relative,source:entry,target:target.get(relative),reason:target.has(relative) ? 'changed' : 'new'}));
  candidates.sort((a,b) => a.relative.localeCompare(b.relative));
  const changes: Change[] = [];
  for (const change of candidates) {
    cancelled();
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
    const stableRemote = async () => {
      const current = await inspectRemote(t,c,change.relative);
      if (!current || current.size !== expectedRemote.size || current.mtime !== expectedRemote.mtime) throw new UserError('Remote file changed during content verification. Run synchronization again.');
    };
    await stableLocal();
    await stableRemote();
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(),'wsftp-compare-'));
    try {
      const copy = path.join(temporary,'remote');
      await t.download(remoteFile(c,change.relative),copy);
      cancelled();
      const localHash = await crc32File(file,cancelled);
      const remoteHash = await crc32File(copy,cancelled);
      await stableLocal();
      await stableRemote();
      cancelled();
      log(`${change.relative}: local CRC32=${localHash}; remote CRC32=${remoteHash}`);
      if (localHash !== remoteHash) { changes.push(change); log(`Content differs: ${change.relative}`); }
      else log(`Already synchronized (matching size and CRC32): ${change.relative}`);
    } finally { await fs.rm(temporary,{recursive:true,force:true}); }
  }
  return changes;
}
