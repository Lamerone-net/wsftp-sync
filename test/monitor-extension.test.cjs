const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

test('automatic checks notify after stability, never apply actions, stop when disabled and review the correct workspace', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(),'wsftp-monitor-ui-'));
  const subscriptions = [];
  try {
    const rootPath = path.join(base,'project'); await fs.mkdir(path.join(rootPath,'.vscode'),{recursive:true});
    const configFile = path.join(rootPath,'.vscode','wsftp-sync.json');
    const config = {protocol:'ftps',host:'localhost',username:'user',password:'pass',remote_path:'/',autosync_secs:60,ignore_always:['.vscode/**']};
    await fs.writeFile(configFile,JSON.stringify(config));
    const root = {name:'project',uri:{fsPath:rootPath,toString:() => rootPath}};
    const other = {name:'other',uri:{fsPath:path.join(base,'other'),toString:() => 'other'}};
    const commands = new Map(), notifications = [], prompts = [], statuses = [];
    let enabled = true, now = 0, poll, configurationChanged, connects = 0, stopped = false;
    let offline = false, blockedList;
    const timers = new Map();
    const remote = {name:'new.txt',size:3,mtime:100,directory:false,symlink:false};
    const settings = {get:(key,fallback) => key === 'autoCheck.enabled' ? enabled : 1,update:async (_,value) => {enabled=value;}};
    const vscode = {
      CancellationError:class extends Error {},ConfigurationTarget:{WorkspaceFolder:3},StatusBarAlignment:{Left:1},ProgressLocation:{Notification:15},
      workspace:{isTrusted:true,workspaceFolders:[root],textDocuments:[],
        getConfiguration:() => settings,getWorkspaceFolder:uri => uri.fsPath.startsWith(rootPath) ? root : other,
        onDidSaveTextDocument:() => ({dispose(){}}),onDidChangeConfiguration:fn => {configurationChanged=fn;return {dispose(){}};}},
      commands:{registerCommand:(id,fn) => {commands.set(id,fn);return {dispose(){}};}},
      window:{activeTextEditor:{document:{uri:{fsPath:path.join(other.uri.fsPath,'file')}}},
        createOutputChannel:() => ({appendLine(){},dispose(){}}),
        createStatusBarItem:() => {const status={show(){},dispose(){this.disposed=true;}};statuses.push(status);return status;},
        showInformationMessage:(message,...choices) => {notifications.push({message,choices});return Promise.resolve();},
        showWarningMessage:async (message,options,apply,cancel) => {prompts.push({message,options});return cancel;},
        showInputBox:async () => {throw new Error('Unexpected password prompt');},
        showErrorMessage:message => {throw new Error(message);},
        withProgress:async (options,fn) => {
          const notice = options.title.startsWith('WSFTP: project:') ? {message:options.title,closed:false} : undefined;
          if (notice) notifications.push(notice);
          const result = await fn({report(){}},{isCancellationRequested:false});
          if (notice) notice.closed=true;
          return result;
        }}
    };
    const filename = path.resolve(__dirname,'../dist/extension.js'); const realRequire = createRequire(filename);
    const exports = {};
    vm.runInNewContext(await fs.readFile(filename,'utf8'),{exports,setTimeout:(fn,ms) => {const id={};timers.set(id,{fn,ms});return id;},clearTimeout:id => timers.delete(id),Date:class extends Date {static now(){return now;}},require:id => {
      if (id === 'vscode') return vscode;
      if (id === './monitor') return {...realRequire(id),CheckLoop:class {constructor(task){poll=task;}start(){}dispose(){stopped=true;}}};
      if (id === './transport') return {...realRequire(id),connect:async () => {
        connects++; if (offline) throw new Error('offline');
        return {list:async () => {if (blockedList) await blockedList;return [{...remote}];},
          download:async (_,file) => {assert.ok(!file.startsWith(rootPath));await fs.writeFile(file,'new');},
          upload:async () => {throw new Error('Automatic upload');},mkdir:async () => {throw new Error('Automatic mkdir');},remove:async () => {throw new Error('Automatic delete');},close:async () => {}};
      }};
      return realRequire(id);
    }},{filename});
    await exports.activate({extensionPath:path.join(__dirname,'..'),globalStorageUri:{fsPath:path.join(base,'storage')},subscriptions,
      globalState:{get:() => undefined},workspaceState:{get:() => undefined},secrets:{get:async () => undefined}});
    const tick = async () => {now+=61000;await poll();};
    await tick(); assert.equal(notifications.length,0);
    const firstConnects = connects; now += 59000; await poll(); assert.equal(connects,firstConnects,'wait the configured number of seconds');
    await tick(); assert.equal(notifications.length,1); assert.match(notifications[0].message,/1 to download/);
    assert.equal(notifications[0].closed,false);
    assert.equal([...timers.values()][0].ms,5000);
    [...timers.values()][0].fn(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(notifications[0].closed,true,'notice closes after five seconds');
    assert.equal(timers.size,0);
    await tick(); assert.equal(notifications.length,1);
    await assert.rejects(fs.stat(path.join(rootPath,'new.txt')),{code:'ENOENT'});
    const review = statuses[0].command;
    await commands.get(review.command)(...review.arguments);
    assert.match(prompts.at(-1).options.detail,/DOWNLOAD  new.txt/,'review uses monitored root despite another active editor');
    assert.equal(prompts.length,1);
    // A new remote revision must remain stable for another interval.
    remote.mtime++;
    await tick(); assert.equal(notifications.length,1);
    await tick(); assert.equal(notifications.length,2);
    assert.equal(notifications[1].closed,false);
    offline = true; await tick(); assert.equal(notifications[1].closed,true,'next scan closes any pending notice'); assert.match(statuses[0].text,/unavailable/); assert.equal(prompts.length,1);
    offline = false;
    // Disabling during a scan cancels publication and future network calls.
    let release; blockedList = new Promise(resolve => {release=resolve;});
    const active = tick(); await new Promise(resolve => setImmediate(resolve));
    enabled = false; configurationChanged({affectsConfiguration:() => true}); release(); await active;
    const count = connects; await tick(); assert.equal(connects,count); assert.equal(statuses[0].disposed,true);
    assert.equal(timers.size,0,'no notice timers survive disabling checks');
    // Discovery is never started automatically.
    blockedList = undefined; enabled = true; await fs.writeFile(configFile,JSON.stringify({...config,discover:true,port:21}));
    configurationChanged({affectsConfiguration:() => true}); await tick(); assert.equal(connects,count); assert.equal(prompts.length,1);
    // JSON explicitly overrides the legacy VS Code setting in both directions.
    await fs.writeFile(configFile,JSON.stringify({...config,autosync:false}));
    enabled = true; await tick(); assert.equal(connects,count);
    await fs.writeFile(configFile,JSON.stringify({...config,autosync:true}));
    enabled = false; await tick(); assert.equal(connects,count+1);
    await commands.get('wsftp.toggleAutoCheck')();
    const updated = JSON.parse(await fs.readFile(configFile,'utf8'));
    assert.equal(updated.autosync,false);
    assert.equal(updated.host,config.host); assert.deepEqual(updated.ignore_always,config.ignore_always);
    await tick(); assert.equal(connects,count+1);
    await commands.get('wsftp.toggleAutoCheck')();
    assert.equal(JSON.parse(await fs.readFile(configFile,'utf8')).autosync,true);
    await tick(); assert.equal(connects,count+2);
    await fs.writeFile(configFile,JSON.stringify({...config,autosync:true,autosync_secs:3}));
    await poll(); const shortIntervalConnects = connects;
    now += 2000; await poll(); assert.equal(connects,shortIntervalConnects);
    now += 1000; await poll(); assert.equal(connects,shortIntervalConnects+1);
    for (const item of subscriptions) item.dispose(); assert.equal(stopped,true);
  } finally { for (const item of subscriptions) item.dispose(); await fs.rm(base,{recursive:true,force:true}); }
});
