const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {selectedActions,selectionHtml,chooseSyncActions}=require('../dist/selection');

test('selected copies include required parents and retain original execution order',()=>{
  const actions=[{relative:'a',kind:'mkdir-remote',directory:true},{relative:'a/b',kind:'mkdir-remote',directory:true},{relative:'a/b/file',kind:'upload',directory:false},{relative:'a/skip',kind:'upload',directory:false}];
  assert.deepEqual(selectedActions(actions,[2],{local:new Map(),remote:new Map()}),actions.slice(0,3));
});

test('keeping a descendant protects all its deletion ancestors, regardless of action order',()=>{
  const actions=['a','a/b','a/b/keep','a/delete'].map((relative,i)=>({relative,kind:'delete-local',directory:i<2}));
  const snapshot={local:new Map(actions.map(a=>[a.relative,{directory:a.directory}])),remote:new Map()};
  assert.deepEqual(selectedActions(actions,[0,1,3],snapshot),[actions[3]]);
  assert.deepEqual(selectedActions(actions,[0,1,2,3],snapshot),actions);
  assert.deepEqual(selectedActions(actions,[],snapshot),[]);
});

test('webview escapes server paths and rejects untrusted selection indices',async()=>{
  const actions=[{relative:'</script><script>evil()</script>',kind:'upload',directory:false}];
  const html=selectionHtml('Review',actions,false);
  assert.ok(!html.includes(actions[0].relative));
  assert.ok(html.includes("default-src 'none'"));
  let receive,close,cancel,disposeCount=0;
  const panel={dispose(){disposeCount++;close?.();},onDidDispose(fn){close=fn;return {dispose(){close=undefined;}};},webview:{onDidReceiveMessage(fn){receive=fn;return {dispose(){receive=undefined;}};}}};
  const token={isCancellationRequested:false,onCancellationRequested(fn){cancel=fn;return {dispose(){cancel=undefined;}};}};
  const ui={ViewColumn:{Active:-1},window:{createWebviewPanel:()=>panel}};
  const result=chooseSyncActions(ui,'Review',actions,{local:new Map(),remote:new Map()},token);
  for(const indices of [[-1],[1],['0'],[0.5]])receive({type:'apply',indices});
  assert.equal(disposeCount,0);
  receive({type:'apply',indices:[0,0]});
  assert.deepEqual(await result,actions);
  assert.equal(disposeCount,1);
  const pending=chooseSyncActions(ui,'Review',actions,{local:new Map(),remote:new Map()},token);
  cancel();
  assert.equal(await pending,undefined);
});

test('folder checkboxes select descendants, mixed states update, and deletion starts unchecked',()=>{
  for(const deletion of [false,true]){
    const elements=new Map();
    const make=tag=>({tag,children:[],listeners:{},append(...children){this.children.push(...children);},setAttribute(name,value){this[name]=value;},addEventListener(name,fn){this.listeners[name]=fn;}});
    const document={getElementById(id){if(!elements.has(id))elements.set(id,make('div'));return elements.get(id);},createElement:make,querySelectorAll:()=>[]};
    const messages=[];
    const actions=[{relative:'folder/one',kind:'upload',directory:false},{relative:'folder/two',kind:'upload',directory:false}];
    const html=selectionHtml('Review',actions,deletion);
    vm.runInNewContext(html.match(/<script nonce="[^"]+">([\s\S]*)<\/script>/)[1],{document,acquireVsCodeApi:()=>({postMessage:message=>messages.push(message)})});
    const folder=elements.get('tree').children[0];
    const folderCheck=folder.children[0].children[0];
    assert.equal(folderCheck.checked,!deletion);
    folderCheck.checked=true;folderCheck.listeners.change();
    const first=folder.children[1].children[0].children[0].children[0];
    first.checked=false;first.listeners.change();
    assert.equal(folderCheck.indeterminate,true);
    elements.get('apply').onclick();
    assert.deepEqual(Array.from(messages[0].indices),[1]);
    elements.get('none').onclick();
    assert.equal(folderCheck.checked,false);
    assert.equal(folderCheck.indeterminate,false);
  }
});
