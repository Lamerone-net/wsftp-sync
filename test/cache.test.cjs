const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { SyncCache } = require('../dist/cache');
const { planSync, scanLocal } = require('../dist/files');
const { parseConfig } = require('../dist/core');
const config = parseConfig({protocol:'sftp',host:'example',username:'user',remote_path:'/www'});

test('persistent cache avoids unchanged downloads and retains cancelled differences', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'wsftp-cache-test-'));
  try {
    const localFile = path.join(root,'file.txt');
    const cacheFile = path.join(root,'cache.json');
    await fs.writeFile(localFile,'original');
    let content = 'original', downloads = 0;
    const entry = {name:'file.txt',size:8,mtime:10000,directory:false,symlink:false};
    const remote = new Map([['file.txt',entry]]);
    const t = {list:async () => [entry],download:async (_,dest) => { downloads++; await fs.writeFile(dest,content); }};
    let cache = new SyncCache(cacheFile);
    const run = async () => {
      const local = await scanLocal(root,config,() => {});
      local.delete('cache.json');
      return planSync(t,config,root,local,remote,'upload',() => {},() => {},cache);
    };
    assert.deepEqual(await run(),[]);
    assert.equal(downloads,1);
    await cache.save();
    cache = new SyncCache(cacheFile);
    await cache.load();
    assert.deepEqual(await run(),[]);
    assert.equal(downloads,1);
    await fs.writeFile(localFile,'modified');
    await fs.utimes(localFile,new Date(20000),new Date(20000));
    assert.equal((await run()).length,1);
    assert.equal(downloads,1,'local changes reuse remote CRC32');
    await cache.save();
    cache = new SyncCache(cacheFile); await cache.load();
    assert.equal((await run()).length,1,'cancelled preview remains pending');
    content = 'modified'; entry.mtime++;
    assert.deepEqual(await run(),[]);
    assert.equal(downloads,2);
    cache.invalidate('file.txt');
    assert.deepEqual(await run(),[]);
    assert.equal(downloads,3);
    entry.mtime = 0;
    await run(); await run();
    assert.equal(downloads,5,'unknown timestamps never reuse remote hashes');
    cache = new SyncCache(cacheFile);
    await fs.writeFile(cacheFile,'broken'); await cache.load();
    assert.deepEqual(await run(),[]);
    assert.equal(downloads,6);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});

test('cache pruning respects scope, exclusions and server identity', () => {
  const cache = new SyncCache();
  const entry = {size:1,mtime:100};
  for (const side of ['local','remote']) {
    for (const file of ['sub/missing','other/keep','ignored/file']) cache.set(side,file,entry,'12345678');
  }
  cache.prune(new Map(),new Map(),{...config,exclude:['ignored/**']},'sub');
  for (const side of ['local','remote']) {
    assert.equal(cache.get(side,'sub/missing',entry),undefined);
    assert.equal(cache.get(side,'ignored/file',entry),undefined);
    assert.equal(cache.get(side,'other/keep',entry),'12345678');
    assert.equal(cache.get(side,'other/keep',{...entry,size:2}),undefined);
  }
  const filename = SyncCache.filename('/storage','/root',config);
  for (const patch of [{host:'other'},{username:'other'},{port:123},{protocol:'ftp'},{remote_path:'/other'}]) {
    assert.notEqual(SyncCache.filename('/storage','/root',{...config,...patch}),filename);
  }
  assert.notEqual(SyncCache.filename('/storage','/other',config),filename);
});
