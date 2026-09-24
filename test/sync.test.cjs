const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { SyncCache } = require('../dist/cache');
const { parseConfig } = require('../dist/core');
const { scanTrees, buildSyncPlan, applySyncAction, validateSnapshot, rulesForMode } = require('../dist/sync');
const check = () => {};

test('directory download matches filesystem aliases without losing preview change protection', async t => fixture(async f => {
  const { scanLocal, scanRemote, planSync } = require('../dist/files');
  const localName = 'books/Coboldo Melo [en_us]_lit_celo.jpg';
  const remoteName = 'books/Coboldo Melo [en_US]_lit_celo.jpg';
  await f.put(f.local,localName,'old');
  try { await fs.stat(path.join(f.local,remoteName)); }
  catch { t.skip('Requires a case-insensitive filesystem'); return; }
  await f.put(f.remote,remoteName,'downloaded content');
  const local = await scanLocal(f.local,f.c,check,'books');
  const remote = await scanRemote(f.t,f.c,check,'books');
  const changes = await planSync(f.t,f.c,f.local,local,remote,'download',check,undefined,f.cache);
  assert.equal(changes.length,1);
  assert.equal(changes[0].reason,'changed');
  const snapshot = {
    local:new Map([...local].map(([name,entry]) => [name,{...entry,directory:false}])),
    remote:new Map([...remote].map(([name,entry]) => [name,{...entry,directory:false}]))
  };
  const action = {relative:remoteName,kind:'download',directory:false};
  await applySyncAction(f.t,f.local,f.c,action,snapshot,f.cache,check);
  assert.equal(await fs.readFile(path.join(f.local,localName),'utf8'),'downloaded content');
  await f.put(f.local,localName,'real edit after preview');
  await assert.rejects(applySyncAction(f.t,f.local,f.c,action,snapshot,f.cache,check),/Local file changed after preview/);
}));

test('tree synchronization matches local aliases and rejects ambiguous remote names', async t => fixture(async f => {
  await f.put(f.local,'Books/cover.jpg','old');
  try { await fs.stat(path.join(f.local,'books/COVER.jpg')); }
  catch { t.skip('Requires a case-insensitive filesystem'); return; }
  await f.put(f.remote,'books/COVER.jpg','new remote content');
  const p = await f.plan('remote');
  assert.deepEqual(p.actions.map(a => [a.kind,a.relative]),[['download','books/COVER.jpg']]);
  await f.apply(p);
  const { alignLocalNames } = require('../dist/files');
  const entry = {size:1,mtime:1};
  await assert.rejects(alignLocalNames(f.local,new Map([['Books/COVER.jpg',entry]]),new Map([['Books/COVER.jpg',entry],['books/cover.jpg',entry]]),check),/same local path/);
}));

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
    for (const a of p.actions) await applySyncAction(t,local,p.rules,a,p.snapshot,cache,check);
  };
  try { await run({local,remote,t,c,put,plan,apply,cache,cacheFile:path.join(base,'cache.json'),reload:async () => {cache = new SyncCache(path.join(base,'cache.json')); await cache.load(); return cache;}}); }
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
  await assert.rejects(f.apply(p),/Local path changed after preview: obsolete/);
  assert.equal(await fs.readFile(path.join(f.remote,'obsolete/file'),'utf8'),'old');
  await fs.mkdir(path.join(f.remote,'empty'));
  p = await f.plan('local');
  const action = p.actions.find(a => a.relative === 'empty');
  await f.put(f.remote,'empty/new-child','preserve');
  await assert.rejects(applySyncAction(f.t,f.local,p.rules,action,p.snapshot,f.cache,check),/no longer empty: empty/);
  assert.equal(await fs.readFile(path.join(f.remote,'empty/new-child'),'utf8'),'preserve');
}));

