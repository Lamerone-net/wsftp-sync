const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const vm=require('node:vm');
const {createRequire}=require('node:module');
const {panelHarness}=require('./selection-harness.cjs');

async function fixture(mode,run){
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'wsftp-phases-'));
  const local=path.join(base,'local'),remote=path.join(base,'remote');
  await fs.mkdir(path.join(local,'.vscode'),{recursive:true});await fs.mkdir(remote);
  const configFile=path.join(local,'.vscode','wsftp-sync.json');
  await fs.writeFile(configFile,JSON.stringify({protocol:'ftp',host:'localhost',username:'user',password:'secret',remote_path:'/',ignore_always:['.vscode/**','**/protected/**']}));
  const commands=new Map(),errors=[],events=[],subscriptions=[],progress=[];
  const root={name:'project',uri:{scheme:'file',fsPath:local,toString:()=>local}};
  const put=async(root,name,content='contents')=>{const file=path.join(root,name);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,content);};
  const source=mode==='local'?local:remote,target=mode==='local'?remote:local;
  let review=data=>data.actions.map((_,i)=>i),failTransfer=false,observeTransfer=()=>{};
  const remotePath=p=>path.join(remote,p);
  const transport={
    list:async p=>{events.push(`list:${p}`);return Promise.all((await fs.readdir(remotePath(p),{withFileTypes:true})).map(async e=>{const s=await fs.stat(path.join(remotePath(p),e.name));return {name:e.name,directory:e.isDirectory(),size:s.size,mtime:s.mtimeMs,symlink:false};}));},
    upload:async(l,r)=>{if(failTransfer)throw new Error('failed upload');events.push('upload');await observeTransfer();await fs.copyFile(l,remotePath(r));},
    download:async(r,l)=>{if(failTransfer)throw new Error('failed download');events.push('download');await observeTransfer();await fs.copyFile(remotePath(r),l);},
    mkdir:async r=>{events.push(`mkdir:${r}`);return fs.mkdir(remotePath(r),{recursive:true});},
    remove:async(r,d)=>{events.push('delete');return d?fs.rmdir(remotePath(r)):fs.unlink(remotePath(r));},close:async()=>{}
  };
  const vscode={ViewColumn:{Active:-1},ProgressLocation:{Notification:15},CancellationError:class extends Error{},
    workspace:{isTrusted:true,workspaceFolders:[root],textDocuments:[],getWorkspaceFolder:()=>root,onDidSaveTextDocument:()=>({dispose(){}})},
    commands:{registerCommand:(id,fn)=>{commands.set(id,fn);return {dispose(){}};}},
    window:{createOutputChannel:()=>({replace(){},appendLine(){},show(){},dispose(){}}),
      setStatusBarMessage:()=>({dispose(){}}),showErrorMessage:message=>errors.push(message),showInformationMessage:()=>{},
      withProgress:async(_,fn)=>fn({report(update){progress.push(update.message);}},{isCancellationRequested:false,onCancellationRequested:()=>({dispose(){}})}),
      createWebviewPanel:panelHarness(async data=>{events.push(data.deletion?'delete-preview':'transfer-preview');return review(data);})}
  };
  const filename=path.resolve(__dirname,'../dist/extension.js'),realRequire=createRequire(filename),exports={};
  vm.runInNewContext(await fs.readFile(filename,'utf8'),{exports,require:id=>id==='vscode'?vscode:id==='./transport'?{...realRequire(id),connect:async()=>transport}:realRequire(id)},{filename});
  await exports.activate({extensionPath:path.resolve(__dirname,'..'),subscriptions,globalStorageUri:{fsPath:path.join(base,'cache')},workspaceState:{get:()=>true},globalState:{get:()=>undefined},secrets:{get:async()=>undefined}});
  const sync=()=>commands.get(mode==='local'?'wsftp.syncUploadRoot':'wsftp.syncDownloadRoot')();
  try{await run({local,remote,source,target,put,sync,errors,events,progress,configFile,vscode,setReview:fn=>review=fn,setFail:()=>failTransfer=true,setTransferObserver:fn=>observeTransfer=fn});}
  finally{for(const subscription of subscriptions)subscription.dispose();await fs.rm(base,{recursive:true,force:true});}
}

