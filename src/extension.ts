import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Config, excluded, remoteFile, safeRelative, UserError, forDirection } from './core';
import { operationError, OperationStage } from './errors';
import { SyncCache } from './cache';
import { ChangeMonitor, CheckLoop } from './monitor';
import { SyncMode, rulesForMode, scanTrees, buildSyncPlan, validateSnapshot, applySyncAction } from './sync';
import { disposeRegex } from './ignore';
import { discoverProtocol } from './discovery';
import { findConfig, readConfig, applyDiscovery, ensureConfig, InactiveConfig } from './config';
import { connect, Transport, inspectRemote, TLSIdentity, TLSNotTrusted } from './transport';
import { localPath, scanLocal, scanRemote, download, planSync } from './files';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const log = vscode.window.createOutputChannel('WSFTP Sync');
  const logTime = () => {
    const now = new Date();
    return `[${[now.getHours(),now.getMinutes(),now.getSeconds()].map(value => String(value).padStart(2,'0')).join(':')}]`;
  };
  const writeLog = (message: string) => {
    const line = `${logTime()} ${message.replace(/[\r\n\x00-\x1f]/g, ' ')}`;
    log.appendLine(line);
  };
  const queues = new Map<string, Promise<void>>();
  const monitors = new Map<string, { monitor: ChangeMonitor; status: vscode.StatusBarItem; due: number; generation: number; signature?: string }>();
  let closeAutoNotice: (() => void) | undefined;
  let disposed = false;
  const autosyncOverrides = new Map<string, boolean>();
  let settingsRevision = 0;
  const autosyncIntervals = new Map<string, number>();
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
  async function cacheFor(root: vscode.WorkspaceFolder, c: Config): Promise<SyncCache> {
    const cache = new SyncCache(context.globalStorageUri ? SyncCache.filename(context.globalStorageUri.fsPath,root.uri.fsPath,c) : undefined);
    await cache.load();
    return cache;
  }
  async function saveCache(cache: SyncCache): Promise<void> {
    try { await cache.save(); } catch { writeLog('Unable to save synchronization cache; the next scan may repeat content verification.'); }
  }
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
  function run(root: vscode.WorkspaceFolder, action: () => Promise<void>, background = false): Promise<void> {
    const id = root.uri.toString();
    const state = monitors.get(id);
    if (state && !background) {
      state.generation++;
      state.due = Date.now()+1000;
      state.status.text = '$(sync) WSFTP: waiting for next check';
      state.status.tooltip = 'The previous check is stale. Click to open a fresh bidirectional preview.';
    }
    const pending = (queues.get(id) ?? Promise.resolve()).then(action).catch(background ? error => {
      if (state) {
        state.monitor.failed();
        if (monitors.get(id) === state && !(error instanceof vscode.CancellationError)) {
          state.status.text = '$(warning) WSFTP: check unavailable';
          state.status.tooltip = 'Automatic check failed or needs connection setup. Run a manual synchronization; see WSFTP logs.';
        }
      }
      if (!(error instanceof vscode.CancellationError)) writeLog(error instanceof UserError ? error.message : 'Automatic check unavailable. Check connection and configuration using a manual synchronization.');
    } : report);
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
      if (c.debug) vscode.debug.activeDebugConsole.appendLine(`${logTime()} ${text}`);
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
  async function activity<T>(title: string, enabled: boolean, action: (progress: vscode.Progress<{message?: string}>) => Promise<T>): Promise<T> {
    if (!enabled) return action({report() {}});
    return vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title,cancellable:false},action);
  }
  async function session(root: vscode.WorkspaceFolder, c: Config, action: (t: Transport, sessionLog: (message: string) => void) => Promise<void>, interactive = true): Promise<void> {
    if (!vscode.workspace.isTrusted) throw new Error('Workspace is not trusted.');
    if (c.discover) { if (!interactive) throw new UserError('Automatic check skipped: complete protocol discovery manually first.'); await discover(root,c); return; }
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
      const text = redact(message);
      writeLog(text);
      if (c.debug) vscode.debug.activeDebugConsole.appendLine(`${logTime()} ${text}`);
    };
    async function operation<T>(label: string, action: () => Promise<T>, stage?: OperationStage): Promise<T> {
      trace(`${label}: started`);
      try {
        const result = stage === 'connect'
          ? await activity(`WSFTP: Connection to ${c.host}:${c.port}`,interactive,async progress => {
            progress.report({message:`Connecting and logging in (${c.protocol.toUpperCase()})...`});
            return action();
          })
          : await action();
        trace(`${label}: completed`);
        return result;
      }
      catch (error) {
        trace(`${label}: ERROR - ${error instanceof Error ? error.message : String(error)}`);
        if (error instanceof vscode.CancellationError) throw error;
        throw stage ? operationError(stage,error) : error;
      }
    }
    const connected = await operation(`Connection; user=${c.username}; remote directory=${c.remote_path}; timeout=${c.timeout} ms`, () => connect(c,secret,async hash => {
      if (c.hostKeySha256) return hash.toLowerCase() === c.hostKeySha256.toLowerCase();
      const hostKey = `host:${c.host}:${c.port}`;
      const trusted = context.globalState.get<string>(hostKey);
      if (trusted) return trusted === hash;
      if (!interactive) { trace('Automatic upload skipped: first run WSFTP: Upload file to verify the SFTP host key.'); return false; }
      const accept = await vscode.window.showWarningMessage(`First SFTP connection to ${c.host}:${c.port}. Verify the SHA256 fingerprint (hex) with the server administrator:\n${hash}`,{ modal:true },'Trust');
      if (accept !== 'Trust') return false;
      await context.globalState.update(hostKey,hash); return true;
    },trace,identity => trustTLS(c,identity,interactive)), 'connect');
    const t: Transport = {
      list: remote => operation(`Reading remote directory ${remote}`, async () => {
        const entries = await connected.list(remote);
        trace(`${remote}: ${entries.length} entries read`);
        return entries;
      }, 'list'),
      upload: (local,remote) => operation(`Upload ${local} -> ${remote}`, () => connected.upload(local,remote), 'upload'),
      download: (remote,local) => operation(`Download ${remote} -> ${local}`, () => connected.download(remote,local), 'download'),
      mkdir: remote => operation(`Create remote directory ${remote}`, () => connected.mkdir(remote), 'mkdir'),
      remove: (remote,directory) => operation(`Delete remote ${directory ? 'directory' : 'file'} ${remote}`, () => connected.remove(remote,directory), 'remove'),
      close: () => operation('Disconnect', () => connected.close(), 'close')
    };
    let failed = false;
    try { await operation('Operation', () => action(t,trace)); }
    catch (error) { failed = true; throw error; }
    finally {
      try { await t.close(); } catch (error) { if (!failed) throw error; }
    }
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
      await session(root,c,async (t,writeLog) => activity(`WSFTP: ${direction === 'upload' ? 'Upload' : 'Download'} ${relative}`,!automatic,async progress => {
        progress.report({message:'Checking remote file...'});
        writeLog(`Checking remote file: ${relative}`);
        const remote = await inspectRemote(t,c,relative);
        writeLog(`${relative}: ${remote ? 'remote file exists' : 'remote file is missing'}`);
        if (direction === 'download' && !remote) throw new Error('Remote file is missing.');
        const cache = await cacheFor(root,c);
        cache.forget(relative);
        await cache.save();
        progress.report({message:direction === 'upload' ? 'Uploading file...' : 'Downloading file...'});
        if (direction === 'upload') await t.upload(local,remoteFile(c,relative));
        else await download(t,c,root.uri.fsPath,relative);
        writeLog(`${direction} completed: ${relative}`);
        if (direction === 'upload') {
          showTransferStatus(direction,relative);
        }
        if (!automatic) void vscode.window.showInformationMessage(`WSFTP: ${direction} completed.`);
      }),!automatic);
    });
  }
  function command(id: string, action: (...args: any[]) => Promise<unknown> | unknown): void {
    context.subscriptions.push(vscode.commands.registerCommand(id,async (...args: any[]) => {
      try { await action(...args); } catch(error) { report(error); }
    }));
  }
  command('wsftp.log',() => log.show());
  command('wsftp.clearCache',async () => {
    const root = await folder(); if (!root) return;
    await run(root,async () => {
      const c = await config(root);
      const cache = await cacheFor(root,c);
      cache.clearHashes();
      await cache.save();
      void vscode.window.showInformationMessage('WSFTP: cache cleared. The next synchronization will verify file contents again.');
    });
  });
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
  command('wsftp.mirrorLocal',() => synchronizeMode('local'));
  command('wsftp.mirrorRemote',() => synchronizeMode('remote'));
  command('wsftp.syncUploadRoot',() => synchronizeMode('local',undefined,true));
  command('wsftp.syncDownloadRoot',() => synchronizeMode('remote',undefined,true));
  command('wsftp.bidirectional',() => synchronizeMode('both'));
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
          const cache = await cacheFor(root,c);
          if (cache.needsInitialization) {
            log.show(true);
            writeLog('Creating the local cache. This may take a few minutes.');
          }
          progress.report({message:'Scanning local and remote files...'});
          writeLog(`Synchronization ${direction}: ${scope || 'root'}; scanning local and remote files`);
          const local = await scanLocal(root.uri.fsPath,c,check,scope,writeLog);
          writeLog(`Local scan completed: ${local.size} files`);
          const remote = await scanRemote(t,c,check,scope);
          writeLog(`Remote scan completed: ${remote.size} files; comparing size and CRC32`);
          cache.prune(local,remote,c,scope);
          progress.report({message:cache.needsInitialization ? 'Creating the local cache. This may take a few minutes.' : 'Comparing files and synchronization history...'});
          const changes = await planSync(t,c,root.uri.fsPath,local,remote,direction,check,writeLog,cache);
          await saveCache(cache);
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
            {modal:true,detail:`${detail}\n\nApply transfers all listed files and overwrites existing files. Comparison uses size and cached CRC32; no files are deleted.`},apply,cancel);
          check();
          if (answer !== apply) { writeLog('Synchronization cancelled in preview; no files transferred.'); return; }
          // Persist invalidation in batches before any transfer can partially write.
          for (const change of changes) cache.forget(change.relative);
          await cache.save();
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
  async function synchronizeMode(mode: SyncMode, selectedRoot?: vscode.WorkspaceFolder, transferOnly = false): Promise<void> {
    const target = vscode.window.activeTextEditor?.document.uri;
    const root = selectedRoot ?? (target && vscode.workspace.getWorkspaceFolder(target)) ?? vscode.workspace.workspaceFolders?.[0];
    if (!root) throw new UserError('Open a workspace folder.');
    await run(root,async () => {
      const original = await config(root);
      const c = rulesForMode(original,mode);
      const label = transferOnly ? (mode === 'local' ? 'Root upload' : 'Root download') : mode === 'local' ? 'Local dominance' : mode === 'remote' ? 'Remote dominance' : 'Bidirectional';
      await session(root,c,async (t,trace) => {
        await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:`WSFTP: ${label}`,cancellable:true},async (progress,token) => {
          const check = () => { if (token.isCancellationRequested) throw new vscode.CancellationError(); };
          const cache = await cacheFor(root,c);
          const initializing = cache.needsInitialization;
          if (initializing) {
            log.show(true);
            trace('Creating the local cache. This may take a few minutes.');
          }
          progress.report({message:'Scanning local and remote files...'});
          trace('Scanning local and remote files...');
          const snapshot = await scanTrees(t,root.uri.fsPath,c,check);
          cache.prune(snapshot.local,snapshot.remote,c,'');
          progress.report({message:cache.needsInitialization ? 'Creating the local cache. This may take a few minutes.' : 'Comparing files and synchronization history...'});
          const actions = (await buildSyncPlan(t,root.uri.fsPath,c,mode,snapshot,cache,check,initializing ? trace : undefined)).filter(action => !transferOnly || !action.kind.startsWith('delete-'));
          await cache.save();
          if (initializing) trace('Local cache created. File comparison completed.');
          const pending = actions.filter(a => a.kind !== 'conflict');
          const conflicts = actions.length-pending.length;
          const deletions = pending.filter(a => a.kind.startsWith('delete-')).length;
          const detail = actions.map(a => `${a.kind.toUpperCase()}  ${a.relative}${a.directory ? '/' : ''}${a.note && a.kind === 'conflict' ? ' ? '+a.note : ''}`).join('\n');
          trace(`${label}: ${pending.length} operations, ${deletions} deletions, ${conflicts} conflicts.\n${detail}`);
          check();
          if (!actions.length) { void vscode.window.showInformationMessage('WSFTP: no operations needed.'); return; }
          if (!pending.length) {
            await vscode.window.showWarningMessage(`WSFTP: ${conflicts} conflicts; no files changed.`,{modal:true,detail:`${detail}\n\nResolve the conflicting files manually or use a dominance preview to choose a side.`},'OK');
            return;
          }
          const apply = {title:'Apply'}, cancel = {title:'Cancel',isCloseAffordance:true};
          const answer = await vscode.window.showWarningMessage(`WSFTP: ${label} ? ${pending.length} operations, ${deletions} deletions, ${conflicts} conflicts`,
            {modal:true,detail:`${detail}\n\nApply executes the listed copies and directory operations, including ${deletions} deletions. Existing destination files may be overwritten. Conflicts are skipped. Deletions cannot be undone by this extension.`},apply,cancel);
          check();
          if (answer !== apply) { trace('Preview cancelled; no operations applied.'); return; }
          const checkConfig = async () => {
            if (JSON.stringify(await config(root)) !== JSON.stringify(original)) throw new UserError('Configuration changed after preview. Run synchronization again.');
          };
          await checkConfig();
          await validateSnapshot(t,root.uri.fsPath,c,snapshot,check);
          // Persist conservative history before any write; checkpoint completed
          // operations in batches instead of rewriting a large cache per file.
          for (const action of pending) if (action.kind === 'upload' || action.kind === 'download') cache.forget(action.relative);
          await cache.save();
          let completed = 0;
          try {
            for (const action of pending) {
              check(); await checkConfig();
              const file = await localPath(root.uri.fsPath,action.relative);
              if (vscode.workspace.textDocuments.some(d => d.isDirty && (d.uri.fsPath === file || (action.directory && d.uri.fsPath.startsWith(file+path.sep))))) throw new UserError('An affected file has unsaved changes. Save before synchronizing.');
              await applySyncAction(t,root.uri.fsPath,c,action,snapshot,cache,check);
              completed++;
              if (completed % 100 === 0) await cache.save();
              trace(`${action.kind}: ${action.relative}; completed ${completed}/${pending.length}`);
              progress.report({increment:100/pending.length,message:`${completed}/${pending.length}: ${action.relative}`});
            }
          } finally { await cache.save(); }
          void vscode.window.showInformationMessage(`WSFTP: ${completed} operations completed; ${conflicts} conflicts skipped.`);
        });
      });
    });
  }
  function autoSettings(root: vscode.WorkspaceFolder): { enabled: boolean; seconds: number } {
    const settings = vscode.workspace.getConfiguration?.('wsftp',root.uri);
    const seconds = autosyncIntervals.get(root.uri.toString()) ?? 120;
    return {enabled:autosyncOverrides.get(root.uri.toString()) ?? (settings?.get<boolean>('autoCheck.enabled',false) === true),seconds};
  }
  async function refreshConfigSettings(): Promise<void> {
    const revision = ++settingsRevision;
    const values = await Promise.all((vscode.workspace.workspaceFolders ?? []).map(async root => {
      try { const c = await readConfig(root.uri.fsPath); return [root.uri.toString(),c.autosync,c.autosync_secs] as const; }
      catch { return [root.uri.toString(),false,120] as const; }
    }));
    if (disposed || revision !== settingsRevision) return;
    autosyncOverrides.clear();
    const previousIntervals = new Map(autosyncIntervals);
    autosyncIntervals.clear();
    for (const [id,value,seconds] of values) {
      if (value !== undefined) autosyncOverrides.set(id,value);
      autosyncIntervals.set(id,seconds);
      const state = monitors.get(id);
      if (state && previousIntervals.get(id) !== seconds) state.due = Date.now();
    }
    refreshMonitors();
  }
  function refreshMonitors(): void {
    const enabled = new Set<string>();
    if (!disposed && vscode.workspace.isTrusted) {
      for (const root of vscode.workspace.workspaceFolders ?? []) {
        if (!autoSettings(root).enabled) continue;
        const id = root.uri.toString(); enabled.add(id);
        if (!monitors.has(id)) {
          const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left,10);
          status.name = `WSFTP automatic check: ${root.name}`;
          status.text = '$(watch) WSFTP: waiting for first check';
          status.tooltip = `${root.name}: periodic checks enabled. Click for a bidirectional preview.`;
          status.command = {command:'wsftp.reviewAutoCheck',title:'Review synchronization changes',arguments:[root.uri]};
          status.show();
          monitors.set(id,{monitor:new ChangeMonitor(),status,due:Date.now(),generation:0});
        }
      }
    }
    for (const [id,state] of monitors) if (!enabled.has(id)) { state.generation++; closeAutoNotice?.(); state.status.dispose(); monitors.delete(id); }
  }
  async function automaticChecks(): Promise<void> {
    await refreshConfigSettings();
    for (const root of vscode.workspace.workspaceFolders ?? []) {
      const id = root.uri.toString(), state = monitors.get(id);
      if (!state || queues.has(id) || state.due > Date.now()) continue;
      closeAutoNotice?.();
      const generation = state.generation;
      const check = () => {
        if (disposed || !vscode.workspace.isTrusted || monitors.get(id) !== state || state.generation !== generation || !autoSettings(root).enabled) throw new vscode.CancellationError();
      };
      state.due = Date.now()+autoSettings(root).seconds*1000;
      await run(root,async () => {
        check();
        // Background work must not create configuration or open trust/password prompts.
        const c = await readConfig(root.uri.fsPath);
        const signature = createHash('sha256').update(JSON.stringify(c)).digest('hex');
        if (state.signature !== signature) { state.monitor = new ChangeMonitor(); state.signature = signature; }
        state.status.text = '$(sync~spin) WSFTP: checking';
        await session(root,c,async (t,trace) => {
          const snapshot = await scanTrees(t,root.uri.fsPath,c,check);
          const cache = await cacheFor(root,c);
          cache.prune(snapshot.local,snapshot.remote,c,'');
          const actions = await buildSyncPlan(t,root.uri.fsPath,c,'both',state.monitor.stableSnapshot(snapshot),cache,check);
          check();
          if (JSON.stringify(await readConfig(root.uri.fsPath)) !== JSON.stringify(c)) throw new vscode.CancellationError();
          await cache.save(); check();
          const summary = state.monitor.accept(snapshot,actions);
          const counts = `${summary.downloads} to download, ${summary.uploads} to upload, ${summary.conflicts} conflicts`;
          state.status.text = `$(cloud) WSFTP ${root.name}: ?${summary.downloads} ?${summary.uploads} !${summary.conflicts}${summary.waiting ? ' $(watch)' : ''}`;
          state.status.tooltip = `${counts}. ${summary.waiting ? 'Some remote paths are waiting for two stable checks. ' : ''}Last checked: ${new Date().toLocaleTimeString()}. Click to review; no transfers have been applied.`;
          trace(`Automatic check: ${counts}; ${summary.waiting} remote paths awaiting stability.`);
          if (summary.fresh) {
            closeAutoNotice?.();
            // Information messages with actions cannot be dismissed through the VS Code API.
            // Completing notification progress closes the transient notice without retaining it.
            void vscode.window.withProgress({location:vscode.ProgressLocation.Notification,
              title:`WSFTP: ${root.name}: ${counts}. Click the WSFTP status bar item to review changes.`,cancellable:false},() => new Promise<void>(resolve => {
              const close = () => {
                clearTimeout(timer);
                if (closeAutoNotice === close) closeAutoNotice = undefined;
                resolve();
              };
              const timer = setTimeout(close,5000);
              closeAutoNotice = close;
            }));
          }
        },false);
      },true);
      // An explicit command may have requested an earlier refresh while checking.
      if (state.generation === generation) state.due = Date.now()+autoSettings(root).seconds*1000;
    }
  }
  command('wsftp.reviewAutoCheck',async (uri: vscode.Uri) => {
    closeAutoNotice?.();
    const root = vscode.workspace.getWorkspaceFolder(uri);
    if (root) await synchronizeMode('both',root);
  });
  command('wsftp.toggleAutoCheck',async () => {
    const root = await folder(); if (!root) return;
    await run(root,async () => {
      await config(root);
      const file = (await findConfig(root.uri.fsPath))!;
      if (vscode.workspace.textDocuments.some(d => d.uri.fsPath === file && d.isDirty)) throw new UserError('Save the configuration before toggling automatic checks.');
      const original = await fs.readFile(file,'utf8');
      await refreshConfigSettings();
      const enabled = autoSettings(root).enabled;
      const value = JSON.parse(original);
      value.autosync = !enabled;
      const indentation = original.match(/\n([ \t]+)"/)?.[1] ?? '  ';
      const newline = original.includes('\r\n') ? '\r\n' : '\n';
      if (await fs.readFile(file,'utf8') !== original) throw new UserError('Configuration changed. Toggle automatic checks again.');
      await fs.writeFile(file,(JSON.stringify(value,null,indentation)+'\n').replace(/\n/g,newline));
      await refreshConfigSettings();
      void vscode.window.showInformationMessage(`WSFTP: automatic checks ${enabled ? 'disabled' : 'enabled'}.`);
    });
  });
  if (vscode.workspace.onDidChangeConfiguration) context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('wsftp.autoCheck')) {
      for (const state of monitors.values()) { state.generation++; state.due = Date.now(); }
      refreshMonitors();
    }
  }));
  const checkLoop = new CheckLoop(automaticChecks,() => Math.max(1000,Math.min(15000,...[...monitors.values()].map(state => state.due-Date.now()))));
  context.subscriptions.push({dispose:() => {
    disposed = true; closeAutoNotice?.(); checkLoop.dispose();
    for (const state of monitors.values()) { state.generation++; state.status.dispose(); }
    monitors.clear();
  }});
  await refreshConfigSettings(); checkLoop.start();
  const initialize = async () => {
    if (!vscode.workspace.isTrusted) return;
    await Promise.all((vscode.workspace.workspaceFolders ?? []).map(root => ensureConfig(root.uri.fsPath,path.join(context.extensionPath,'wsftp-sync.json')).catch(report)));
  };
  if (vscode.workspace.onDidChangeWorkspaceFolders) context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => { void refreshConfigSettings(); void initialize(); }));
  if (vscode.workspace.onDidGrantWorkspaceTrust) context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(() => { void refreshConfigSettings(); void initialize(); }));
  if (vscode.workspace.createFileSystemWatcher) {
    const watcher = vscode.workspace.createFileSystemWatcher('**/.vscode');
    context.subscriptions.push(watcher,watcher.onDidCreate(() => { void refreshConfigSettings(); void initialize(); }));
  }
  await initialize();
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(async document => {
    if (document.uri.scheme !== 'file' || !vscode.workspace.isTrusted) return;
    const root = vscode.workspace.getWorkspaceFolder(document.uri); if (!root) return;
    if (path.resolve(document.uri.fsPath) === path.join(root.uri.fsPath,'.vscode','wsftp-sync.json')) {
      const state = monitors.get(root.uri.toString());
      if (state) { state.generation++; state.due = Date.now(); }
      await refreshConfigSettings();
    }
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
