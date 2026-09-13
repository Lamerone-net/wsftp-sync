import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Config, excluded, remoteFile, safeRelative, UserError, forDirection } from './core';
import { disposeRegex } from './ignore';
import { discoverProtocol } from './discovery';
import { findConfig, readConfig, applyDiscovery, ensureConfig, InactiveConfig } from './config';
import { connect, Transport, inspectRemote, TLSIdentity, TLSNotTrusted } from './transport';
import { localPath, scanLocal, scanRemote, download, planSync } from './files';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const log = vscode.window.createOutputChannel('WSFTP Sync');
  const writeLog = (message: string) => {
    const line = `${new Date().toISOString()} ${message.replace(/[\r\n\x00-\x1f]/g, ' ')}`;
    log.appendLine(line);
  };
  const queues = new Map<string, Promise<void>>();
  let transferStatus: vscode.Disposable | undefined;
  context.subscriptions.push({dispose:disposeRegex},log, { dispose: () => transferStatus?.dispose() });
  function showTransferStatus(direction: 'upload' | 'download', detail: string): void {
    transferStatus?.dispose();
    const label = direction === 'upload' ? 'Upload' : 'Download';
    transferStatus = vscode.window.setStatusBarMessage(`$(check) ${label} ${detail}: successful`,5000);
  }
  function report(error: unknown): void {
    if (error instanceof InactiveConfig) return;
    if (error instanceof vscode.CancellationError) { writeLog('Operation cancelled; completed transfers remain applied.'); return; }
    const message = error instanceof UserError ? error.message : 'Operation failed. Check configuration, credentials, host key/certificate, and server permissions.';
    writeLog(message);
    void vscode.window.showErrorMessage(`WSFTP: ${message}`);
  }
  const key = (root: vscode.WorkspaceFolder, c: Config) => 'credential:' + createHash('sha256').update(JSON.stringify([root.uri.toString(),c.protocol,c.host,c.port,c.username,c.privateKeyPath ?? ''])).digest('hex');
  async function folder(uri?: vscode.Uri): Promise<vscode.WorkspaceFolder | undefined> {
    if (!vscode.workspace.isTrusted) throw new Error('A trusted workspace is required.');
    const selected = uri && vscode.workspace.getWorkspaceFolder(uri);
    if (selected) return selected;
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) throw new Error('Open a workspace folder.');
    return folders.length === 1 ? folders[0] : vscode.window.showWorkspaceFolderPick();
  }
  async function config(root: vscode.WorkspaceFolder): Promise<Config> {
    await ensureConfig(root.uri.fsPath,path.join(context.extensionPath,'wsftp-sync.json'));
    const c = await readConfig(root.uri.fsPath);
    return c;
  }
  function run(root: vscode.WorkspaceFolder, action: () => Promise<void>): Promise<void> {
    const id = root.uri.toString();
    const pending = (queues.get(id) ?? Promise.resolve()).then(action).catch(report);
    queues.set(id,pending);
    void pending.then(() => { if (queues.get(id) === pending) queues.delete(id); });
    return pending;
  }
  async function trustTLS(c: Config, identity: TLSIdentity, interactive: boolean): Promise<boolean> {
    const trustKey = `tls:${c.host.toLowerCase()}:${c.port}`;
    const trusted = context.globalState.get<string>(trustKey);
    if (trusted === identity.fingerprint) return true;
    if (!trusted && !identity.error) return true;
    if (!interactive) throw new TLSNotTrusted('Automatic upload skipped: run a manual operation to verify the FTPS certificate.');
    const detail = `Server: ${c.host}:${c.port}\nSHA256: ${identity.fingerprint}\nSubject: ${identity.subject}\nIssuer: ${identity.issuer}\nValid from: ${identity.validFrom}\nValid until: ${identity.validTo}\n${trusted ? 'The certificate has changed since you last trusted it.\n' : ''}${identity.error ?? ''}\n\nVerify this fingerprint with the server administrator before accepting.`;
    const answer = await vscode.window.showWarningMessage('Verify the FTPS server certificate.',{modal:true,detail},'Trust this certificate');
    if (answer !== 'Trust this certificate') return false;
    await context.globalState.update(trustKey,identity.fingerprint);
    return true;
  }
  async function discover(root: vscode.WorkspaceFolder, c: Config): Promise<void> {
    if (!vscode.workspace.isTrusted) throw new UserError('A trusted workspace is required.');
    const configFile = path.join(root.uri.fsPath,'.vscode','wsftp-sync.json');
    const original = await fs.readFile(configFile,'utf8');
    const password = c.password ?? await vscode.window.showInputBox({title:'WSFTP: password for protocol discovery',password:true,ignoreFocusOut:true});
    if (password === undefined) return;
    const trace = (message: string) => {
      const text = [password,c.passphrase].reduce<string>((value,secret) => secret ? value.split(secret).join('[REDACTED]') : value,message);
      writeLog(text);
      if (c.debug) vscode.debug.activeDebugConsole.appendLine(`${new Date().toISOString()} ${text}`);
    };
    const result = await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:'WSFTP: discovering server protocol',cancellable:true},async (progress,token) => {
      const check = () => { if (token.isCancellationRequested) throw new vscode.CancellationError(); };
      return discoverProtocol(c,password,async hash => {
        check();
        if (c.hostKeySha256) return hash.toLowerCase() === c.hostKeySha256.toLowerCase();
        const hostKey = `host:${c.host}:${c.port}`;
        const trusted = context.globalState.get<string>(hostKey);
        if (trusted) return trusted === hash;
        const accepted = await vscode.window.showWarningMessage(`SFTP discovery: verify the SHA256 fingerprint with the server administrator:\n${hash}`,{modal:true},'Trust');
        check();
        if (accepted !== 'Trust') return false;
        await context.globalState.update(hostKey,hash);
        return true;
      },async () => {
        check();
        return await vscode.window.showWarningMessage('Secure connection attempts failed. FTP is not secure: credentials are sent in plain text and there is a high risk of interception. Allow unencrypted FTP discovery?',{modal:true},'Try unencrypted FTP') === 'Try unencrypted FTP';
      },check,message => { trace(message); progress.report({message:message.startsWith('Discovery: trying') ? message : 'Checking connection...'}); },connect,identity => { check(); return trustTLS(c,identity,true); });
    });
    if (vscode.workspace.textDocuments.some(document => document.uri.fsPath === configFile && document.isDirty)) throw new UserError('Configuration has unsaved changes. Save it and run discovery again.');
    let detail: string;
    try { detail = await applyDiscovery(root.uri.fsPath,original,result); }
    catch (error) { throw new UserError(`Unable to update configuration: ${error instanceof UserError ? error.message : 'Check file permissions and run discovery again.'}`); }
    const message = 'The configuration file has been updated.';
    if (result.protocol === 'ftp') {
      detail += '\n\nThis FTP connection is not secure. Credentials are sent in plain text with a high risk of interception.';
      await vscode.window.showWarningMessage(message,{modal:true,detail},'OK');
    } else await vscode.window.showInformationMessage(message,{modal:true,detail},'OK');
  }
  async function session(root: vscode.WorkspaceFolder, c: Config, action: (t: Transport, sessionLog: (message: string) => void) => Promise<void>, interactive = true): Promise<void> {
    if (!vscode.workspace.isTrusted) throw new Error('Workspace is not trusted.');
    if (c.discover) { await discover(root,c); return; }
    let secret = await context.secrets.get(key(root,c)) ?? (c.privateKeyPath ? c.passphrase : c.password);
    if (!secret && !c.privateKeyPath) {
      if (!interactive) throw new UserError('Automatic upload skipped: save the password using WSFTP: Set credential.');
      secret = await vscode.window.showInputBox({ title:'WSFTP: password (this operation only)',password:true,ignoreFocusOut:true });
      if (secret === undefined) { writeLog('Connection cancelled: password entry cancelled.'); return; }
    }
    if (c.protocol === 'ftp') {
      const ftpKey = 'ftp:' + key(root,c);
      if (!context.workspaceState.get(ftpKey)) {
        if (!interactive) throw new UserError('Automatic upload skipped: first run WSFTP: Upload file to authorize the FTP connection.');
        if (await vscode.window.showWarningMessage('FTP sends credentials and files in plain text. Allow this connection?',{ modal:true },'Allow FTP') !== 'Allow FTP') { writeLog('FTP connection cancelled.'); return; }
        await context.workspaceState.update(ftpKey,true);
      }
    }
    const redact = (message: string) => [secret,c.password,c.passphrase].reduce<string>((text,value) => value ? text.split(value).join('[REDACTED]') : text,message);
    const trace = (message: string) => {
      const text = redact(`[${root.name} | ${c.protocol.toUpperCase()} ${c.host}:${c.port}] ${message}`);
      writeLog(text);
      if (c.debug) vscode.debug.activeDebugConsole.appendLine(`${new Date().toISOString()} ${text}`);
    };
    async function operation<T>(label: string, action: () => Promise<T>): Promise<T> {
      trace(`${label}: started`);
      try { const result = await action(); trace(`${label}: completed`); return result; }
      catch (error) { trace(`${label}: ERROR - ${error instanceof Error ? error.message : String(error)}`); throw error; }
    }
    const connected = await operation(`Connection; user=${c.username}; remote directory=${c.remotePath}; timeout=${c.timeout} ms`, () => connect(c,secret,async hash => {
      if (c.hostKeySha256) return hash.toLowerCase() === c.hostKeySha256.toLowerCase();
      const hostKey = `host:${c.host}:${c.port}`;
      const trusted = context.globalState.get<string>(hostKey);
      if (trusted) return trusted === hash;
      if (!interactive) { trace('Automatic upload skipped: first run WSFTP: Upload file to verify the SFTP host key.'); return false; }
      const accept = await vscode.window.showWarningMessage(`First SFTP connection to ${c.host}:${c.port}. Verify the SHA256 fingerprint (hex) with the server administrator:\n${hash}`,{ modal:true },'Trust');
      if (accept !== 'Trust') return false;
      await context.globalState.update(hostKey,hash); return true;
    },trace,identity => trustTLS(c,identity,interactive)));
    const t: Transport = {
      list: remote => operation(`Reading remote directory ${remote}`, async () => {
        const entries = await connected.list(remote);
        trace(`${remote}: ${entries.length} entries read`);
        return entries;
      }),
      upload: (local,remote) => operation(`Upload ${local} -> ${remote}`, () => connected.upload(local,remote)),
      download: (remote,local) => operation(`Download ${remote} -> ${local}`, () => connected.download(remote,local)),
      close: () => operation('Disconnect', () => connected.close())
    };
    try { await operation('Operation', () => action(t,trace)); } finally { await t.close(); }
  }
  async function transfer(uri: vscode.Uri | undefined, direction: 'upload' | 'download', automatic = false): Promise<void> {
    uri ??= vscode.window.activeTextEditor?.document.uri;
    if (!uri || uri.scheme !== 'file') throw new Error('Select a local file.');
    const root = await folder(uri); if (!root) return;
    const relative = safeRelative(path.relative(root.uri.fsPath,uri.fsPath).split(path.sep).join('/'));
    await run(root,async () => {
      const c = forDirection(await config(root),direction);
      if (c.discover) { if (!automatic) await discover(root,c); return; }
      if (automatic && !c.uploadOnSave) return;
      writeLog(`${automatic ? 'Upload on save' : direction}: ${relative}`);
      if (excluded(relative,c.exclude,c.legacyIgnore)) { writeLog(`File skipped by exclusions: ${relative}`); if (!automatic) void vscode.window.showInformationMessage('WSFTP: file excluded by configuration.'); return; }
      const local = await localPath(root.uri.fsPath,relative);
      if (direction === 'upload' && !(await fs.stat(local)).isFile()) throw new Error('Select a file.');
      if (direction === 'download') {
        if (vscode.workspace.textDocuments.some(d => d.uri.fsPath === local && d.isDirty)) throw new Error('Save or close the modified file before downloading.');
        if (await vscode.window.showWarningMessage(`Overwrite local file ${relative}?`,{modal:true},'Download') !== 'Download') { writeLog(`Download cancelled: ${relative}`); return; }
      }
      await session(root,c,async (t,writeLog) => {
        writeLog(`Checking remote file: ${relative}`);
        const remote = await inspectRemote(t,c,relative);
        writeLog(`${relative}: ${remote ? 'remote file exists' : 'remote file is missing'}`);
        if (direction === 'download' && !remote) throw new Error('Remote file is missing.');
        if (direction === 'upload') await t.upload(local,remoteFile(c,relative));
        else await download(t,c,root.uri.fsPath,relative);
        writeLog(`${direction} completed: ${relative}`);
        if (direction === 'upload') {
          showTransferStatus(direction,relative);
        }
        if (!automatic) void vscode.window.showInformationMessage(`WSFTP: ${direction} completed.`);
      },!automatic);
    });
  }
  function command(id: string, action: (...args: any[]) => Promise<unknown> | unknown): void {
    context.subscriptions.push(vscode.commands.registerCommand(id,async (...args: any[]) => {
      try { await action(...args); } catch(error) { report(error); }
    }));
  }
  command('wsftp.log',() => log.show());
  command('wsftp.configure',async () => {
    const root = await folder(); if (!root) return;
    const file = await findConfig(root.uri.fsPath) ?? path.join(root.uri.fsPath,'.vscode','wsftp-sync.json');
    await fs.mkdir(path.dirname(file),{recursive:true});
    try { await ensureConfig(root.uri.fsPath,path.join(context.extensionPath,'wsftp-sync.json')); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    await vscode.window.showTextDocument(vscode.Uri.file(file));
  });
  command('wsftp.credentials',async () => {
    const root = await folder(); if (!root) return;
    const c = await config(root);
    const secret = await vscode.window.showInputBox({title:c.privateKeyPath ? 'WSFTP: private key passphrase' : 'WSFTP: server password',password:true,ignoreFocusOut:true});
    if (secret !== undefined) { await context.secrets.store(key(root,c),secret); void vscode.window.showInformationMessage('WSFTP: credential saved in VS Code secure storage.'); }
  });
  command('wsftp.forget',async () => { const root = await folder(); if (root) { await context.secrets.delete(key(root,await config(root))); void vscode.window.showInformationMessage('WSFTP: credential removed.'); } });
  command('wsftp.upload',(uri?: vscode.Uri) => transfer(uri,'upload'));
  command('wsftp.download',(uri?: vscode.Uri) => transfer(uri,'download'));
  command('wsftp.uploadRoot',() => synchronize('upload'));
  command('wsftp.downloadRoot',() => synchronize('download'));
  command('wsftp.uploadDir',(uri?: vscode.Uri) => synchronize('upload',uri,true));
  command('wsftp.downloadDir',(uri?: vscode.Uri) => synchronize('download',uri,true));
  command('wsftp.sync',async () => {
    const direction = await vscode.window.showQuickPick(['upload','download'],{title:'WSFTP: synchronization direction'});
    if (direction) await synchronize(direction as 'upload' | 'download');
  });
  async function synchronize(direction: 'upload' | 'download', uri?: vscode.Uri, directory = false): Promise<void> {
    if (!vscode.workspace.isTrusted) throw new UserError('Workspace is not trusted.');
    if (directory && (!uri || uri.scheme !== 'file')) throw new UserError("Select a directory in Explorer.");
    const target = uri ?? vscode.window.activeTextEditor?.document.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
    const root = (target && vscode.workspace.getWorkspaceFolder(target))
      ?? (!directory ? vscode.workspace.workspaceFolders?.[0] : undefined);
    if (!root) throw new UserError('Open a workspace folder.');
    const scope = directory ? path.relative(root.uri.fsPath,uri!.fsPath).split(path.sep).join('/') : '';
    if (scope) {
      const selectedPath = await localPath(root.uri.fsPath,safeRelative(scope));
      if (!(await fs.stat(selectedPath)).isDirectory()) throw new UserError('Select a directory.');
    }
    await run(root,async () => {
      const c = forDirection(await config(root),direction);
      await session(root,c,async (t,writeLog) => {
        await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:'WSFTP: synchronization',cancellable:true},async (progress,token) => {
          const check = () => { if (token.isCancellationRequested) throw new vscode.CancellationError(); };
          progress.report({message:'Scanning local and remote files...'});
          writeLog(`Synchronization ${direction}: ${scope || 'root'}; scanning local and remote files`);
          const local = await scanLocal(root.uri.fsPath,c,check,scope,writeLog);
          writeLog(`Local scan completed: ${local.size} files`);
          const remote = await scanRemote(t,c,check,scope);
          writeLog(`Remote scan completed: ${remote.size} files; comparing size and CRC32`);
          const changes = await planSync(t,c,root.uri.fsPath,local,remote,direction,check,writeLog);
          writeLog(`Comparison completed: ${changes.length} files to transfer`);
          const changed = new Map(changes.map(change => [change.relative,change.reason]));
          for (const relative of (direction === 'upload' ? local : remote).keys()) writeLog(`${relative}: ${changed.has(relative) ? (changed.get(relative) === 'new' ? 'new' : 'modified') : 'synchronized'}`);
          check();
          if (!changes.length) { void vscode.window.showInformationMessage('WSFTP: no files to transfer: files are synchronized.'); return; }
          const apply = {title:'Apply'};
          const cancel = {title:'Cancel',isCloseAffordance:true};
          const detail = changes.map(change => `${change.reason === 'new' ? 'NEW' : 'MODIFIED'}  ${change.relative}`).join('\n');
          const answer = await vscode.window.showWarningMessage(
            `WSFTP: ${direction} - ${scope || 'root'} - ${changes.length} files`,
            {modal:true,detail:`${detail}\n\nApply transfers all listed files and overwrites existing files. Comparison uses size and CRC32; no files are deleted.`},apply,cancel);
          check();
          if (answer !== apply) { writeLog('Synchronization cancelled in preview; no files transferred.'); return; }
          let completed = 0;
          for (const change of changes) {
            check();
            writeLog(`Checking before transfer: ${change.relative}`);
            const currentRules = forDirection(await config(root),direction);
            if (excluded(change.relative,currentRules.exclude,currentRules.legacyIgnore)) throw new UserError('Exclusions changed after preview. Run synchronization again.');
            const file = await localPath(root.uri.fsPath,change.relative);
            const baseline = local.get(change.relative);
            let current;
            try { current = await fs.stat(file); } catch(e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
            if (Boolean(current) !== Boolean(baseline) || (current && baseline && (current.size !== baseline.size || current.mtimeMs !== baseline.mtime))) throw new UserError('Local file changed after preview. Run synchronization again.');
            if (vscode.workspace.textDocuments.some(d => d.uri.fsPath === file && d.isDirty)) throw new UserError('An open file has unsaved changes. Save before synchronizing.');
            // Revalidate the remote file after the user has reviewed the preview.
            const previous = remote.get(change.relative);
            const now = await inspectRemote(t,c,change.relative);
            if (Boolean(now) !== Boolean(previous) || (now && previous && (now.size !== previous.size || now.mtime !== previous.mtime))) throw new UserError('Remote file changed after preview. Run synchronization again.');
            if (direction === 'upload') await t.upload(file,remoteFile(c,change.relative));
            else await download(t,c,root.uri.fsPath,change.relative,change.source.mtime);
            completed++;
            showTransferStatus(direction,`${completed}/${changes.length}`);
            writeLog(`${direction} completed ${completed}/${changes.length}: ${change.relative}`);
            progress.report({increment:100/changes.length,message:`${completed}/${changes.length}: ${change.relative}`});
          }
          writeLog(`Synchronization completed: ${completed} files transferred`);
          void vscode.window.showInformationMessage(`WSFTP: ${completed} files transferred.`);
        });
      });
    });
  }
  const initialize = async () => {
    if (!vscode.workspace.isTrusted) return;
    await Promise.all((vscode.workspace.workspaceFolders ?? []).map(root => ensureConfig(root.uri.fsPath,path.join(context.extensionPath,'wsftp-sync.json')).catch(report)));
  };
  if (vscode.workspace.onDidChangeWorkspaceFolders) context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => { void initialize(); }));
  if (vscode.workspace.onDidGrantWorkspaceTrust) context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(() => { void initialize(); }));
  if (vscode.workspace.createFileSystemWatcher) {
    const watcher = vscode.workspace.createFileSystemWatcher('**/.vscode');
    context.subscriptions.push(watcher,watcher.onDidCreate(() => { void initialize(); }));
  }
  await initialize();
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(async document => {
    if (document.uri.scheme !== 'file' || !vscode.workspace.isTrusted) return;
    const root = vscode.workspace.getWorkspaceFolder(document.uri); if (!root) return;
    await ensureConfig(root.uri.fsPath,path.join(context.extensionPath,'wsftp-sync.json')).then(() => findConfig(root.uri.fsPath)).then(async file => {
      if (!file) return;
      const c = await config(root);
      if (c.discover) {
        if (path.resolve(document.uri.fsPath) === path.resolve(file)) await run(root,() => discover(root,c));
        return;
      }
      if (c.uploadOnSave) await transfer(document.uri,'upload',true);
    }).catch(report);
  }));
}
export function deactivate(): void {}
