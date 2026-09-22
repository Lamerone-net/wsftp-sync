import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Config, Entry, excluded } from './core';

interface CachedEntry extends Entry { crc32: string }
type Side = 'local' | 'remote';

// Observed content hashes are not transfer acknowledgements: differences remain
// pending even when the user cancels a preview after these hashes are saved.
export class SyncCache {
  private initialized = false;
  private baselines = new Map<string, string>();
  private entries = new Map<string, CachedEntry>();
  constructor(private file?: string) {}

  get needsInitialization(): boolean { return !this.initialized; }

  static filename(storage: string, root: string, c: Config): string {
    const identity = [path.resolve(root),c.protocol,c.host,c.port,c.username,c.remote_path];
    return path.join(storage,'sync-cache',createHash('sha256').update(JSON.stringify(identity)).digest('hex')+'.json');
  }

  async load(): Promise<void> {
    this.initialized = false;
    if (!this.file) return;
    try {
      const data = JSON.parse(await fs.readFile(this.file,'utf8'));
      if (data.version !== 1 || !Array.isArray(data.entries)) return;
      for (const item of data.baselines ?? []) {
        if (Array.isArray(item) && typeof item[0] === 'string' && typeof item[1] === 'string' && /^\d+:[0-9a-f]{8}$/.test(item[1])) this.baselines.set(item[0],item[1]);
      }
      for (const item of data.entries) {
        if (!Array.isArray(item) || item.length !== 2) continue;
        const [key,value] = item;
        if (typeof key === 'string' && value && Number.isFinite(value.size) && value.size >= 0 && Number.isFinite(value.mtime) && typeof value.crc32 === 'string' && /^[0-9a-f]{8}$/.test(value.crc32)) this.entries.set(key,value);
      }
      this.initialized = true;
    } catch { this.entries.clear(); this.baselines.clear(); }
  }

  baseline(relative: string): string | undefined { return this.baselines.get(relative); }
  acknowledge(relative: string, fingerprint: string): void { this.baselines.set(relative,fingerprint); }
  forget(relative: string): void { this.invalidate(relative); this.baselines.delete(relative); }
  clearHashes(): void { this.entries.clear(); }

  get(side: Side, relative: string, entry: Entry): string | undefined {
    const cached = this.entries.get(side+':'+relative);
    // Missing timestamps cannot support a reliable metadata fast path.
    return entry.mtime > 0 && cached?.size === entry.size && cached.mtime === entry.mtime ? cached.crc32 : undefined;
  }

  set(side: Side, relative: string, entry: Entry, crc32: string): void {
    this.entries.set(side+':'+relative,{size:entry.size,mtime:entry.mtime,crc32});
  }

  invalidate(relative: string): void {
    this.entries.delete('local:'+relative);
    this.entries.delete('remote:'+relative);
  }

  prune(local: Map<string, Entry>, remote: Map<string, Entry>, c: Config, scope: string): void {
    for (const relative of this.baselines.keys()) {
      if ((!scope || relative.startsWith(scope+'/')) && !excluded(relative,c.exclude,c.legacyIgnore) && !local.has(relative) && !remote.has(relative)) this.baselines.delete(relative);
    }
    for (const key of this.entries.keys()) {
      const separator = key.indexOf(':');
      const relative = key.slice(separator+1);
      const current = key.slice(0,separator) === 'local' ? local : remote;
      if (excluded(relative,c.exclude,c.legacyIgnore) || ((!scope || relative.startsWith(scope+'/')) && !current.has(relative))) this.entries.delete(key);
    }
  }

  async save(): Promise<void> {
    if (!this.file) return;
    await fs.mkdir(path.dirname(this.file),{recursive:true});
    const temporary = this.file+'.'+randomUUID()+'.tmp';
    try {
      await fs.writeFile(temporary,JSON.stringify({version:1,entries:[...this.entries],baselines:[...this.baselines]}));
      await fs.rename(temporary,this.file);
      this.initialized = true;
    } finally { await fs.rm(temporary,{force:true}); }
  }
}
