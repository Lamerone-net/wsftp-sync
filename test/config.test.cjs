const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { readConfig, findConfig, parseConnectionConfig } = require('../dist/config');
const { UserError, excluded } = require('../dist/core');
const base = { protocol: 'ftp', host: 'localhost', username: 'test', password: 'test', remote_path: '/' };

test('direction exclusions are additive, prune descendants and do not affect the opposite direction', () => {
  const { forDirection } = require('../dist/core');
  const c = parseConnectionConfig({...base,ignore_always:['shared'],ignore_upload:['uploads/', 'config/local.php'],ignore_download:['assets', '**/*.log']});
  const blocked = (file,direction) => {
    const rules = forDirection(c,direction);
    return excluded(file,rules.exclude,rules.legacyIgnore);
  };
  for (const file of ['uploads/a/b.txt','config/local.php']) {
    assert.equal(blocked(file,'upload'),true);
    assert.equal(blocked(file,'download'),false);
  }
  for (const file of ['assets/a/b.txt','nested/server.log']) {
    assert.equal(blocked(file,'download'),true);
    assert.equal(blocked(file,'upload'),false);
  }
  assert.equal(blocked('uploads-other/file.txt','upload'),false);
  for (const direction of ['upload','download']) {
    assert.equal(blocked('shared/file.txt',direction),true);
    assert.equal(blocked('.vscode/ftp-sync.json',direction),false);
  }
  for (const field of ['ignore_upload','ignore_download']) {
    for (const value of [null,'file',[3],[''],['!file']]) assert.throws(() => parseConnectionConfig({...base,[field]:value}),new RegExp(field));
    assert.doesNotThrow(() => parseConnectionConfig({...base,[field]:[]}));
  }
});

test('only example configuration options are accepted', async () => {
  const { configFields } = require('../dist/core');
  const example = {...JSON.parse(await fs.readFile(path.join(__dirname,'../wsftp-sync.json'),'utf8')),username:'test',host:'localhost',password:'test'};
  const schema = JSON.parse(await fs.readFile(path.join(__dirname,'../schemas/config.schema.json'),'utf8'));
  assert.deepEqual([...configFields].sort(),Object.keys(example).sort());
  assert.deepEqual(Object.keys(schema.properties).sort(),Object.keys(example).sort());
  for (const option of ['uploadOnSave','ignoreAlways','ignoreUpload','ignoreDownload','exclude','timeout','privateKeyPath','hostKeySha256','passphrase','secureOptions','ignore','agent','allow','generatedFiles','$schema','secure']) {
    assert.throws(() => parseConnectionConfig({...base,[option]:true}),{message:`invalid option ${option}`});
  }
  assert.equal(parseConnectionConfig({...base,passive:false}).passive,false);
  assert.equal(parseConnectionConfig(base).passive,true);
});

test('configuration discovery ignores old filenames and reports invalid options and JSON', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'wsftp-config-'));
  try {
    await fs.mkdir(path.join(root,'.vscode'));
    for (const name of ['ftp-sync.json','wsftp.json']) {
      await fs.writeFile(path.join(root,'.vscode',name),JSON.stringify(base));
      await fs.writeFile(path.join(root,name),JSON.stringify(base));
    }
    await fs.writeFile(path.join(root,'wsftp-sync.json'),JSON.stringify(base));
    assert.equal(await findConfig(root),undefined);
    await assert.rejects(readConfig(root),/Configuration missing/);
    const file = path.join(root,'.vscode','wsftp-sync.json');
    await fs.writeFile(file,JSON.stringify({...base,protocol:'ftps'}));
    assert.equal(await findConfig(root),file);
    assert.equal((await readConfig(root)).protocol,'ftps');
    await fs.writeFile(file,JSON.stringify({...base,typo_one:'secret-value',typo_two:true,secureOptions:{typo_three:1,rejectUnauthorized:true}}));
    await assert.rejects(readConfig(root),error => {
      assert.ok(error instanceof UserError);
      assert.equal(error.message,'.vscode/wsftp-sync.json: Unknown configuration options: typo_one, typo_two, secureOptions.');
      assert.ok(!error.message.includes('secret-value'));
      return true;
    });
    await fs.writeFile(file,'{"password":"private-test-secret",}');
    await assert.rejects(readConfig(root),{message:'The configuration JSON is invalid: .vscode/wsftp-sync.json. Check the JSON syntax.'});
    await fs.unlink(file);
    await fs.mkdir(file);
    await assert.rejects(readConfig(root),/Unable to read configuration file/);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});

