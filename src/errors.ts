import { UserError } from './core';

export type OperationStage = 'connect' | 'list' | 'upload' | 'download' | 'mkdir' | 'remove' | 'close';

export function operationError(stage: OperationStage, error: unknown): UserError {
  if (error instanceof UserError) return error;
  const value = error as { code?: unknown; message?: unknown; level?: unknown } | null;
  const detail = String(value?.message ?? '');
  if (stage === 'connect') {
    const networkError = `${String(value?.code ?? '')} ${detail}`;
    let networkMessage: string | undefined;
    if (/\b(?:ENOTFOUND|EAI_NONAME|EAI_NODATA)\b/i.test(networkError)) {
      networkMessage = 'Host not found. Check the configured hostname/IP address and DNS settings.';
    } else if (/\bEAI_AGAIN\b/i.test(networkError)) {
      networkMessage = 'Host lookup failed temporarily. Check DNS and the network connection, then try again.';
    } else if (/\b(?:EHOSTUNREACH|ENETUNREACH|EHOSTDOWN|ENETDOWN)\b/i.test(networkError)) {
      networkMessage = 'Host/IP address unreachable. Check the configured hostname/IP address, network, VPN, and firewall.';
    } else if (/\bECONNREFUSED\b/i.test(networkError)) {
      networkMessage = 'Connection refused by host/IP address. Check the configured hostname/IP address, port, server service, and firewall.';
    } else if (/\b(?:ETIMEDOUT|ESOCKETTIMEDOUT)\b|\btimed?\s*out\b|\btimeout\b/i.test(networkError)) {
      networkMessage = 'Connection to host/IP address timed out. Check the configured hostname/IP address, port, server availability, and firewall.';
    }
    if (networkMessage) return new UserError(`${networkMessage} See WSFTP: Show log for details.`);
    const authenticationRejected = String(value?.code) === '530' || value?.level === 'client-authentication';
    if (!authenticationRejected && /host key|host denied|certificate|\bTLS\b|\bSSL\b/i.test(detail)) {
      return new UserError('Secure connection failed. Check the SFTP host key or FTPS certificate and protocol settings. See WSFTP: Show log for details.');
    }
    if (authenticationRejected || /all configured authentication methods failed|authentication (?:failed|failure|denied)|login (?:failed|incorrect)|not logged in/i.test(detail)) {
      return new UserError('Login failed. Check the configured hostname/IP address first: it may point to a different server. Also check username, password, private key/passphrase, and server authentication settings. See WSFTP: Show log for details.');
    }
    return new UserError('Connection failed. Check host, port, protocol, network/firewall, and timeout settings. See WSFTP: Show log for details.');
  }
  const messages: Record<Exclude<OperationStage, 'connect'>, string> = {
    list: 'Cannot get files list. Check the remote directory, listing permissions, and FTP active/passive data connection settings.',
    upload: 'Upload failed. Check the local file, remote directory, write permissions, available server space, and data connection settings.',
    download: 'Download failed. Check the remote file, read permissions, local write permissions, available disk space, and data connection settings.',
    mkdir: 'Cannot create remote directory. Check the remote path and directory creation permissions.',
    remove: 'Cannot delete remote file or directory. Check the remote path, deletion permissions, and whether the directory is empty.',
    close: 'Cannot close connection cleanly. Completed transfers remain applied.'
  };
  return new UserError(`${messages[stage]} See WSFTP: Show log for details.`);
}
