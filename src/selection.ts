import { randomBytes } from 'node:crypto';
import type * as vscode from 'vscode';
import type { Snapshot, SyncAction } from './sync';

export function selectedActions(actions: SyncAction[], indices: number[], snapshot: Snapshot): SyncAction[] {
  const selected = new Set(indices.map(index => actions[index]).filter(Boolean));
  const parents = new Map(actions.filter(action => action.kind.startsWith('mkdir-')).map(action => [action.relative,action]));
  // A selected copy needs its missing parents even if their individual rows were unchecked.
  for (const action of [...selected]) {
    if (action.kind.startsWith('delete-')) continue;
    const parts = action.relative.split('/');
    for (let i = 1; i < parts.length; i++) {
      const parent = parents.get(parts.slice(0,i).join('/'));
      if (parent) selected.add(parent);
    }
  }
  // Keep directories containing any unselected or protected destination entry.
  for (const kind of ['delete-local','delete-remote'] as const) {
    const tree = kind === 'delete-local' ? snapshot.local : snapshot.remote;
    const removed = new Set([...selected].filter(item => item.kind === kind).map(item => item.relative));
    const protectedParents = new Set<string>();
    for (const relative of tree.keys()) {
      if (removed.has(relative)) continue;
      const parts = relative.split('/');
      for (let i = 1; i < parts.length; i++) protectedParents.add(parts.slice(0,i).join('/'));
    }
    for (const action of selected) if (action.kind === kind && action.directory && protectedParents.has(action.relative)) selected.delete(action);
  }
  return actions.filter(action => selected.has(action));
}

