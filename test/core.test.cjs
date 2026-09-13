const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { parseConfig, safeRelative, remoteFile, excluded, plan } = require('../dist/core');
const { scanLocal, scanRemote, download, planSync, crc32File } = require('../dist/files');
const { inspectRemote } = require('../dist/transport');
const base = { protocol: 'sftp', host: 'localhost', username: 'test', remotePath: '/www' };

test('directory remote scan preserves relative paths and never scans sibling directories', async () => {
  const c = parseConfig(base);
  const visited = [];
  const t = {list:async dir => {
    visited.push(dir);
    if (dir === '/www') return [{name:'sub',directory:true},{name:'other',directory:true}];
    if (dir === '/www/sub') return [{name:'nested.txt',directory:false,size:4,mtime:100}];
    throw new Error('Unexpected scan outside selected directory');
  }};
  assert.deepEqual([...(await scanRemote(t,c,() => {},'sub')).keys()],['sub/nested.txt']);
  assert.deepEqual(visited,['/www','/www/sub']);
  assert.equal((await scanRemote(t,c,() => {},'missing')).size,0);
  await assert.rejects(scanRemote({list:async () => [{name:'sub',directory:true,symlink:true}]},c,() => {},'sub'));
  await assert.rejects(scanRemote(t,c,() => {},'../outside'));
});
test('configuration defaults, protocols and strict validation', () => {
  assert.equal(parseConfig(base).port, 22);
  assert.equal(parseConfig({...base,protocol:'ftps'}).port,21);
  assert.equal(parseConfig(base).uploadOnSave,false);
  for (const patch of [{password:123},{port:0},{port:22.5},{timeout:0},{uploadOnSave:'yes'},{exclude:[1]},{remotePath:'/www/../etc'},{protocol:'http'},{host:'x\r\nUSER root'},{hostKeySha256:'wrong'}]) assert.throws(() => parseConfig({...base,...patch}));
});
test('path traversal, Windows special names and control characters are rejected', () => {
  for (const value of ['../x','/etc/passwd','a/../b','C:/x','a\\b','a//b','a\nfile','a:stream','a/NUL.txt','a/trailing.']) assert.throws(() => safeRelative(value));
  assert.equal(remoteFile(parseConfig(base),'assets/main.css'),'/www/assets/main.css');
});
test('only configured exclusions prune paths; empty filters include sensitive and hidden files', () => {
  const paths = ['.git/config','.vscode/wsftp-sync.json','node_modules/a/index.js','sub/.env.production','sub/key.pem','.ssh/id_rsa','wsftp-sync.json','.wsftp-example.tmp'];
  for (const config of [base,{...base,ignore_always:[],ignore_upload:[],ignore_download:[]}]) {
    const c = parseConfig(config);
    assert.deepEqual(c.exclude,[]);
    for (const file of paths) assert.equal(excluded(file,c.exclude),false,file);
  }
  const c = parseConfig({...base,ignore_always:['cache/**']});
  for (const file of ['cache','cache/x']) assert.equal(excluded(file,c.exclude),true);
  for (const file of paths) assert.equal(excluded(file,c.exclude),false);
});

test('sync plan detects new and changed files without deleting target-only files', () => {
  const source = new Map([['same',{size:1,mtime:4000}],['new',{size:2,mtime:0}],['changed',{size:3,mtime:2000}]]);
  const target = new Map([['same',{size:1,mtime:95000}],['changed',{size:4,mtime:2000}],['target-only',{size:1,mtime:0}]]);
  assert.deepEqual(plan(source,target).map(x => [x.relative,x.reason]),[['changed','changed'],['new','new']]);
});
test('remote inspection refuses symlink parents and detects new target files', async () => {
  const c = parseConfig(base);
  await assert.rejects(inspectRemote({list:async () => [{name:'link',directory:true,symlink:true}]},c,'link/file.txt'));
  assert.equal(await inspectRemote({list:async () => []},c,'new/file.txt'),undefined);
  assert.equal((await inspectRemote({list:async () => [{name:'file.txt',directory:false,symlink:false,size:3,mtime:1}]},c,'file.txt')).size,3);
});
test('recursive scans and atomic download preserve destination on failed transfer', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'wsftp-test-'));
  try {
    await fs.mkdir(path.join(root,'sub'));
    await fs.writeFile(path.join(root,'sub','file.txt'),'old');
    await fs.writeFile(path.join(root,'.env'),'secret');
    const c = parseConfig(base);
    assert.deepEqual([...(await scanLocal(root,c,() => {})).keys()],['.env','sub/file.txt']);
    const t = {
      list: async p => p === '/www' ? [{name:'sub',directory:true,symlink:false,size:0,mtime:0},{name:'link',directory:false,symlink:true,size:0,mtime:0}] : [{name:'file.txt',directory:false,symlink:false,size:3,mtime:10000}],
      download: async (_,destination) => { await fs.writeFile(destination,'partial'); throw new Error('connection lost'); }
    };
    assert.deepEqual([...(await scanRemote(t,c,() => {})).keys()],['sub/file.txt']);
    await assert.rejects(download(t,c,root,'sub/file.txt'));
    assert.equal(await fs.readFile(path.join(root,'sub','file.txt'),'utf8'),'old');
    assert.deepEqual(await fs.readdir(path.join(root,'sub')),['file.txt']);
    t.download = async (_,destination) => { await fs.writeFile(destination,'new'); };
    await download(t,c,root,'sub/file.txt',10000);
    assert.equal(await fs.readFile(path.join(root,'sub','file.txt'),'utf8'),'new');
    assert.equal((await fs.stat(path.join(root,'sub','file.txt'))).mtimeMs,10000);
    await assert.rejects(scanRemote({list: async () => [{name:'../escape',directory:false}]},c,() => {}));
    await assert.rejects(scanLocal(root,c,() => {throw new Error('cancel');}),/cancel/);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});

