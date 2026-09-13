import path from 'node:path';
import { normalizeIgnore, isRegex, compileIgnore, matchesRegex } from './ignore';
import { minimatch } from 'minimatch';

export interface Config {
  protocol: 'sftp' | 'ftp' | 'ftps'; host: string; port: number;
  username: string; remote_path: string; uploadOnSave: boolean;
  exclude: string[]; privateKeyPath?: string; hostKeySha256?: string;
  autosync?: boolean; autosync_secs: number;
  timeout: number; debug?: boolean; discover?: boolean; passive?: boolean;
  ignore_upload?: string[]; ignore_download?: string[];
  password?: string; passphrase?: string; rejectUnauthorized?: boolean; legacyIgnore?: string[];
}
export class UserError extends Error {}
export const configFields = ["username", "password", "host", "remote_path", "port", "upload_on_save", "autosync", "autosync_secs", "discover", "protocol", "passive", "ignore_always", "ignore_upload", "ignore_download", "debug"];
export function parseConfig(value: unknown): Config {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid configuration.');
  const c = { ...value } as Record<string, unknown>;
  if (c.discover !== undefined && typeof c.discover !== 'boolean') throw new Error('discover must be a boolean.');
  if (c.discover === true) {
    if (c.port === undefined) throw new Error('port is required for discovery.');
    c.protocol ??= 'ftps';
    c.remote_path ??= '/';
  }
  const invalid = Object.keys(c).filter(key => !configFields.includes(key));
  if (invalid.length) throw new Error(invalid.length === 1 ? `invalid option ${invalid[0]}` : `Unknown configuration options: ${invalid.join(', ')}.`);
  if (!['sftp','ftp','ftps'].includes(String(c.protocol))) throw new Error('Invalid protocol.');
  for (const k of ['host','username','remote_path']) if (typeof c[k] !== 'string' || !(c[k] as string).trim() || /[\r\n\0]/.test(c[k] as string)) throw new Error(`Invalid field: ${k}.`);
  const remote = c.remote_path as string;
  if (!remote.startsWith('/') || remote.includes('\\') || remote.split('/').includes('..')) throw new Error('remote_path must be absolute and must not contain .. or backslashes.');
  const port = c.port ?? (c.protocol === 'sftp' ? 22 : 21);
  const timeout = 15000;
  if (!Number.isInteger(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('Invalid port.');
  if (!Number.isInteger(timeout) || Number(timeout) < 1000 || Number(timeout) > 300000) throw new Error('timeout must be between 1000 and 300000 ms.');
  if (c.debug !== undefined && typeof c.debug !== 'boolean') throw new Error('debug must be a boolean.');
  for (const name of ['upload_on_save','autosync']) {
    if (c[name] !== undefined && typeof c[name] !== 'boolean') throw new Error(`${name} must be a boolean.`);
  }
  if (c.autosync_secs !== undefined && (!Number.isInteger(c.autosync_secs) || Number(c.autosync_secs) < 1 || Number(c.autosync_secs) > 86400)) throw new Error('autosync_secs must be an integer between 1 and 86400.');
  if (c.password !== undefined && typeof c.password !== 'string') throw new Error('password must be a string.');
  if (c.passive !== undefined && typeof c.passive !== 'boolean') throw new Error('passive must be a boolean.');
  for (const name of ['ignore_always','ignore_upload','ignore_download']) {
    if (c[name] !== undefined && (!Array.isArray(c[name]) || !(c[name] as unknown[]).every(x => typeof x === 'string' && x.length > 0 && !x.startsWith('!')))) throw new Error(`${name} must be a list of nonempty paths, globs, or /pattern/flags regexes without glob negation.`);
    for (const [index,pattern] of (c[name] as string[] ?? []).entries()) {
      if (isRegex(pattern)) {
        try { compileIgnore(pattern); }
        catch (error) { throw new UserError(`Invalid regex in ${name}[${index}]: ${(error as Error).message}`); }
      }
    }
  }
  return { ...c, autosync_secs:c.autosync_secs ?? 120, remote_path:path.posix.normalize(remote), port, timeout, passive:c.passive ?? true, debug:c.debug ?? false, uploadOnSave:c.upload_on_save ?? false,
    exclude:[...(c.ignore_always as string[] ?? []).map(normalizeIgnore)] } as Config;
}
export function safeRelative(relative: string): string {
  if (!relative || relative.includes('\\') || relative.startsWith('/') || /^[a-z]:/i.test(relative) || relative.split('/').some(p => !p || p === '.' || p === '..' || /[\x00-\x1f<>:"|?*]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw new Error(`Unsafe path: ${relative}`);
  return relative;
}
export function remoteFile(config: Config, relative: string): string { return path.posix.join(config.remote_path, safeRelative(relative)); }
export function forDirection(config: Config, direction: 'upload' | 'download'): Config {
  return { ...config, exclude: [...config.exclude, ...(config[direction === 'upload' ? 'ignore_upload' : 'ignore_download'] ?? []).map(normalizeIgnore)] };
}
export function excluded(relative: string, patterns: string[], legacyIgnore: string[] = []): boolean {
  if (legacyIgnore.some(pattern => new RegExp(pattern).test(relative))) return true;
  const parts = relative.split('/');
  return parts.some((_, i) => patterns.some(p => {
    const candidate = parts.slice(0,i+1).join('/');
    if (isRegex(p)) {
      try { return matchesRegex(p,candidate) || (i < parts.length-1 && matchesRegex(p,candidate+'/')); }
      catch (error) { throw new UserError(`Ignore regex evaluation failed: ${(error as Error).message}`); }
    }
    return minimatch(candidate,p,{dot:true}) || minimatch(candidate+'/',p,{dot:true});
  }));
}
export interface Entry { size: number; mtime: number }
export interface Change { relative: string; reason: 'new' | 'changed'; source: Entry; target?: Entry }
export function plan(source: Map<string, Entry>, target: Map<string, Entry>): Change[] {
  return [...source].flatMap(([relative, entry]) => {
    const other = target.get(relative);
    return !other || entry.size !== other.size ? [{ relative, reason: other ? 'changed' as const : 'new' as const, source: entry, target: other }] : [];
  }).sort((a,b) => a.relative.localeCompare(b.relative));
}
