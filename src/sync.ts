import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Config, Entry, excluded, forDirection, remoteFile, safeRelative, UserError } from './core';
import { Transport, inspectRemote } from './transport';
import { SyncCache } from './cache';
import { localPath, crc32File, download } from './files';

export type SyncMode = 'local' | 'remote' | 'both';
export interface TreeEntry extends Entry { directory: boolean; blocked?: boolean }
export type Tree = Map<string, TreeEntry>;
export interface SyncAction {
  relative: string;
  kind: 'upload' | 'download' | 'mkdir-local' | 'mkdir-remote' | 'delete-local' | 'delete-remote' | 'conflict';
  directory: boolean;
  fingerprint?: string;
  note?: string;
}
export interface Snapshot { local: Tree; remote: Tree }

export function rulesForMode(c: Config, mode: SyncMode): Config {
  return mode === 'both' ? c : forDirection(c,mode === 'local' ? 'upload' : 'download');
}

// Blocked entries remain visible only as protection markers, never as actions.
export async function scanTrees(t: Transport, root: string, c: Config, check: () => void): Promise<Snapshot> {
  const local: Tree = new Map(), remote: Tree = new Map();
  async function walkLocal(dir: string, prefix: string): Promise<void> {
    check();
    for (const e of await fs.readdir(dir,{withFileTypes:true})) {
      check();
      const relative = prefix+e.name;
      const blocked = excluded(relative,c.exclude,c.legacyIgnore) || e.isSymbolicLink() || (!e.isFile() && !e.isDirectory());
      if (blocked) { local.set(relative,{directory:e.isDirectory(),size:0,mtime:0,blocked:true}); continue; }
      safeRelative(relative);
      const stat = await fs.lstat(path.join(dir,e.name));
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) { local.set(relative,{directory:false,size:0,mtime:0,blocked:true}); continue; }
      local.set(relative,{directory:stat.isDirectory(),size:stat.size,mtime:stat.mtimeMs});
      if (stat.isDirectory()) await walkLocal(path.join(dir,e.name),relative+'/');
    }
  }
  async function walkRemote(dir: string, prefix: string, depth: number): Promise<void> {
    check();
    if (depth > 64) throw new UserError('Remote directory tree is too deep.');
    for (const e of await t.list(dir)) {
      check();
      if (e.name === '.' || e.name === '..') continue;
      safeRelative(e.name);
      if (e.name.includes('/')) throw new UserError('Invalid remote name.');
      const relative = prefix+e.name;
      const blocked = excluded(relative,c.exclude,c.legacyIgnore) || e.symlink;
      remote.set(relative,{directory:e.directory,size:e.size,mtime:e.mtime,blocked});
      if (e.directory && !blocked) await walkRemote(remoteFile(c,relative),relative+'/',depth+1);
    }
  }
  await walkLocal(root,'');
  await walkRemote(c.remote_path,'',0);
  return {local,remote};
}

function same(a: TreeEntry | undefined, b: TreeEntry | undefined): boolean {
  return !a || !b ? a === b : a.directory === b.directory && Boolean(a.blocked) === Boolean(b.blocked) && (a.directory || (a.size === b.size && a.mtime === b.mtime));
}

