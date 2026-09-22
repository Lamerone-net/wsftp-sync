import { initializeRegex } from './ignore';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { Config, configFields, parseConfig, UserError } from './core';

export class InactiveConfig extends Error {}

export async function ensureConfig(root: string, template: string): Promise<void> {
  const directory = path.join(root,'.vscode');
  try { if (!(await fs.stat(directory)).isDirectory()) return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  const destination = path.join(directory,'wsftp-sync.json');
  try { await fs.lstat(destination); return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let legacyText: string | undefined;
  try { legacyText = await fs.readFile(path.join(directory,'ftp-sync.json'),'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new UserError('Unable to import .vscode/ftp-sync.json. Check file permissions.');
  }
  if (legacyText !== undefined) {
    let legacy: Record<string, unknown>;
    try {
      legacy = JSON.parse(legacyText.replace(/^\uFEFF/,''));
      if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) throw new Error();
    } catch { throw new UserError('Cannot import .vscode/ftp-sync.json: expected a valid JSON object. Check the JSON syntax.'); }
    const value = JSON.parse(await fs.readFile(template,'utf8')) as Record<string, unknown>;
    for (const field of configFields) {
      if (field !== 'discover' && Object.hasOwn(legacy,field)) value[field] = legacy[field];
    }
    const aliases: Record<string,string> = {login:'username',pass:'password',remotePath:'remote_path',path:'remote_path',uploadOnSave:'upload_on_save'};
    const importedFields = new Set(Object.keys(legacy));
    for (const [oldName,newName] of Object.entries(aliases)) {
      if (!importedFields.has(newName) && Object.hasOwn(legacy,oldName)) {
        value[newName] = legacy[oldName];
        importedFields.add(newName);
      }
    }
    if (typeof value.port === 'string' && /^\d+$/.test(value.port)) value.port = Number(value.port);
    if (value.remote_path === '.' || value.remote_path === './') value.remote_path = '/';
    if (!Object.hasOwn(legacy,'ignore_always')) {
      const patterns = legacy.ignore ?? legacy.ignored;
      if (patterns !== undefined) {
        if (!Array.isArray(patterns) || !patterns.every(pattern => typeof pattern === 'string' && pattern.length > 0)) {
          throw new UserError('Cannot import .vscode/ftp-sync.json: ignore/ignored must be a list of nonempty regular expressions.');
        }
        value.ignore_always = patterns.map(pattern => `/${pattern}/`);
      }
    }
    value.discover = true;
    await initializeRegex();
    try {
      // Empty credentials remain editable placeholders, as in the bundled template.
      parseConfig({...value,host:value.host || 'placeholder',username:value.username || 'placeholder'});
    } catch { throw new UserError('Cannot import .vscode/ftp-sync.json: incompatible settings. Check field types, port, absolute remote path, and ignore expressions.'); }
    try { await fs.writeFile(destination,JSON.stringify(value,null,2)+'\n',{encoding:'utf8',flag:'wx'}); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    return;
  }
  try { await fs.copyFile(template,path.join(directory,'wsftp-sync.json'),constants.COPYFILE_EXCL); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
}

export async function findConfig(root: string): Promise<string | undefined> {
  const file = path.join(root, '.vscode', 'wsftp-sync.json');
  try { await fs.access(file); return file; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new UserError('Unable to read .vscode/wsftp-sync.json. Check file permissions.');
    return undefined;
  }
}

export async function readConfig(root: string): Promise<Config> {
  const file = await findConfig(root);
  if (!file) throw new UserError('Configuration missing: run WSFTP: Create/open configuration (.vscode/wsftp-sync.json).');
  let text: string;
  try { text = await fs.readFile(file, 'utf8'); }
  catch { throw new UserError(`Unable to read configuration file ${path.relative(root,file).split(path.sep).join('/')}. Check file permissions.`); }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new UserError(`The configuration JSON is invalid: ${path.relative(root,file).split(path.sep).join('/')}. Check the JSON syntax.`); }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const field of ['username','password','host']) {
      const setting = (value as Record<string,unknown>)[field];
      if (setting === undefined || setting === null || (typeof setting === 'string' && !setting.trim())) throw new InactiveConfig();
    }
  }
  if (value && typeof value === 'object' && ['ignore_always','ignore_upload','ignore_download'].some(name => {
    const patterns = (value as Record<string,unknown>)[name];
    return Array.isArray(patterns) && patterns.some(pattern => typeof pattern === 'string' && pattern.startsWith('/'));
  })) await initializeRegex();
  try { return parseConnectionConfig(value); }
  catch (error) { throw new UserError(`${path.relative(root,file).split(path.sep).join('/')}: ${(error as Error).message}`); }
}

export function parseConnectionConfig(value: unknown): Config {
  return parseConfig(value);
}

export async function applyDiscovery(root: string, original: string, result: {protocol: Config['protocol']; passive?: boolean}): Promise<string> {
  const file = path.join(root,'.vscode','wsftp-sync.json');
  if (await fs.readFile(file,'utf8') !== original) throw new UserError('Configuration changed during discovery. Run discovery again.');
  const value = JSON.parse(original);
  value.discover = false;
  value.protocol = result.protocol;
  value.passive = result.protocol === 'sftp' ? false : result.passive;
  const addedRemotePath = value.remote_path === undefined;
  if (addedRemotePath) value.remote_path = '/';
  parseConnectionConfig(value);
  const indentation = original.match(/\n([ \t]+)"/)?.[1] ?? '  ';
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  const updated = (JSON.stringify(value,null,indentation)+'\n').replace(/\n/g,newline);
  await fs.writeFile(file,updated,'utf8');
  return `${JSON.stringify({...result,passive:value.passive,discover:false,...(addedRemotePath ? {remote_path:'/'} : {})},null,2)}`;
}