test('example configuration, discovery precedence, shared exclusions and debug validation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'wsftp-example-'));
  try {
    const example = {...JSON.parse(await fs.readFile(path.join(__dirname,'../wsftp-sync.json'),'utf8')),username:'test',host:'localhost',password:'test'};
    await fs.writeFile(path.join(root,'wsftp-sync.json'),JSON.stringify({...base,debug:false}));
    assert.equal(await findConfig(root),undefined);
    await fs.mkdir(path.join(root,'.vscode'));
    await fs.writeFile(path.join(root,'.vscode','wsftp-sync.json'),JSON.stringify(example));
    const config = await readConfig(root);
    assert.equal(config.protocol,'ftps');
    assert.equal(config.debug,true);
    assert.equal(config.password,example.password);
    const { forDirection, parseConfig } = require('../dist/core');
    for (const direction of ['upload','download']) {
      const rules = forDirection(config,direction);
      for (const relative of ['.git/config','.vscode/wsftp-sync.json','sub/.env']) {
        assert.equal(excluded(relative,rules.exclude),true);
      }
    }
    const combined = parseConfig({...base,ignore_upload:['camel','snake'],ignore_always:['shared/']});
    assert.equal(excluded('camel/a',forDirection(combined,'upload').exclude),true);
    assert.equal(excluded('snake/a',forDirection(combined,'upload').exclude),true);
    assert.equal(excluded('camel/a',forDirection(combined,'download').exclude),false);
    assert.equal(excluded('shared/a',forDirection(combined,'download').exclude),true);
    assert.equal(parseConfig(base).debug,false);
    assert.throws(() => parseConnectionConfig({...example,debug:'true'}),/debug must be a boolean/);
    assert.throws(() => parseConnectionConfig({...example,ignore_always:['!file']}),/ignore_always/);
    await fs.writeFile(path.join(root,'.vscode','wsftp-sync.json'),JSON.stringify({...base,debug:false}));
    assert.equal(await findConfig(root),path.join(root,'.vscode','wsftp-sync.json'));
    assert.equal((await readConfig(root)).debug,false);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});


test('upload_on_save validates values and rejects uploadOnSave', () => {
  const { parseConfig } = require('../dist/core');
  for (const parse of [parseConfig,parseConnectionConfig]) {
    assert.equal(parse({...base,upload_on_save:true}).uploadOnSave,true);
    assert.throws(() => parse({...base,upload_on_save:false,uploadOnSave:true}),{message:'invalid option uploadOnSave'});
    assert.throws(() => parse({...base,upload_on_save:true,uploadOnSave:false}),{message:'invalid option uploadOnSave'});
    assert.throws(() => parse({...base,uploadOnSave:true}),{message:'invalid option uploadOnSave'});
    assert.equal(parse(base).uploadOnSave,false);
    for (const value of ['true',1,null]) {
      assert.throws(() => parse({...base,upload_on_save:value}),/upload_on_save must be a boolean/);
    }
  }
});


test('protocol selects transport and the removed secure option is rejected', () => {
  for (const protocol of ['ftp','ftps','sftp']) {
    assert.equal(parseConnectionConfig({...base,protocol}).protocol,protocol);
    for (const secure of [true,false]) {
      assert.throws(() => parseConnectionConfig({...base,protocol,secure}),{message:'invalid option secure'});
    }
  }
});