async function currentLocal(root: string, relative: string): Promise<TreeEntry | undefined> {
  try {
    const s = await fs.lstat(await localPath(root,relative));
    if (!s.isFile() && !s.isDirectory()) throw new UserError('Incompatible local path.');
    return {directory:s.isDirectory(),size:s.size,mtime:s.mtimeMs};
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

async function currentRemote(t: Transport, c: Config, relative: string): Promise<TreeEntry | undefined> {
  return inspectRemote(t,c,relative,true);
}

export async function fingerprint(t: Transport, root: string, c: Config, side: 'local' | 'remote', relative: string, entry: TreeEntry, cache: SyncCache, check: () => void): Promise<string> {
  const hash = cache.get(side,relative,entry);
  if (hash !== undefined) return `${entry.size}:${hash}`;
  const validate = async () => {
    const now = side === 'local' ? await currentLocal(root,relative) : await currentRemote(t,c,relative);
    if (!same(entry,now)) throw new UserError('File changed during content verification. Run synchronization again.');
  };
  await validate();
  let temporary: string | undefined;
  try {
    let file = await localPath(root,relative);
    if (side === 'remote') {
      temporary = await fs.mkdtemp(path.join(os.tmpdir(),'wsftp-hash-'));
      file = path.join(temporary,'content');
      await t.download(remoteFile(c,relative),file);
    }
    const crc = await crc32File(file,check);
    await validate(); check();
    cache.set(side,relative,entry,crc);
    return `${entry.size}:${crc}`;
  } finally { if (temporary) await fs.rm(temporary,{recursive:true,force:true}); }
}

export async function buildSyncPlan(t: Transport, root: string, c: Config, mode: SyncMode, snapshot: Snapshot, cache: SyncCache, check: () => void): Promise<SyncAction[]> {
  const {local,remote} = snapshot;
  const actions: SyncAction[] = [];
  const blocked = new Set<string>();
  const paths = [...new Set([...local.keys(),...remote.keys()])].sort();
  const underBlocked = (relative: string) => {
    const parts = relative.split('/');
    return parts.some((_,i) => blocked.has(parts.slice(0,i+1).join('/')));
  };
  for (const relative of paths) {
    check();
    const l = local.get(relative), r = remote.get(relative);
    if (l?.blocked || r?.blocked) { blocked.add(relative); continue; }
    if (underBlocked(relative)) continue;
    if (l && r && l.directory !== r.directory) {
      actions.push({relative,kind:'conflict',directory:false,note:'File/directory mismatch; resolve manually.'});
      blocked.add(relative); continue;
    }
    const directory = (l ?? r)!.directory;
    const allow = (direction: 'upload' | 'download') => {
      const rules = forDirection(c,direction);
      return !excluded(relative,rules.exclude,rules.legacyIgnore);
    };
    if (!l || !r) {
      let kind: SyncAction['kind'];
      if (mode === 'local') kind = l ? (directory ? 'mkdir-remote' : 'upload') : 'delete-remote';
      else if (mode === 'remote') kind = r ? (directory ? 'mkdir-local' : 'download') : 'delete-local';
      else kind = l ? (directory ? 'mkdir-remote' : 'upload') : (directory ? 'mkdir-local' : 'download');
      const direction = kind === 'upload' || kind === 'mkdir-remote' || kind === 'delete-remote' ? 'upload' : 'download';
      if (allow(direction)) actions.push({relative,kind,directory});
      else blocked.add(relative);
      continue;
    }
    if (directory) continue;
    if (mode === 'both' && !allow('upload') && !allow('download')) continue;
    // Dominance can decide different-size files without downloading for comparison.
    if (mode !== 'both' && l.size !== r.size) {
      actions.push({relative,kind:mode === 'local' ? 'upload' : 'download',directory:false}); continue;
    }
    const lh = await fingerprint(t,root,c,'local',relative,l,cache,check);
    const rh = await fingerprint(t,root,c,'remote',relative,r,cache,check);
    if (lh === rh) { cache.acknowledge(relative,lh); continue; }
    if (mode !== 'both') {
      actions.push({relative,kind:mode === 'local' ? 'upload' : 'download',directory:false,fingerprint:mode === 'local' ? lh : rh}); continue;
    }
    const baseline = cache.baseline(relative);
    const kind = baseline === rh ? 'upload' : baseline === lh ? 'download' : 'conflict';
    if (kind === 'conflict' || allow(kind)) actions.push({relative,kind,directory:false,fingerprint:kind === 'upload' ? lh : kind === 'download' ? rh : undefined,note:baseline ? 'Both sides changed.' : 'No shared synchronization baseline.'});
  }
  // Never delete an ancestor of ignored content or a conflict. Directories are
  // removed non-recursively, after their individually reviewed child actions.
  const protectedParents = new Set<string>();
  for (const relative of blocked) {
    const parts = relative.split('/');
    for (let i = 1; i < parts.length; i++) protectedParents.add(parts.slice(0,i).join('/'));
  }
  return actions.filter(a => !a.kind.startsWith('delete-') || !a.directory || !protectedParents.has(a.relative)).sort((a,b) => {
    const group = (a: SyncAction) => a.kind.startsWith('mkdir-') ? 0 : a.kind.startsWith('delete-') ? (a.directory ? 3 : 2) : 1;
    return group(a)-group(b) || (group(a) === 3 ? b.relative.split('/').length-a.relative.split('/').length : a.relative.split('/').length-b.relative.split('/').length) || a.relative.localeCompare(b.relative);
  });
}

export async function validateSnapshot(t: Transport, root: string, c: Config, snapshot: Snapshot, check: () => void): Promise<void> {
  const now = await scanTrees(t,root,c,check);
  for (const side of ['local','remote'] as const) {
    if (snapshot[side].size !== now[side].size || [...snapshot[side]].some(([p,e]) => !same(e,now[side].get(p)))) throw new UserError('Files changed after preview. Run synchronization again.');
  }
}

export async function applySyncAction(t: Transport, root: string, c: Config, action: SyncAction, snapshot: Snapshot, cache: SyncCache, check: () => void): Promise<void> {
  check();
  const {relative,kind,directory} = action;
  if (kind === 'conflict') return;
  const local = await currentLocal(root,relative), remote = await currentRemote(t,c,relative);
  if (!same(snapshot.local.get(relative),local) || !same(snapshot.remote.get(relative),remote)) throw new UserError('File changed after preview. Run synchronization again.');
  const file = await localPath(root,relative), remote_path = remoteFile(c,relative);
  if (kind === 'delete-local' || kind === 'delete-remote') {
    if (directory) {
      const contents = kind === 'delete-local' ? await fs.readdir(file) : (await t.list(remote_path)).filter(e => e.name !== '.' && e.name !== '..');
      if (contents.length) throw new UserError('Directory is no longer empty; deletion stopped. Run synchronization again.');
    }
    if (kind === 'delete-local') { if (directory) await fs.rmdir(file); else await fs.unlink(file); snapshot.local.delete(relative); }
    else { await t.remove(remote_path,directory); snapshot.remote.delete(relative); }
    cache.forget(relative);
  } else if (kind === 'mkdir-local' || kind === 'mkdir-remote') {
    if (kind === 'mkdir-local') { await fs.mkdir(file,{recursive:true}); snapshot.local.set(relative,(await currentLocal(root,relative))!); }
    else { await t.mkdir(remote_path); snapshot.remote.set(relative,(await currentRemote(t,c,relative))!); }
  } else {
    const sourceSide = kind === 'upload' ? 'local' : 'remote';
    const source = sourceSide === 'local' ? local! : remote!;
    const hash = action.fingerprint ?? await fingerprint(t,root,c,sourceSide,relative,source,cache,check);
    // The caller persists invalidation for the entire batch before applying it.
    cache.forget(relative);
    if (kind === 'upload') await t.upload(file,remote_path);
    else await download(t,c,root,relative,remote!.mtime);
    const afterLocal = await currentLocal(root,relative), afterRemote = await currentRemote(t,c,relative);
    const afterSource = sourceSide === 'local' ? afterLocal : afterRemote;
    if (!same(source,afterSource) || !afterLocal || !afterRemote || afterLocal.size !== afterRemote.size) throw new UserError('File changed during transfer. Run synchronization again.');
    cache.acknowledge(relative,hash);
    cache.set('local',relative,afterLocal,hash.split(':')[1]);
    cache.set('remote',relative,afterRemote,hash.split(':')[1]);
    snapshot.local.set(relative,afterLocal); snapshot.remote.set(relative,afterRemote);
  }
}