test('upload and download select transfers first, then delete only selected orphans',async()=>{
  for(const mode of ['local','remote'])await fixture(mode,async f=>{
    await f.put(f.source,'new/selected');await f.put(f.source,'new/skipped');
    await f.put(f.target,'old/keep');await f.put(f.target,'old/remove');
    await f.put(f.target,'protected/keep');await fs.mkdir(path.join(f.target,'empty'));
    f.setReview(async data=>{
      if(!data.deletion){assert.ok(data.actions.every(a=>!a.kind.startsWith('delete-')));return data.actions.flatMap((a,i)=>a.relative==='new/selected'?[i]:[]);}
      assert.equal(await fs.readFile(path.join(f.target,'new/selected'),'utf8'),'contents');
      await assert.rejects(fs.stat(path.join(f.target,'new/skipped')),{code:'ENOENT'});
      assert.ok(data.actions.every(a=>a.kind===`delete-${mode==='local'?'remote':'local'}`));
      assert.ok(data.actions.every(a=>!a.relative.includes('protected')));
      return data.actions.flatMap((a,i)=>a.relative!=='old/keep'?[i]:[]);
    });
    await f.sync();assert.deepEqual(f.errors,[]);
    assert.equal(await fs.readFile(path.join(f.target,'old/keep'),'utf8'),'contents');
    await assert.rejects(fs.stat(path.join(f.target,'old/remove')),{code:'ENOENT'});
    await assert.rejects(fs.stat(path.join(f.target,'empty')),{code:'ENOENT'});
    assert.equal(await fs.readFile(path.join(f.target,'protected/keep'),'utf8'),'contents');
    assert.ok(f.events.indexOf('delete-preview')>f.events.indexOf(mode==='local'?'upload':'download'));
  });
});

test('cancelling deletion preserves completed transfers and all orphans',async()=>fixture('local',async f=>{
  await f.put(f.source,'new');await f.put(f.target,'orphan');
  f.setReview(data=>data.deletion?undefined:data.actions.map((_,i)=>i));
  await f.sync();assert.deepEqual(f.errors,[]);
  assert.equal(await fs.readFile(path.join(f.target,'new'),'utf8'),'contents');
  assert.equal(await fs.readFile(path.join(f.target,'orphan'),'utf8'),'contents');
}));

test('transfer cancellation or failure never opens the deletion phase',async()=>{
  for(const failure of [false,true])await fixture('local',async f=>{
    await f.put(f.source,'new');await f.put(f.target,'orphan');
    if(failure)f.setFail();else f.setReview(()=>undefined);
    await f.sync();assert.equal(f.errors.length,failure?1:0);
    assert.ok(!f.events.includes('delete-preview'));
    assert.equal(await fs.readFile(path.join(f.target,'orphan'),'utf8'),'contents');
  });
});

test('orphan-only sync still requests deletion and revalidates source and configuration',async()=>{
  for(const changed of ['none','source','config','dirty'])await fixture('remote',async f=>{
    await f.put(f.target,'orphan');
    f.setReview(async data=>{
      assert.equal(data.deletion,true);
      if(changed==='source')await f.put(f.source,'orphan','now legitimate');
      if(changed==='config'){const config=JSON.parse(await fs.readFile(f.configFile,'utf8'));config.ignore_download=['orphan'];await fs.writeFile(f.configFile,JSON.stringify(config));}
      if(changed==='dirty')f.vscode.workspace.textDocuments.push({isDirty:true,uri:{fsPath:path.join(f.target,'orphan')}});
      return data.actions.map((_,i)=>i);
    });
    await f.sync();
    if(changed==='none'){assert.deepEqual(f.errors,[]);await assert.rejects(fs.stat(path.join(f.target,'orphan')),{code:'ENOENT'});}
    else{assert.equal(f.errors.length,1);assert.equal(await fs.readFile(path.join(f.target,'orphan'),'utf8'),'contents');}
  });
});