export function selectionHtml(title: string, actions: SyncAction[], deletion: boolean, conflicts: SyncAction[] = []): string {
  const nonce = randomBytes(18).toString('hex');
  const data = JSON.stringify({title,actions,deletion,conflicts}).replace(/</g,'\\u003c');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
*{box-sizing:border-box}body{margin:0;font-family:var(--vscode-font-family);font-size:12px;line-height:1.35;color:var(--vscode-foreground);background:var(--vscode-editor-background)}
main{height:100vh;display:flex;flex-direction:column;padding:10px;gap:8px}h1{font-size:16px;margin:0}p{margin:0;line-height:1.35}
header,footer{flex:none}header{display:grid;gap:6px}.toolbar,footer{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
button{font:inherit;padding:3px 8px;min-height:24px;border:1px solid var(--vscode-button-border,transparent);background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);cursor:pointer}
button.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}button:focus-visible,input:focus-visible,summary:focus-visible{outline:2px solid var(--vscode-focusBorder)}
#tree{flex:1;min-height:0;overflow:auto;border:1px solid var(--vscode-panel-border);padding:4px}label,summary{min-height:22px;display:flex;gap:6px;align-items:flex-start;padding:2px}summary{cursor:pointer}details>div{padding-left:16px}
input{flex:none;width:13px;height:13px;margin:1px 0}label span,summary span{overflow-wrap:anywhere}small{font-size:11px;color:var(--vscode-descriptionForeground)}#count{margin-right:auto}#conflicts{max-height:90px;overflow:auto;white-space:pre-wrap}footer{border-top:1px solid var(--vscode-panel-border);padding-top:8px}
</style></head><body><main><header><h1 id="title"></h1><p id="warning"></p><p id="help"></p><small id="conflicts"></small>
<div class="toolbar"><button id="all">Select all</button><button id="none">Select none</button><button id="expand">Expand all</button><button id="collapse">Collapse all</button><button id="copy" title="Copy all operations, including selection status and skipped conflicts">Copy list to clipboard</button></div></header>
<section id="tree" aria-label="Files and directories"></section><footer><span id="count" role="status" aria-live="polite"></span><button id="cancel">Cancel</button><button class="primary" id="apply"></button></footer></main>
<script nonce="${nonce}">
const data=${data};
const vscode=acquireVsCodeApi();
document.getElementById('title').textContent=data.title;
document.getElementById('warning').textContent=data.deletion ? 'Only selected orphans will be deleted from the destination. Deletions cannot be undone.' : 'Only selected files and directories will be transferred. Existing destination files may be overwritten. Orphan deletion is reviewed separately after transfers finish.';
document.getElementById('help').textContent=data.deletion ? 'Directories containing files you keep will also be kept. Nothing is selected by default.' : 'Use folder checkboxes to select or skip their contents. Required parent directories are included automatically.';
document.getElementById('conflicts').textContent=data.conflicts.length ? data.conflicts.length+' conflicts will be skipped:\\n'+data.conflicts.map(a=>a.relative+' - '+(a.note||'Conflict')).join('\\n') : '';
const chosen=new Set(data.deletion ? [] : data.actions.map((_,i)=>i));
const root={children:new Map(),ids:[]};
data.actions.forEach((action,index)=>{let node=root;node.ids.push(index);action.relative.split('/').forEach(part=>{if(!node.children.has(part))node.children.set(part,{name:part,children:new Map(),ids:[]});node=node.children.get(part);node.ids.push(index);});node.action=index;node.directory=action.directory;});
const controls=[];
function update(){controls.forEach(({input,node})=>{const count=node.ids.reduce((sum,id)=>sum+Number(chosen.has(id)),0);input.checked=count===node.ids.length;input.indeterminate=count>0&&count<node.ids.length;});document.getElementById('count').textContent=chosen.size+' of '+data.actions.length+' operations selected';document.getElementById('apply').textContent=data.deletion ? (chosen.size ? 'Delete selected' : 'Keep all') : (chosen.size ? 'Transfer selected' : 'Continue without transfers');}
function render(node,parent,prefix){for(const child of node.children.values()){const folder=child.directory||child.children.size>0;const element=document.createElement(folder?'details':'div');const row=document.createElement(folder?'summary':'label');const input=document.createElement('input');input.type='checkbox';const relative=prefix+child.name;input.setAttribute('aria-label',relative+(folder?'/':''));input.addEventListener('click',event=>event.stopPropagation());input.addEventListener('change',()=>{child.ids.forEach(id=>input.checked?chosen.add(id):chosen.delete(id));update();});controls.push({input,node:child});const name=document.createElement('span');name.textContent=child.name+(folder?'/':'');name.title=relative;row.append(input,name);if(child.action!==undefined){const kind=document.createElement('small');kind.textContent=data.actions[child.action].kind.toUpperCase();row.append(kind);}element.append(row);if(folder){element.open=true;const contents=document.createElement('div');render(child,contents,relative+'/');element.append(contents);}parent.append(element);}}
render(root,document.getElementById('tree'),'');update();
document.getElementById('all').onclick=()=>{data.actions.forEach((_,i)=>chosen.add(i));update();};document.getElementById('none').onclick=()=>{chosen.clear();update();};
document.getElementById('expand').onclick=()=>document.querySelectorAll('details').forEach(d=>d.open=true);document.getElementById('collapse').onclick=()=>document.querySelectorAll('details').forEach(d=>d.open=false);
document.getElementById('copy').onclick=()=>vscode.postMessage({type:'copy',indices:[...chosen]});
document.getElementById('cancel').onclick=()=>vscode.postMessage({type:'cancel'});
document.getElementById('apply').onclick=()=>{document.querySelectorAll('button,input').forEach(element=>element.disabled=true);vscode.postMessage({type:'apply',indices:[...chosen]});};
</script></body></html>`;
}

export async function chooseSyncActions(ui: Pick<typeof vscode,'window' | 'ViewColumn' | 'env'>, title: string, actions: SyncAction[], snapshot: Snapshot, token: vscode.CancellationToken, deletion = false, conflicts: SyncAction[] = []): Promise<SyncAction[] | undefined> {
  if (token.isCancellationRequested) return undefined;
  const panel = ui.window.createWebviewPanel('wsftp.selection',title,ui.ViewColumn.Active,{enableScripts:true,localResourceRoots:[],retainContextWhenHidden:true,enableFindWidget:true});
  return new Promise(resolve => {
    let settled = false;
    const subscriptions: vscode.Disposable[] = [];
    const finish = (result: SyncAction[] | undefined) => {
      if (settled) return;
      settled = true;
      for (const subscription of subscriptions) subscription.dispose();
      panel.dispose();
      resolve(result);
    };
    subscriptions.push(panel.onDidDispose(() => finish(undefined)),token.onCancellationRequested(() => finish(undefined)),
      panel.webview.onDidReceiveMessage(async message => {
        if (message?.type === 'copy' && Array.isArray(message.indices) && message.indices.every((index: unknown) => Number.isInteger(index) && Number(index) >= 0 && Number(index) < actions.length)) {
          const chosen = new Set<number>(message.indices);
          const lines = actions.map((action,index) => `${chosen.has(index) ? '[x]' : '[ ]'} ${action.kind.toUpperCase()}  ${action.relative}${action.directory ? '/' : ''}`);
          lines.push(...conflicts.map(action => `[!] CONFLICT  ${action.relative} - ${action.note || 'Conflict'}`));
          try {
            await ui.env.clipboard.writeText([title,'',...lines].join('\n'));
            void ui.window.showInformationMessage('WSFTP: List copied to clipboard.');
          } catch {
            void ui.window.showErrorMessage('WSFTP: Could not copy the list to clipboard.');
          }
        }
        else if (message?.type === 'cancel') finish(undefined);
        else if (message?.type === 'apply' && Array.isArray(message.indices) && message.indices.every((index: unknown) => Number.isInteger(index) && Number(index) >= 0 && Number(index) < actions.length)) {
          finish(token.isCancellationRequested ? undefined : selectedActions(actions,message.indices,snapshot));
        }
      }));
    panel.webview.html = selectionHtml(title,actions,deletion,conflicts);
    if (token.isCancellationRequested) finish(undefined);
  });
}
