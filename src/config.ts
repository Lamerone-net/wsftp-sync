import { initializeRegex } from './ignore';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { Config, parseConfig, UserError } from './core';

export class InactiveConfig extends Error {}

export async function ensureConfig(root: string, template: string): Promise<void> {
  const directory = path.join(root,'.vscode');
  try { if (!(await fs.stat(directory)).isDirectory()) return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
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
  const addedRemotePath = value.remotePath === undefined;
  if (addedRemotePath) value.remotePath = '/';
  parseConnectionConfig(value);
  const indentation = original.match(/\n([ \t]+)"/)?.[1] ?? '  ';
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  const updated = (JSON.stringify(value,null,indentation)+'\n').replace(/\n/g,newline);
  await fs.writeFile(file,updated,'utf8');
  return `${JSON.stringify({...result,passive:value.passive,discover:false,...(addedRemotePath ? {remotePath:'/'} : {})},null,2)}`;
}
