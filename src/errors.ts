import { UserError } from './core';

export type OperationStage = 'connect' | 'list' | 'upload' | 'download' | 'mkdir' | 'remove' | 'close';

export function ftpServerMessage(error: unknown, secrets: readonly (string | undefined)[] = []): string | undefined {
  const value = error as {code?: unknown; message?: unknown} | null;
  const message = typeof value?.message === 'string' ? value.message : '';
  // FTP libraries expose a three-digit reply code; local and SFTP errors do not.
  const code = /^[45]\d{2}$/.test(String(value?.code ?? '')) ? String(value!.code) : message.match(/^([45]\d{2})(?:[\s-]|$)/)?.[1];
  if (!code) return undefined;
  const reply = message.startsWith(code) ? message : `${code}${message ? ' '+message : ''}`;
  return [...secrets].filter((secret): secret is string => Boolean(secret)).sort((a,b) => b.length-a.length)
    .reduce((text,secret) => text.split(secret).join('[REDACTED]'),reply)
    .replace(/[\x00-\x1f\x7f\u2028\u2029]+/g,' ').trim();
}

export function operationError(stage: OperationStage, error: unknown, secrets: readonly (string | undefined)[] = []): UserError {
  if (error instanceof UserError) return error;
  const serverMessage = ftpServerMessage(error,secrets);
  const diagnostic = (message: string) => {
    if (!serverMessage) return new UserError(`${message} See WSFTP: Show log for details.`);
    const split = message.indexOf('. ');
    return new UserError(split < 0 ? `${message} FTP server: ${serverMessage}`
      : `${message.slice(0,split+1)} FTP server: ${serverMessage}\n${message.slice(split+2)}`);
  };
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
    if (networkMessage) return diagnostic(networkMessage);
    const authenticationRejected = String(value?.code) === '530' || value?.level === 'client-authentication';
    if (!authenticationRejected && /host key|host denied|certificate|\bTLS\b|\bSSL\b/i.test(detail)) {
      return diagnostic('Secure connection failed. Check the SFTP host key or FTPS certificate and protocol settings.');
    }
    if (authenticationRejected || /all configured authentication methods failed|authentication (?:failed|failure|denied)|login (?:failed|incorrect)|not logged in/i.test(detail)) {
      return diagnostic('Login failed. Check the configured hostname/IP address first: it may point to a different server. Also check username, password, private key/passphrase, and server authentication settings.');
    }
    return diagnostic('Connection failed. Check host, port, protocol, network/firewall, and timeout settings.');
  }
  const messages: Record<Exclude<OperationStage, 'connect'>, string> = {
    list: 'Cannot get files list. Check the remote directory, listing permissions, and FTP active/passive data connection settings.',
    upload: 'Upload failed. Check the local file, remote directory, write permissions, available server space, and data connection settings.',
    download: 'Download failed. Check the remote file, read permissions, local write permissions, available disk space, and data connection settings.',
    mkdir: 'Cannot create remote directory. Check the remote path and directory creation permissions.',
    remove: 'Cannot delete remote file or directory. Check the remote path, deletion permissions, and whether the directory is empty.',
    close: 'Cannot close connection cleanly. Completed transfers remain applied.'
  };
  return diagnostic(messages[stage]);
}