test('sync compares equal-size content regardless of timestamps in both directions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'wsftp-content-test-'));
  let temporary;
  try {
    const file = path.join(root,'file.txt');
    await fs.writeFile(file,'original');
    await fs.utimes(file,new Date(10000),new Date(10000));
    const c = parseConfig(base);
    let contents = 'original';
    const remoteEntry = {name:'file.txt',size:8,mtime:90000,directory:false,symlink:false};
    const remote = new Map([['file.txt',remoteEntry]]);
    const t = {
      list: async () => [remoteEntry],
      download: async (_,destination) => { temporary = destination; await fs.writeFile(destination,contents); }
    };
    const local = await scanLocal(root,c,() => {});
    for (const remoteTime of [10000,90000,10001,9999]) {
      remoteEntry.mtime = remoteTime;
      for (const direction of ['upload','download']) {
        assert.deepEqual(await planSync(t,c,root,local,remote,direction,() => {}),[]);
        assert.deepEqual(await planSync(t,c,root,local,remote,direction,() => {}),[]);
        await assert.rejects(fs.stat(path.dirname(temporary)),{code:'ENOENT'});
        contents = 'modified';
        assert.deepEqual((await planSync(t,c,root,local,remote,direction,() => {})).map(x => x.relative),['file.txt']);
        contents = 'original';
      }
    }
    assert.equal(await fs.readFile(file,'utf8'),'original');
    assert.equal((await fs.stat(file)).mtimeMs,10000);
    t.download = async (_,destination) => { temporary = destination; await fs.writeFile(destination,'partial'); throw new Error('connection lost'); };
    await assert.rejects(planSync(t,c,root,local,remote,'upload',() => {}),/connection lost/);
    await assert.rejects(fs.stat(path.dirname(temporary)),{code:'ENOENT'});
    t.download = async (_,destination) => { temporary = destination; await fs.writeFile(destination,contents); await fs.writeFile(file,'changed locally'); };
    await assert.rejects(planSync(t,c,root,local,remote,'upload',() => {}),/Local file changed/);
    await assert.rejects(fs.stat(path.dirname(temporary)),{code:'ENOENT'});
    await assert.rejects(planSync(t,c,root,local,remote,'upload',() => {throw new Error('cancelled');}),/cancelled/);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});

test('sync skips all content I/O when destination is missing or size differs', async () => {
  const c = parseConfig(base);
  const t = {
    list: async () => { throw new Error('Unexpected remote listing'); },
    download: async () => { throw new Error('Unexpected content download'); }
  };
  const local = new Map([['file.txt',{size:8,mtime:10000}]]);
  for (const entry of [undefined,{size:9,mtime:10000},{size:9,mtime:10001}]) {
    const target = new Map(entry ? [['file.txt',entry]] : []);
    for (const direction of ['upload','download']) {
      const changes = await planSync(t,c,path.join(os.tmpdir(),'nonexistent', 'root'),
        direction === 'upload' ? local : target,
        direction === 'upload' ? target : local,direction,() => {});
      assert.deepEqual(changes.map(x => [x.relative,x.reason]),[['file.txt',entry ? 'changed' : 'new']]);
    }
  }
});

test('streaming CRC32 matches standard vectors including multi-chunk input', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'wsftp-crc-test-'));
  try {
    const file = path.join(root,'vector');
    for (const [content,expected] of [['','00000000'],['123456789','cbf43926'],['a'.repeat(1000000),'dc25bfbc']]) {
      await fs.writeFile(file,content);
      assert.equal(await crc32File(file,() => {}),expected);
    }
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});
