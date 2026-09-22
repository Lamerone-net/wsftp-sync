import path from 'node:path';
import { Config, Entry, remoteFile, UserError } from './core';
import { SyncCache } from './cache';
import { inspectRemote, RemoteEntry, Transport } from './transport';
import { remoteCRC32 } from './checksum';

class RemoteFileChanged extends UserError {
  constructor(relative: string, size = false) {
    super(`Remote file ${size ? 'size changed' : 'changed'} during content verification: ${relative}. Run synchronization again; verified unchanged files will be reused.`);
  }
}

// Reuse directory listings only inside a bounded comparison batch. Commit each
// file independently after fresh listings validate its metadata and parent path.
export class RemoteComparison {
  private listings = new Map<string, RemoteEntry[]>();
  private pending = new Map<string, {entry:Entry; hash:string}>();
  private agreements = new Map<string,string>();
  private directory?: string;
  private started = Date.now();

  constructor(private t: Transport, private c: Config, private cache: SyncCache, private check: () => void, private progress?: (message: string) => void) {}

  private reader(listings: Map<string,RemoteEntry[]>): Transport {
    return {...this.t,list:async remote => {
      this.check();
      let entries = listings.get(remote);
      if (!entries) { entries = await this.t.list(remote); listings.set(remote,entries); }
      return entries;
    }};
  }

  private async validate(reader: Transport, relative: string, expected: Entry): Promise<void> {
    const now = await inspectRemote(reader,this.c,relative);
    if (!now || now.size !== expected.size || now.mtime !== expected.mtime) {
      throw new RemoteFileChanged(relative);
    }
  }

  async hash(relative: string, entry: Entry): Promise<string> {
    this.check();
    const directory = path.posix.dirname(relative);
    if (this.directory !== directory || this.pending.size >= 32 || Date.now()-this.started >= 10000) await this.flush();
    this.directory = directory;
    const cached = this.cache.get('remote',relative,entry);
    if (cached !== undefined) return cached;
    try {
      await this.validate(this.reader(this.listings),relative,entry);
      const result = entry.size === 0 ? {hash:'00000000',size:0} : await remoteCRC32(this.t,remoteFile(this.c,relative),this.check,
        this.progress ? bytes => this.progress!(`Verifying remote content ${relative}: ${bytes}/${entry.size} bytes`) : undefined);
      if (result.size !== entry.size) throw new RemoteFileChanged(relative,true);
      this.pending.set(relative,{entry:{...entry},hash:result.hash});
      return result.hash;
    } catch (error) {
      if (error instanceof RemoteFileChanged) {
        this.cache.invalidate(relative,'remote');
        // A change discovered before this file is hashed must not discard the
        // successfully read files waiting for validation in the current batch.
        await this.flush();
      }
      throw error;
    }
  }

  acknowledge(relative: string, fingerprint: string): void {
    this.agreements.set(relative,fingerprint);
  }

  async checkpoint(): Promise<void> {
    if (Date.now()-this.started >= 10000) await this.flush();
  }

  async flush(): Promise<void> {
    const reader = this.reader(new Map());
    let changed: RemoteFileChanged | undefined;
    // inspectRemote verifies parent directories and rejects symlinks, including
    // parents replaced while a batch was downloading. A changed file does not
    // invalidate other files whose metadata and parent paths can be verified.
    for (const [relative,{entry,hash}] of this.pending) {
      this.check();
      try { await this.validate(reader,relative,entry); }
      catch (error) {
        if (!(error instanceof RemoteFileChanged)) throw error;
        this.cache.invalidate(relative,'remote');
        this.agreements.delete(relative);
        changed ??= error;
        continue;
      }
      this.check();
      this.cache.set('remote',relative,entry,hash);
      const fingerprint = this.agreements.get(relative);
      if (fingerprint !== undefined) this.cache.acknowledge(relative,fingerprint);
      this.agreements.delete(relative);
    }
    this.check();
    for (const [relative,fingerprint] of this.agreements) this.cache.acknowledge(relative,fingerprint);
    this.pending.clear(); this.agreements.clear(); this.listings.clear();
    this.started = Date.now();
    await this.cache.checkpoint(Boolean(changed));
    if (changed) throw changed;
  }
}
