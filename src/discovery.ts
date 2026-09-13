import { Config, UserError } from './core';
import { connect, VerifyTLS, TLSNotTrusted } from './transport';

export interface DiscoveryResult { protocol: Config['protocol']; passive?: boolean }
export async function discoverProtocol(c: Config, password: string, verify: (hash: string) => Promise<boolean>, allowFTP: () => Promise<boolean>, check: () => void, log: (message: string) => void, connector = connect, verifyTLS?: VerifyTLS): Promise<DiscoveryResult> {
  const candidates: DiscoveryResult[] = [
    {protocol:'sftp'},
    {protocol:'ftps',passive:true}, {protocol:'ftps',passive:false},
    {protocol:'ftp',passive:true}, {protocol:'ftp',passive:false}
  ];
  let ftpAllowed = false;
  for (const candidate of candidates) {
    check();
    if (candidate.protocol === 'ftp' && !ftpAllowed) {
      if (!await allowFTP()) throw new UserError('Discovery cancelled before unencrypted FTP.');
      ftpAllowed = true;
      check();
    }
    const label = `${candidate.protocol.toUpperCase()}${candidate.passive === undefined ? '' : ` passive=${candidate.passive}`}`;
    log(`Discovery: trying ${label} on ${c.host}:${c.port}`);
    let transport;
    let trustRejected = false;
    try {
      transport = await connector({...c,...candidate,privateKeyPath:undefined,passphrase:undefined,rejectUnauthorized:true},password,async hash => {
        const trusted = await verify(hash);
        trustRejected = !trusted;
        return trusted;
      },log,verifyTLS);
      check();
      await transport.list(c.remotePath);
      check();
      log(`Discovery succeeded: ${label}`);
      return candidate;
    } catch (error) {
      check();
      if (error instanceof TLSNotTrusted) throw error;
      if (trustRejected) throw new UserError('Discovery stopped because the SFTP host key was not trusted.');
      log(`Discovery failed: ${label}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (transport) await transport.close().catch(error => log(`Discovery disconnect: ${error instanceof Error ? error.message : String(error)}`));
    }
  }
  throw new UserError('No working protocol/data mode was found on the configured port. Check host, port, credentials, directory permissions, certificates, and connectivity. See WSFTP Sync Output for details.');
}
