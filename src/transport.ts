import SftpClient from 'ssh2-sftp-client';
import { TLSSocket, checkServerIdentity } from 'node:tls';
import { isIP } from 'node:net';
import { Client } from 'basic-ftp';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { activeTransfer } from './active';
import { Config, safeRelative, UserError } from './core';

export interface TLSIdentity { fingerprint: string; subject: string; issuer: string; validFrom: string; validTo: string; error?: string }
export type VerifyTLS = (identity: TLSIdentity) => Promise<boolean>;
export class TLSNotTrusted extends UserError {}

export interface RemoteEntry { name: string; size: number; mtime: number; directory: boolean; symlink: boolean }
export interface Transport {
  list(remote: string): Promise<RemoteEntry[]>;
  upload(local: string, remote: string): Promise<void>;
  download(remote: string, local: string): Promise<void>;
  close(): Promise<void>;
}
export async function inspectRemote(t: Transport, c: Config, relative: string): Promise<RemoteEntry | undefined> {
  const parts = safeRelative(relative).split('/');
  let parent = c.remotePath;
  for (let i = 0; i < parts.length; i++) {
    const entry = (await t.list(parent)).find(e => e.name === parts[i]);
    if (!entry) return undefined;
    if (entry.symlink || (i < parts.length - 1 ? !entry.directory : entry.directory)) throw new Error('Incompatible remote path or symbolic link.');
    if (i === parts.length - 1) return entry;
    parent = path.posix.join(parent,parts[i]);
  }
  return undefined;
}
export async function connect(c: Config, secret: string | undefined, verify: (hash: string) => Promise<boolean>, debug: (message: string) => void = () => {}, verifyTLS?: VerifyTLS): Promise<Transport> {
  const trace = (message: string) => {
    if (c.debug) debug([secret,c.password,c.passphrase].reduce<string>((text,value) => value ? text.split(value).join('[REDACTED]') : text,message).replace(/(>\s*(?:PASS|ACCT)\s+)[^\r\n]*/gi,'$1[REDACTED]'));
  };
  if (c.protocol === 'sftp') {
    const client = new SftpClient();
    let privateKey: Buffer | undefined;
    if (c.privateKeyPath) privateKey = await readFile(c.privateKeyPath.startsWith('~/') ? path.join(os.homedir(), c.privateKeyPath.slice(2)) : c.privateKeyPath);
    try {
      await client.connect({ host: c.host, port: c.port, username: c.username, readyTimeout: c.timeout, retries: 0,
        ...(c.debug ? { debug: trace } : {}),
        ...(privateKey ? { privateKey, passphrase: secret } : { password: secret }),
        hostVerifier: (key: Buffer, callback: (valid: boolean) => void) => { void verify(createHash('sha256').update(key).digest('hex')).then(callback, () => callback(false)); }
      });
    } catch (e) { await client.end().catch(() => {}); throw e; }
    return {
      list: async remote => (await client.list(remote)).map(e => ({ name: e.name, size: e.size, mtime: e.modifyTime, directory: e.type === 'd', symlink: e.type === 'l' })),
      upload: async (local, remote) => { await client.mkdir(path.posix.dirname(remote), true); await client.put(local, remote); },
      download: async (remote, local) => { await client.get(remote, local); },
      close: async () => { await client.end(); }
    };
  }
  const client = new Client(c.timeout);
  client.ftp.verbose = Boolean(c.debug);
  client.ftp.log = trace;
  try {
    if (c.protocol === 'ftps' && verifyTLS) {
      await client.connect(c.host,c.port);
      const servername = isIP(c.host) ? undefined : c.host;
      // Complete TLS without sending credentials, then validate or explicitly trust this certificate.
      await client.useTLS({rejectUnauthorized:false,servername});
      const socket = client.ftp.socket as TLSSocket;
      const certificate = socket.getPeerCertificate(true);
      if (!certificate.raw) throw new TLSNotTrusted('The FTPS server did not provide a certificate.');
      const fingerprint = createHash('sha256').update(certificate.raw).digest('hex');
      const identityError = checkServerIdentity(c.host,certificate);
      const error = !socket.authorized ? String(socket.authorizationError) : identityError?.message;
      if (!await verifyTLS({fingerprint,subject:JSON.stringify(certificate.subject),issuer:JSON.stringify(certificate.issuer),validFrom:certificate.valid_from,validTo:certificate.valid_to,error})) throw new TLSNotTrusted('FTPS certificate was not accepted. Connection cancelled before sending credentials.');
      // Data connections must present the same certificate and still pass TLS chain/date checks.
      const certificates: string[] = [];
      const seen = new Set<string>();
      let current = certificate;
      while (current?.raw) {
        const encoded = current.raw.toString('base64');
        if (seen.has(encoded)) break;
        seen.add(encoded);
        certificates.push(`-----BEGIN CERTIFICATE-----\n${encoded.match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----`);
        current = current.issuerCertificate;
      }
      client.ftp.tlsOptions = {rejectUnauthorized:true,servername,ca:certificates,allowPartialTrustChain:true,
        checkServerIdentity:(_host,peer) => peer.raw && createHash('sha256').update(peer.raw).digest('hex') === fingerprint ? undefined : new Error('FTPS data certificate differs from the accepted control certificate.')};
      await client.login(c.username,secret);
      await client.useDefaultSettings();
    } else await client.access({ host: c.host, port: c.port, user: c.username, password: secret, secure: c.protocol === 'ftps', secureOptions: { rejectUnauthorized: c.rejectUnauthorized ?? true } });
  }
  catch (e) { client.close(); throw e; }
  if (c.passive === false) {
    return {
      list: async remote => {
        const chunks: Buffer[] = [];
        const destination = new Writable({write(chunk,encoding,done) { chunks.push(Buffer.from(chunk)); done(); }});
        await activeTransfer(client,`LIST ${await client.protectWhitespace(remote)}`,socket => pipeline(socket,destination));
        return client.parseList(Buffer.concat(chunks).toString(client.ftp.encoding)).map(e => ({name:e.name,size:e.size,mtime:e.modifiedAt?.getTime() ?? 0,directory:e.isDirectory,symlink:e.isSymbolicLink}));
      },
      upload: async (local,remote) => {
        await client.ensureDir(path.posix.dirname(remote));
        await activeTransfer(client,`STOR ${await client.protectWhitespace(remote)}`,socket => pipeline(createReadStream(local),socket));
      },
      download: async (remote,local) => {
        await activeTransfer(client,`RETR ${await client.protectWhitespace(remote)}`,socket => pipeline(socket,createWriteStream(local)));
      },
      close: async () => { client.close(); }
    };
  }
  return {
    list: async remote => (await client.list(remote)).map(e => ({ name: e.name, size: e.size, mtime: e.modifiedAt?.getTime() ?? 0, directory: e.isDirectory, symlink: e.isSymbolicLink })),
    upload: async (local, remote) => { await client.ensureDir(path.posix.dirname(remote)); await client.uploadFrom(local, remote); },
    download: async (remote, local) => { await client.downloadTo(local, remote); },
    close: async () => { client.close(); }
  };
}