test('confirmed copies start without rescanning unrelated trees or creating all directories first',async()=>{
  for(const mode of ['local','remote'])await fixture(mode,async f=>{
    await f.put(f.source,'selected/deep/file');
    await f.put(f.source,'unselected/deep/file');
    for(let i=0;i<30;i++)await fs.mkdir(path.join(f.source,`empty-${i}`));
    await f.put(f.target,'orphan');
    let confirmedAt,transfers=0;
    f.setReview(data=>{
      if(data.deletion){assert.equal(transfers,1);assert.match(f.progress.at(-1),/Waiting for orphan deletion selection/);return [];}
      confirmedAt=f.events.length;
      assert.match(f.progress.at(-1),/Waiting for transfer selection/);
      return data.actions.flatMap((a,i)=>a.relative.startsWith('unselected')?[]:[i]);
    });
    f.setTransferObserver(async()=>{
      transfers++;
      const since=f.events.slice(confirmedAt);
      assert.ok(!since.some(event=>event.startsWith('list:/unselected')),since.join('\n'));
      assert.ok(!since.some(event=>event.startsWith('list:/empty-')),since.join('\n'));
      assert.ok(!since.some(event=>event.startsWith('mkdir:/empty-')),since.join('\n'));
      await assert.rejects(fs.stat(path.join(f.target,'empty-0')),{code:'ENOENT'});
      assert.match(f.progress.at(-1),mode==='local'?/^Uploading \d+\/\d+: selected\/deep\/file$/:/^Downloading \d+\/\d+: selected\/deep\/file$/);
    });
    await f.sync();assert.deepEqual(f.errors,[]);
    assert.equal(transfers,1);
    assert.ok((await fs.stat(path.join(f.target,'empty-0'))).isDirectory());
    await assert.rejects(fs.stat(path.join(f.target,'unselected')),{code:'ENOENT'});
  });
});

test('per-file checks still reject changed sources and targets after confirmation without cleanup',async()=>{
  for(const mode of ['local','remote'])for(const side of ['source','target'])await fixture(mode,async f=>{
    await f.put(f.source,'file','source contents');await f.put(f.target,'file','old');await f.put(f.target,'orphan');
    f.setReview(async data=>{await f.put(f[side],'file','changed after preview');return data.actions.map((_,i)=>i);});
    await f.sync();
    assert.equal(f.errors.length,1);
    assert.match(f.errors[0],/file changed after preview: file/);
    assert.ok(!f.events.includes('upload')&&!f.events.includes('download'));
    assert.ok(!f.events.includes('delete-preview'));
    assert.equal(await fs.readFile(path.join(f.target,'file'),'utf8'),side==='target'?'changed after preview':'old');
  });
});

test('deletion verification reports progress while rescanning before any removal',async()=>fixture('local',async f=>{
  await f.put(f.source,'new');await f.put(f.target,'old/nested/orphan');
  f.setReview(data=>{
    if(data.deletion)assert.ok(f.events.includes('upload'));
    return data.actions.map((_,i)=>i);
  });
  await f.sync();assert.deepEqual(f.errors,[]);
  assert.ok(f.progress.some(message=>message==='Checking for changes before deletion...'));
  assert.ok(f.progress.some(message=>message==='Checking before deletion: Scanning remote directory: old/nested/'));
  assert.ok(f.progress.some(message=>/^Deleting remote orphan \d+\/\d+: old\/nested\/orphan$/.test(message)));
  await assert.rejects(fs.stat(path.join(f.target,'old')),{code:'ENOENT'});
}));
