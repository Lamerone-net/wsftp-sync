const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { SyncCache } = require('../dist/cache');
const { parseConfig } = require('../dist/core');
const { scanTrees, buildSyncPlan, applySyncAction, validateSnapshot, rulesForMode } = require('../dist/sync');
const check = () => {};

async function fixture(run) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(),'wsftp-modes-'));
  const local = path.join(base,'local'), remote = path.join(base,'remote');
  await fs.mkdir(local); await fs.mkdir(remote);
  const c = parseConfig({protocol:'ftp',host:'localhost',username:'user',remote_path:'/'});
  const rp = p => path.join(remote,p);
  let clock = 10000;
  const put = async (root,p,content) => { const f = path.join(root,p); await fs.mkdir(path.dirname(f),{recursive:true}); await fs.writeFile(f,content); clock += 10000; await fs.utimes(f,new Date(clock),new Date(clock)); };
  const t = {
    list: async p => Promise.all((await fs.readdir(rp(p),{withFileTypes:true})).map(async e => {
      const s = await fs.lstat(path.join(rp(p),e.name));
      return {name:e.name,directory:e.isDirectory(),symlink:e.isSymbolicLink(),size:s.size,mtime:s.mtimeMs};
    })),
    upload: async (l,r) => { await fs.mkdir(path.dirname(rp(r)),{recursive:true}); await fs.copyFile(l,rp(r)); },
    download: async (r,l) => fs.copyFile(rp(r),l),
    mkdir: async r => fs.mkdir(rp(r),{recursive:true}),
    remove: async (r,d) => d ? fs.rmdir(rp(r)) : fs.unlink(rp(r))
  };
  let cache = new SyncCache(path.join(base,'cache.json'));
  const plan = async (mode,config=c) => {
    const rules = rulesForMode(config,mode);
    const snapshot = await scanTrees(t,local,rules,check);
    cache.prune(snapshot.local,snapshot.remote,rules,'');
    const actions = await buildSyncPlan(t,local,rules,mode,snapshot,cache,check);
    await cache.save();
    return {actions,snapshot,rules};
  };
  const apply = async p => {
    await validateSnapshot(t,local,p.rules,p.snapshot,check);
    for (const a of p.actions) if (a.kind === 'upload' || a.kind === 'download') cache.forget(a.relative);
    await cache.save();
    try { for (const a of p.actions) await applySyncAction(t,local,p.rules,a,p.snapshot,cache,check); }
    finally { await cache.save(); }
  };
  try { await run({local,remote,t,c,put,plan,apply,cache,reload:async () => {cache = new SyncCache(path.join(base,'cache.json')); await cache.load(); return cache;}}); }
  finally { await fs.rm(base,{recursive:true,force:true}); }
}

test('local and remote dominance mirror files and empty directories, with child-first deletion', async () => {
  for (const mode of ['local','remote']) await fixture(async f => {
    const source = mode === 'local' ? f.local : f.remote, target = mode === 'local' ? f.remote : f.local;
    await f.put(source,'new/deep/file','source');
    await fs.mkdir(path.join(source,'empty'));
    await f.put(target,'obsolete/deep/file','obsolete');
    await fs.mkdir(path.join(target,'old-empty'));
    await f.put(source,'changed','new'); await f.put(target,'changed','old');
    const p = await f.plan(mode);
    const deletion = mode === 'local' ? 'delete-remote' : 'delete-local';
    assert.ok(p.actions.some(a => a.kind === deletion && a.relative === 'obsolete'));
    assert.ok(p.actions.findIndex(a => a.relative === 'obsolete/deep/file') < p.actions.findIndex(a => a.relative === 'obsolete'));
    await f.apply(p);
    assert.equal(await fs.readFile(path.join(target,'new/deep/file'),'utf8'),'source');
    assert.equal(await fs.readFile(path.join(target,'changed'),'utf8'),'new');
    assert.ok((await fs.stat(path.join(target,'empty'))).isDirectory());
    await assert.rejects(fs.stat(path.join(target,'obsolete')),{code:'ENOENT'});
    assert.deepEqual((await f.plan(mode)).actions,[]);
  });
});