test('discovery updates only connection settings and refuses concurrent edits', async () => {
  const { applyDiscovery } = require('../dist/config');
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'wsftp-update-'));
  try {
    await fs.mkdir(path.join(root,'.vscode'));
    const file = path.join(root,'.vscode','wsftp-sync.json');
    for (const result of [{protocol:'sftp'},{protocol:'ftps',passive:false},{protocol:'ftp',passive:true}]) {
      const original = JSON.stringify({...base,discover:true,password:'keep-secret',passive:true,ignore_always:['keep']},null,2);
      await fs.writeFile(file,original);
      const detail = await applyDiscovery(root,original,result);
      assert.match(detail,/"discover": false/);
      assert.match(detail,result.protocol === 'sftp' ? /"passive": false/ : /"passive":/);
      const updated = JSON.parse(await fs.readFile(file,'utf8'));
      assert.equal(updated.discover,false);
      assert.equal(updated.protocol,result.protocol);
      assert.equal(updated.passive,result.protocol === 'sftp' ? false : result.passive);
      assert.equal(updated.password,'keep-secret');
      assert.deepEqual(updated.ignore_always,['keep']);
      await assert.rejects(applyDiscovery(root,original,result),/changed during discovery/);
    }
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});


test('template is copied only into existing .vscode and never overwrites config', async () => {
  const { ensureConfig, InactiveConfig } = require('../dist/config');
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'wsftp-template-'));
  const template = path.join(__dirname,'../wsftp-sync.json');
  try {
    await ensureConfig(root,template);
    await assert.rejects(fs.stat(path.join(root,'.vscode')),{code:'ENOENT'});
    await fs.mkdir(path.join(root,'.vscode'));
    await ensureConfig(root,template);
    const file = path.join(root,'.vscode','wsftp-sync.json');
    assert.equal(await fs.readFile(file,'utf8'),await fs.readFile(template,'utf8'));
    await assert.rejects(readConfig(root),InactiveConfig);
    await fs.writeFile(file,'preserve existing content');
    await ensureConfig(root,template);
    assert.equal(await fs.readFile(file,'utf8'),'preserve existing content');
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});


test('autosync accepts booleans and preserves omission for legacy settings fallback', () => {
  const { parseConfig } = require('../dist/core');
  const config = {protocol:'ftps',host:'example',username:'user',remote_path:'/'};
  assert.equal(parseConfig(config).autosync,undefined);
  for (const value of [true,false]) assert.equal(parseConfig({...config,autosync:value}).autosync,value);
  for (const value of ['true','false',1,0,null,{},[]]) assert.throws(() => parseConfig({...config,autosync:value}),/autosync must be a boolean/);
});


test('autosync_secs defaults to two minutes and accepts only positive bounded integer seconds', () => {
  const { parseConfig } = require('../dist/core');
  const config = {protocol:'ftps',host:'example',username:'user',remote_path:'/'};
  assert.equal(parseConfig(config).autosync_secs,120);
  for (const value of [1,3,120,86400]) assert.equal(parseConfig({...config,autosync_secs:value}).autosync_secs,value);
  for (const value of [0,-1,1.5,86401,'120',null,true,{},[]]) assert.throws(() => parseConfig({...config,autosync_secs:value}),/autosync_secs must be an integer/);
});


test('remote_path replaces remotePath and preserves path validation', () => {
  const { parseConfig } = require('../dist/core');
  const config = {protocol:'ftps',host:'example',username:'user',remote_path:'/site//assets/'};
  assert.equal(parseConfig(config).remote_path,'/site/assets/');
  assert.throws(() => parseConfig({...config,remotePath:'/legacy'}),/invalid option remotePath/);
  for (const value of ['relative','/site/../other',123,null]) assert.throws(() => parseConfig({...config,remote_path:value}),/remote_path/);
  assert.equal(parseConfig({host:'example',username:'user',discover:true,port:21}).remote_path,'/');
});

