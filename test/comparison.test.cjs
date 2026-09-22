const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const { pipeline } = require('node:stream/promises');
const path = require('node:path');
const os = require('node:os');
const { scanTrees, buildSyncPlan } = require('../dist/sync');
const { SyncCache } = require('../dist/cache');
const { parseConfig } = require('../dist/core');

async function fixture(run) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(),'wsftp-batch-'));
  const root = path.join(base,'local');
  await fs.mkdir(path.join(root,'assets','css'),{recursive:true});
  for (let i=0;i<40;i++) await fs.writeFile(path.join(root,'assets','css',`${String(i).padStart(2,'0')}.txt`),'123456789');
  const cacheFile = path.join(base,'cache.json');
  const c = parseConfig({protocol:'ftp',host:'example',username:'user',remote_path:'/'});
  const state = {lists:0,reads:0,cancel:false,changed:false,symlink:false,afterRead:() => {}};
  const t = {
    list:async remote => {
      state.lists++;
      return Promise.all((await fs.readdir(path.join(root,remote),{withFileTypes:true})).map(async item => {
        const stat = await fs.stat(path.join(root,remote,item.name));
        return {name:item.name,directory:item.isDirectory(),symlink:state.symlink && item.name==='assets',size:stat.size,
          mtime:stat.mtimeMs+(state.changed && item.name==='00.txt' ? 10000 : 0)};
      }));
    },
    readTo:async (remote,sink) => {
      state.reads++;
      await pipeline(createReadStream(path.join(root,remote)),sink);
      state.afterRead();
    },
    download:async () => { throw new Error('Comparison must not create temporary files'); }
  };
  const check = () => { if (state.cancel) throw new Error('Cancelled'); };
  const cache = new SyncCache(cacheFile);
  const snapshot = await scanTrees(t,root,c,check);
  state.lists = 0;
  try { await run({root,c,t,state,check,cache,cacheFile,snapshot}); }
  finally { await fs.rm(base,{recursive:true,force:true}); }
}

test('40 nested files need 12 validation listings instead of 240; repeat sync reuses hashes', async () => fixture(async f => {
  assert.deepEqual(await buildSyncPlan(f.t,f.root,f.c,'local',f.snapshot,f.cache,f.check),[]);
  assert.equal(f.state.reads,40);
  assert.equal(f.state.lists,12);
  const cache = new SyncCache(f.cacheFile); await cache.load();
  f.state.lists = f.state.reads = 0;
  assert.deepEqual(await buildSyncPlan(f.t,f.root,f.c,'local',f.snapshot,cache,f.check),[]);
  assert.equal(f.state.reads,0);
  assert.equal(f.state.lists,0);
}));

test('changed files and replaced symlink parents reject the entire unverified batch', async () => {
  for (const mutation of ['changed','symlink']) await fixture(async f => {
    f.state.afterRead = () => { if (f.state.reads===3) f.state[mutation]=true; };
    await assert.rejects(buildSyncPlan(f.t,f.root,f.c,'local',f.snapshot,f.cache,f.check),/changed|symbolic link/);
    const cache = new SyncCache(f.cacheFile); await cache.load();
    const file = 'assets/css/00.txt';
    assert.equal(cache.get('remote',file,f.snapshot.remote.get(file)),undefined);
    assert.equal(cache.baseline(file),undefined);
  });
});

test('cancellation saves validated batches and resumes without downloading them again', async () => fixture(async f => {
  f.state.afterRead = () => { if (f.state.reads===35) f.state.cancel=true; };
  await assert.rejects(buildSyncPlan(f.t,f.root,f.c,'local',f.snapshot,f.cache,f.check),/Cancelled/);
  const cache = new SyncCache(f.cacheFile); await cache.load();
  assert.ok(cache.get('remote','assets/css/00.txt',f.snapshot.remote.get('assets/css/00.txt')));
  assert.equal(cache.get('remote','assets/css/34.txt',f.snapshot.remote.get('assets/css/34.txt')),undefined);
  f.state.cancel=false; f.state.afterRead=() => {}; f.state.reads=0;
  assert.deepEqual(await buildSyncPlan(f.t,f.root,f.c,'local',f.snapshot,cache,f.check),[]);
  assert.equal(f.state.reads,8);
}));

