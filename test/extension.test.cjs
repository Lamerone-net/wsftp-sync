const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

test('saved documents and keyboard upload command use wsftp-sync configuration; invalid JSON is reported', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wsftp-extension-'));
  try {
    await fs.mkdir(path.join(rootPath, '.vscode'));
    const configPath = path.join(rootPath, '.vscode', 'wsftp-sync.json');
    await fs.writeFile(configPath, JSON.stringify({protocol:'ftps',host:'localhost',username:'test',password:'test',remotePath:'/',upload_on_save:true,debug:true,ignore_always:['.vscode/**']}));
    const uri = {scheme:'file',fsPath:path.join(rootPath,'file.txt')};
    await fs.writeFile(uri.fsPath,'hello');
    const root = {uri:{fsPath:rootPath,toString:() => rootPath}};
    const commands = new Map(), uploads = [], errors = [], statuses = [];
    let onSave, apply = true;
    const previews = [];
    const diagnostics = [];
    const discoveries = [];
    const trust = new Map([['tls:localhost:21','a'.repeat(64)]]);
    let discoveredProtocol = 'ftps';
    const information = [];
    const remoteFiles = new Map();
    const vscode = {
      debug:{activeDebugConsole:{appendLine:message => diagnostics.push(message)}},
      CancellationError: class extends Error {},
      ProgressLocation:{Notification:15},
      window: {withProgress:async (_, action) => action({report(){}},{isCancellationRequested:false}),showWarningMessage:async (title,options,yes,no) => {previews.push({title,...options,yes,no});return apply ? yes : no;},createOutputChannel:() => ({appendLine(){},dispose(){}}),showErrorMessage:message => errors.push(message),showInformationMessage:(title,options) => information.push({title,...options}),activeTextEditor:{document:{uri}}},
      workspace: {textDocuments:[],isTrusted:true,workspaceFolders:[root],getWorkspaceFolder:() => root,onDidSaveTextDocument:handler => {onSave=handler;return {dispose(){}};}},
      commands: {registerCommand:(id,handler) => {commands.set(id,handler);return {dispose(){}};}}
    };
    const filename = path.resolve(__dirname,'../dist/extension.js');
    vscode.window.setStatusBarMessage = (text, timeout) => {
      statuses.push({text, timeout});
      return {dispose(){}};
    };
    const realRequire = createRequire(filename);
    const exports = {};
    vm.runInNewContext(await fs.readFile(filename,'utf8'), {exports,require:id => id === 'vscode' ? vscode : id === './discovery' ? {discoverProtocol:async (c,password,verify,allowFTP) => {discoveries.push(c);if (discoveredProtocol === 'ftp') assert.equal(await allowFTP(),true);return {protocol:discoveredProtocol,passive:true};}} : id === './transport' ? {
      inspectRemote:async (_,c,relative) => remoteFiles.get(relative),
      connect:async (config,secret,verify,debug,verifyTLS) => {
        if (verifyTLS) assert.equal(await verifyTLS({fingerprint:'a'.repeat(64),subject:'localhost',issuer:'localhost',validFrom:'2026',validTo:'2027',error:'self signed certificate'}),true);
        debug('> PASS test');
        debug('< 220 Welcome\r\nServer ready');
        assert.equal(config.protocol,'ftps'); assert.equal(secret,'test');
        return {list:async remote => remote === '/' ? [...remoteFiles].map(([name,e]) => ({name,...e})) : [],download:async (remote,local) => fs.writeFile(local,'downloaded'),upload:async (local,remote) => uploads.push([local,remote]),close:async () => {}};
      }
    } : realRequire(id)}, {filename});
    await exports.activate({extensionPath:path.join(__dirname,'..'),subscriptions:[],globalState:{get:key => trust.get(key),update:async (key,value) => trust.set(key,value)},secrets:{get:async () => undefined}});
    await onSave({uri});
    assert.ok(diagnostics.some(line => line.includes('< 220 Welcome\r\nServer ready')));
    assert.ok(diagnostics.some(line => line.includes('> PASS [REDACTED]')));
    assert.ok(diagnostics.every(line => !line.includes('test')));
    assert.equal(uploads.length,1);
    assert.deepEqual(statuses, [{text:'$(check) Upload file.txt: successful',timeout:5000}]);
    trust.clear();
    const manifest = require('../package.json');
    const binding = manifest.contributes.keybindings.find(b => b.key === 'ctrl+alt+u');
    await commands.get(binding.command)();
    assert.equal(uploads.length,2);
    assert.equal(statuses.at(-1).text,'$(check) Upload 1/1: successful');
    assert.equal(uploads[0][1],'/file.txt');
    assert.ok(commands.has(manifest.contributes.keybindings.find(b => b.key === 'ctrl+alt+d').command));
    await fs.mkdir(path.join(rootPath,'sub'));
    await fs.writeFile(path.join(rootPath,'sub','nested.txt'),'nested');
    vscode.window.activeTextEditor.document.uri = {scheme:'file',fsPath:path.join(rootPath,'sub','nested.txt')};
    apply = false;
    await commands.get(binding.command)();
    assert.equal(uploads.length,2);
    assert.match(previews.at(-1).detail,/file.txt/);
    assert.match(previews.at(-1).detail,/sub\/nested.txt/);
    assert.equal(previews.at(-1).yes.title,'Apply');
    assert.equal(previews.at(-1).no.title,'Cancel');
    assert.equal(previews.at(-1).no.isCloseAffordance,true);
    apply = true;
    await commands.get('wsftp.uploadDir')({scheme:'file',fsPath:path.join(rootPath,'sub')});
    assert.equal(uploads.length,3);
    assert.equal(uploads.at(-1)[1],'/sub/nested.txt');
    assert.doesNotMatch(previews.at(-1).detail,/  file.txt/);
    remoteFiles.set('remote.txt',{size:10,mtime:10000,directory:false,symlink:false});
    apply = false;
    await commands.get('wsftp.downloadRoot')();
    await assert.rejects(fs.stat(path.join(rootPath,'remote.txt')));
    apply = true;
    await commands.get('wsftp.downloadRoot')();
    assert.equal(await fs.readFile(path.join(rootPath,'remote.txt'),'utf8'),'downloaded');
    assert.equal(statuses.at(-1).text,'$(check) Download 1/1: successful');
    assert.equal(errors.length,0);
    assert.equal(previews.filter(p => p.title === 'Verify the FTPS server certificate.').length,1);
    assert.equal(trust.get('tls:localhost:21'),'a'.repeat(64));
    const settings = JSON.parse(await fs.readFile(configPath,'utf8'));
    await fs.writeFile(configPath,JSON.stringify({...settings,ignore_upload:['sub','file.txt','remote.txt'],ignore_download:['remote.txt']}));
    const previewCount = previews.length;
    const statusCount = statuses.length;
    await onSave({uri});
    await commands.get('wsftp.upload')(uri);
    await commands.get('wsftp.uploadRoot')();
    await commands.get('wsftp.uploadDir')({scheme:'file',fsPath:path.join(rootPath,'sub')});
    await fs.writeFile(path.join(rootPath,'remote.txt'),'keep local');
    const remoteUri = {scheme:'file',fsPath:path.join(rootPath,'remote.txt')};
    await commands.get('wsftp.download')(remoteUri);
    await commands.get('wsftp.downloadRoot')();
    assert.equal(await fs.readFile(remoteUri.fsPath,'utf8'),'keep local');
    assert.equal(uploads.length,3);
    assert.equal(previews.length,previewCount);
    assert.equal(statuses.length,statusCount);
    assert.equal(errors.length,0);
    await fs.writeFile(configPath,JSON.stringify({discover:true,host:'localhost',port:21,username:'test',password:'test'}));
    await onSave({uri:{scheme:'file',fsPath:configPath}});
    assert.equal(discoveries.length,1);
    assert.match(information.at(-1).detail, /"protocol": "ftps"/);
    assert.match(information.at(-1).detail, /"discover": false/);
    assert.equal(uploads.length,3);
    await onSave({uri});
    assert.equal(discoveries.length,1);
    await fs.writeFile(configPath,JSON.stringify({discover:true,host:'localhost',port:21,username:'test',password:'test'}));
    await commands.get('wsftp.upload')(uri);
    assert.equal(discoveries.length,2);
    assert.equal(uploads.length,3);
    assert.equal(JSON.parse(await fs.readFile(configPath,'utf8')).discover,false);
    assert.equal(JSON.parse(await fs.readFile(configPath,'utf8')).protocol,'ftps');
    assert.equal(information.at(-1).title,'The configuration file has been updated.');
    await fs.writeFile(configPath,JSON.stringify({discover:true,host:'localhost',port:21,username:'test',password:'test'}));
    discoveredProtocol = 'ftp';
    await commands.get('wsftp.uploadRoot')();
    assert.equal(discoveries.length,3);
    assert.match(previews.at(-2).title,/high risk of interception/);
    assert.equal(previews.at(-1).title,'The configuration file has been updated.');
    assert.match(previews.at(-1).detail,/not secure/);
    assert.match(previews.at(-1).detail,/"discover": false/);
    assert.equal(uploads.length,3);
    await fs.writeFile(configPath,JSON.stringify({protocol:'ftp',host:'localhost',username:'test',password:'test',remotePath:'/',typo_one:'private',typo_two:true}));
    await onSave({uri});
    assert.equal(errors.pop(),'WSFTP: .vscode/wsftp-sync.json: Unknown configuration options: typo_one, typo_two.');
    await fs.writeFile(configPath,JSON.stringify({protocol:'ftps',host:'localhost',username:'test',password:'test',remotePath:'/',uploadOnSave:true}));
    await onSave({uri:{scheme:'file',fsPath:configPath}});
    assert.equal(errors.pop(),'WSFTP: .vscode/wsftp-sync.json: invalid option uploadOnSave');
    assert.equal(uploads.length,3);
    for (const field of ['username','password','host']) {
      for (const value of [undefined,null,'','   ']) {
        await fs.writeFile(configPath,JSON.stringify({username:'test',password:'test',host:'localhost',discover:true,upload_on_save:true,[field]:value}));
        await onSave({uri:{scheme:'file',fsPath:configPath}});
        await commands.get('wsftp.upload')(uri);
        await commands.get('wsftp.uploadRoot')();
        assert.equal(errors.length,0);
        assert.equal(uploads.length,3);
        assert.equal(discoveries.length,3);
      }
    }
    await fs.writeFile(configPath,'{');
    await onSave({uri});
    assert.equal(errors[0],'WSFTP: The configuration JSON is invalid: .vscode/wsftp-sync.json. Check the JSON syntax.');
    assert.equal(uploads.length,3);
  } finally { await fs.rm(rootPath,{recursive:true,force:true}); }
});