test('bidirectional history detects each changed side, conflicts and identical edits across restarts', async () => fixture(async f => {
  await f.put(f.local,'file','original'); await f.put(f.remote,'file','original');
  assert.deepEqual((await f.plan('both')).actions,[]);
  await f.reload();
  await f.put(f.local,'file','local edit');
  let p = await f.plan('both'); assert.equal(p.actions[0].kind,'upload');
  await f.reload(); assert.equal((await f.plan('both')).actions[0].kind,'upload','cancel does not acknowledge edits');
  await f.apply(p); await f.reload();
  await f.put(f.remote,'file','server edit');
  p = await f.plan('both'); assert.equal(p.actions[0].kind,'download'); await f.apply(p);
  await f.put(f.local,'file','local conflict'); await f.put(f.remote,'file','remote conflict');
  p = await f.plan('both'); assert.equal(p.actions[0].kind,'conflict'); await f.apply(p);
  assert.equal(await fs.readFile(path.join(f.local,'file'),'utf8'),'local conflict');
  assert.equal(await fs.readFile(path.join(f.remote,'file'),'utf8'),'remote conflict');
  await f.put(f.local,'file','same edit'); await f.put(f.remote,'file','same edit');
  assert.deepEqual((await f.plan('both')).actions,[]);
  const cache = await f.reload(); const baseline = cache.baseline('file'); cache.clearHashes(); await cache.save();
  assert.equal((await f.reload()).baseline('file'),baseline,'clearing hashes preserves history');
}));

test('bidirectional first differences are conflicts; one-sided files are copied and never deleted', async () => fixture(async f => {
  await f.put(f.local,'conflict','abc'); await f.put(f.remote,'conflict','xyz');
  await f.put(f.local,'local','L'); await f.put(f.remote,'remote','R');
  const p = await f.plan('both');
  assert.equal(p.actions.find(a => a.relative === 'conflict').kind,'conflict');
  assert.ok(p.actions.every(a => !a.kind.startsWith('delete-')));
  await f.apply(p);
  await fs.unlink(path.join(f.local,'remote'));
  assert.equal((await f.plan('both')).actions.find(a => a.relative === 'remote').kind,'download');
}));

test('ignored descendants protect directories; direction rules and type conflicts protect subtrees', async () => fixture(async f => {
  await f.put(f.remote,'extra/keep','keep'); await f.put(f.remote,'extra/remove','remove');
  const config = {...f.c,exclude:['extra/keep']};
  const p = await f.plan('local',config);
  assert.deepEqual(p.actions.map(a => a.relative),['extra/remove']);
  await f.apply(p); assert.equal(await fs.readFile(path.join(f.remote,'extra/keep'),'utf8'),'keep');
  await f.put(f.local,'type','file'); await f.put(f.remote,'type/child','child');
  const mismatch = await f.plan('local',config);
  assert.equal(mismatch.actions.find(a => a.relative === 'type').kind,'conflict');
  assert.ok(!mismatch.actions.some(a => a.relative === 'type/child'));
  await f.put(f.local,'no-upload','local'); await f.put(f.remote,'no-download','remote');
  const both = await f.plan('both',{...config,ignore_upload:['no-upload'],ignore_download:['no-download']});
  assert.ok(!both.actions.some(a => a.relative === 'no-upload' || a.relative === 'no-download'));
}));

test('preview revalidation blocks changed files and new directory children before deletion', async () => fixture(async f => {
  await f.put(f.remote,'obsolete/file','old');
  let p = await f.plan('local');
  await f.put(f.local,'obsolete/file','new source');
  await assert.rejects(f.apply(p),/changed after preview/);
  assert.equal(await fs.readFile(path.join(f.remote,'obsolete/file'),'utf8'),'old');
  await fs.mkdir(path.join(f.remote,'empty'));
  p = await f.plan('local');
  const action = p.actions.find(a => a.relative === 'empty');
  await f.put(f.remote,'empty/new-child','preserve');
  await assert.rejects(applySyncAction(f.t,f.local,p.rules,action,p.snapshot,f.cache,check),/no longer empty/);
  assert.equal(await fs.readFile(path.join(f.remote,'empty/new-child'),'utf8'),'preserve');
}));

test('failed upload drops old agreement and does not turn partial remote content into an automatic download', async () => fixture(async f => {
  await f.put(f.local,'file','original'); await f.put(f.remote,'file','original');
  await f.plan('both'); await f.put(f.local,'file','updated');
  const p = await f.plan('both');
  f.t.upload = async () => { await f.put(f.remote,'file','partial'); throw new Error('connection lost'); };
  await assert.rejects(f.apply(p),/connection lost/);
  await f.reload();
  assert.equal((await f.plan('both')).actions[0].kind,'conflict');
}));