test('legacy config seeds a missing WSFTP config with discovery and working regex filters', async () => {
  const { ensureConfig } = require('../dist/config');
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'wsftp-import-'));
  const template = path.join(__dirname,'../wsftp-sync.json');
  try {
    await fs.mkdir(path.join(root,'.vscode'));
    const source = path.join(root,'.vscode','ftp-sync.json');
    const destination = path.join(root,'.vscode','wsftp-sync.json');
    const original = JSON.stringify({host:'localhost',username:'legacy',password:'secret',port:'2121',remotePath:'/site',uploadOnSave:false,passive:false,debug:false,protocol:'ftp',discover:false,ignore:['\\.vscode','(^|/)cache/','\\.log$'],privateKeyPath:null,generatedFiles:{}});
    await fs.writeFile(source,original);
    await Promise.all([ensureConfig(root,template),ensureConfig(root,template)]);
    const imported = JSON.parse(await fs.readFile(destination,'utf8'));
    assert.equal(imported.discover,true);
    assert.equal(imported.username,'legacy');
    assert.equal(imported.password,'secret');
    assert.equal(imported.port,2121);
    assert.equal(imported.remote_path,'/site');
    assert.equal(imported.upload_on_save,false);
    assert.equal(imported.passive,false);
    assert.equal(imported.debug,false);
    assert.equal(imported.protocol,'ftp');
    assert.ok(!('privateKeyPath' in imported));
    assert.ok(!('generatedFiles' in imported));
    const config = await readConfig(root);
    for (const name of ['.vscode/settings.json','sub/cache/file.txt','sub/error.log']) assert.equal(excluded(name,config.exclude),true);
    assert.equal(excluded('sub/file.txt',config.exclude),false);
    assert.equal(await fs.readFile(source,'utf8'),original);
    await fs.writeFile(source,'invalid json');
    await ensureConfig(root,template);
    assert.deepEqual(JSON.parse(await fs.readFile(destination,'utf8')),imported);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});

test('legacy aliases, defaults, explicit empty filters and field precedence are preserved', async () => {
  const { ensureConfig } = require('../dist/config');
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'wsftp-alias-'));
  try {
    await fs.mkdir(path.join(root,'.vscode'));
    const source = path.join(root,'.vscode','ftp-sync.json');
    const destination = path.join(root,'.vscode','wsftp-sync.json');
    for (const legacy of [
      {username:'user',host:'localhost',pass:'secret',remotePath:'./',ignored:[]},
      {username:'user',host:'localhost',password:'preferred',pass:'other',remote_path:'/preferred',remotePath:'/other',upload_on_save:false,uploadOnSave:true,ignore_always:[],ignore:['ignored'],ignore_upload:[],ignore_download:[]}
    ]) {
      await fs.writeFile(source,JSON.stringify(legacy));
      await ensureConfig(root,path.join(__dirname,'../wsftp-sync.json'));
      const value = JSON.parse(await fs.readFile(destination,'utf8'));
      assert.equal(value.password,legacy.password ?? legacy.pass);
      assert.equal(value.remote_path,legacy.remote_path ?? '/');
      assert.deepEqual(value.ignore_always,[]);
      assert.equal(value.discover,true);
      assert.equal(value.port,21);
      assert.equal(value.upload_on_save,legacy.upload_on_save ?? true);
      await readConfig(root);
      await fs.unlink(destination);
    }
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});

test('invalid legacy imports fail without creating a file or revealing credentials', async () => {
  const { ensureConfig } = require('../dist/config');
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'wsftp-invalid-import-'));
  try {
    await fs.mkdir(path.join(root,'.vscode'));
    for (const text of ['{"password":"secret",}', 'null','[]',JSON.stringify({...base,ignore:[3]}),JSON.stringify({...base,ignore:['[']}),JSON.stringify({...base,port:'invalid'})]) {
      await fs.writeFile(path.join(root,'.vscode','ftp-sync.json'),text);
      await assert.rejects(ensureConfig(root,path.join(__dirname,'../wsftp-sync.json')),error => error instanceof UserError && /import/.test(error.message) && !error.message.includes('secret'));
      await assert.rejects(fs.stat(path.join(root,'.vscode','wsftp-sync.json')),{code:'ENOENT'});
    }
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});