test('bidirectional different sizes need no remote hashes when a baseline or conflict decides the result', async () => fixture(async f => {
  const file='assets/css/00.txt';
  const snapshot={local:new Map([[file,f.snapshot.local.get(file)]]),remote:new Map([[file,{...f.snapshot.remote.get(file),size:20}]])};
  let actions=await buildSyncPlan(f.t,f.root,f.c,'both',snapshot,f.cache,f.check);
  assert.equal(actions[0].kind,'conflict');
  assert.equal(f.state.reads,0);
  f.cache.acknowledge(file,'9:cbf43926');
  actions=await buildSyncPlan(f.t,f.root,f.c,'both',snapshot,f.cache,f.check);
  assert.equal(actions[0].kind,'download');
  assert.equal(f.state.reads,0);
}));

test('verified progress is checkpointed during a long comparison', async () => fixture(async f => {
  const originalNow = Date.now;
  let clock = originalNow();
  Date.now = () => clock;
  let checkpointObserved = false;
  try {
    const readTo = f.t.readTo;
    f.t.readTo = async (remote,sink) => {
      await readTo(remote,sink);
      clock += 3000;
      if (f.state.reads===8) {
        const saved = new SyncCache(f.cacheFile); await saved.load();
        checkpointObserved = saved.baseline('assets/css/00.txt') === '9:cbf43926';
      }
    };
    assert.deepEqual(await buildSyncPlan(f.t,f.root,f.c,'local',f.snapshot,f.cache,f.check),[]);
    assert.equal(checkpointObserved,true);
  } finally { Date.now = originalNow; }
}));

test('empty files are verified from metadata without opening a data transfer', async () => fixture(async f => {
  const relative='assets/css/00.txt';
  await fs.writeFile(path.join(f.root,relative),'');
  const stat=await fs.stat(path.join(f.root,relative));
  const entry={size:0,mtime:stat.mtimeMs,directory:false};
  const snapshot={local:new Map([[relative,entry]]),remote:new Map([[relative,entry]])};
  assert.deepEqual(await buildSyncPlan(f.t,f.root,f.c,'local',snapshot,f.cache,f.check),[]);
  assert.equal(f.state.reads,0);
  assert.equal(f.cache.baseline(relative),'0:00000000');
}));

test('a truncated stream cannot populate remote hashes or agreements', async () => fixture(async f => {
  const { Readable } = require('node:stream');
  f.t.readTo = async (_remote,sink) => pipeline(Readable.from([Buffer.from('short')]),sink);
  await assert.rejects(buildSyncPlan(f.t,f.root,f.c,'local',f.snapshot,f.cache,f.check),/size changed/);
  const saved=new SyncCache(f.cacheFile); await saved.load();
  const relative='assets/css/00.txt';
  assert.equal(saved.get('remote',relative,f.snapshot.remote.get(relative)),undefined);
  assert.equal(saved.baseline(relative),undefined);
}));

test('streaming checksums stop on cancellation and dispose the destination', async () => {
  const { Readable } = require('node:stream');
  const { remoteCRC32 } = require('../dist/checksum');
  let sink, checks=0;
  const transport={readTo:async (_remote,destination) => {
    sink=destination;
    await pipeline(Readable.from((async function* () {
      for (let i=0;i<100;i++) yield Buffer.alloc(65536,i);
    })()),destination);
  }};
  await assert.rejects(remoteCRC32(transport,'/large',() => {
    if (++checks===3) throw new Error('Cancelled checksum');
  }),/Cancelled checksum/);
  assert.equal(sink.destroyed,true);
  assert.equal(checks,3);
});