test('content verification errors identify the side and relative file path', async () => fixture(async f => {
  const { fingerprint } = require('../dist/sync');
  const relative='assets/changed.txt';
  await f.put(f.local,relative,'before'); await f.put(f.remote,relative,'before');
  const snapshot=await scanTrees(f.t,f.local,f.c,check);
  await f.put(f.remote,relative,'after remote');
  await assert.rejects(fingerprint(f.t,f.local,f.c,'remote',relative,snapshot.remote.get(relative),f.cache,check),/Remote file changed during content verification: assets\/changed\.txt/);
  await f.put(f.local,relative,'after local');
  await assert.rejects(fingerprint(f.t,f.local,f.c,'local',relative,snapshot.local.get(relative),f.cache,check),/Local file changed during content verification: assets\/changed\.txt/);
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

test('each completed upload and download is durable before cancellation or the next file', async () => {
  for (const direction of ['upload','download']) await fixture(async f => {
    for (const name of ['a','b','untouched']) {
      await f.put(f.local,name,'original'); await f.put(f.remote,name,'original');
    }
    await f.plan('both');
    const previous=f.cache.baseline('b');
    const source=direction==='upload' ? f.local : f.remote;
    await f.put(source,'a','updated a content'); await f.put(source,'b','updated b content');
    const mode=direction==='upload' ? 'local' : 'remote';
    const p=await f.plan(mode);
    let cancelled=false, transfers=0;
    const transfer=f.t[direction];
    f.t[direction]=async (...args) => { await transfer(...args); transfers++; cancelled=true; };
    const cancel=() => { if (cancelled) throw new Error('Cancelled'); };
    await applySyncAction(f.t,f.local,p.rules,p.actions[0],p.snapshot,f.cache,cancel);
    const persisted=new SyncCache(f.cacheFile); await persisted.load();
    assert.ok(persisted.get('local','a',p.snapshot.local.get('a')));
    assert.equal(persisted.get('local','a',p.snapshot.local.get('a')),persisted.get('remote','a',p.snapshot.remote.get('a')));
    assert.notEqual(persisted.baseline('a'),previous);
    assert.equal(persisted.baseline('b'),previous,'Untouched pending files retain history');
    await assert.rejects(applySyncAction(f.t,f.local,p.rules,p.actions[1],p.snapshot,f.cache,cancel),/Cancelled/);
    await f.reload();
    assert.deepEqual((await f.plan(mode)).actions.map(a => a.relative),['b']);
    assert.equal(transfers,1,'Completed downloads are not fetched again to establish their hash');
  });
});

test('a failed second upload leaves the first transfer saved and the failed one unacknowledged', async () => fixture(async f => {
  for (const name of ['a','b']) { await f.put(f.local,name,'original'); await f.put(f.remote,name,'original'); }
  await f.plan('both');
  for (const name of ['a','b']) await f.put(f.local,name,'updated content');
  const p=await f.plan('local');
  await applySyncAction(f.t,f.local,p.rules,p.actions[0],p.snapshot,f.cache,check);
  f.t.upload=async (_local,remote) => { await f.put(f.remote,remote,'partial'); throw new Error('connection lost'); };
  await assert.rejects(applySyncAction(f.t,f.local,p.rules,p.actions[1],p.snapshot,f.cache,check),/connection lost/);
  const saved=new SyncCache(f.cacheFile); await saved.load();
  assert.ok(saved.baseline('a'));
  assert.equal(saved.baseline('b'),undefined);
  assert.equal(saved.get('local','b',p.snapshot.local.get('b')),undefined);
  assert.equal(saved.get('remote','b',p.snapshot.remote.get('b')),undefined);
}));

test('cache persistence failures stop a transfer before writing any remote content', async () => fixture(async f => {
  await f.put(f.local,'file','new content');
  const p=await f.plan('local');
  f.cache.save=async () => { throw new Error('Disk full'); };
  let uploaded=false;
  f.t.upload=async () => { uploaded=true; };
  await assert.rejects(applySyncAction(f.t,f.local,p.rules,p.actions[0],p.snapshot,f.cache,check),/Cannot save transfer cache for file/);
  assert.equal(uploaded,false);
}));
