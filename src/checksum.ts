import { createReadStream } from 'node:fs';
import { Writable } from 'node:stream';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { Transport } from './transport';

const table = Uint32Array.from({length:256}, (_,index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});

class CRC32 {
  private value = 0xffffffff;
  bytes = 0;
  update(chunk: Buffer): void {
    let crc = this.value;
    for (let i = 0; i < chunk.length; i++) crc = (crc >>> 8) ^ table[(crc ^ chunk[i]) & 0xff];
    this.value = crc;
    this.bytes += chunk.length;
  }
  digest(): string { return ((this.value ^ 0xffffffff) >>> 0).toString(16).padStart(8,'0'); }
}

export async function crc32File(file: string, check: () => void): Promise<string> {
  const crc = new CRC32();
  for await (const chunk of createReadStream(file)) { check(); crc.update(chunk as Buffer); }
  check();
  return crc.digest();
}

export async function remoteCRC32(t: Transport, remote: string, check: () => void, progress?: (bytes: number) => void): Promise<{hash:string; size:number}> {
  check();
  if (!t.readTo) {
    // Compatibility with transports that only support file destinations.
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(),'wsftp-hash-'));
    const file = path.join(temporary,'content');
    try {
      await t.download(remote,file);
      return {hash:await crc32File(file,check),size:(await fs.stat(file)).size};
    } finally { await fs.rm(temporary,{recursive:true,force:true}); }
  }
  const crc = new CRC32();
  let lastReport = Date.now();
  const sink = new Writable({write(chunk: Buffer,_encoding,done) {
    try {
      check(); crc.update(chunk);
      if (progress && Date.now()-lastReport >= 1000) { lastReport = Date.now(); progress(crc.bytes); }
      done();
    }
    catch (error) { done(error as Error); }
  }});
  // Transport libraries also listen for errors; this prevents an unhandled
  // error if a stream fails while the transport is still preparing a request.
  sink.on('error',() => {});
  try { await t.readTo(remote,sink); check(); return {hash:crc.digest(),size:crc.bytes}; }
  finally { sink.destroy(); }
}
