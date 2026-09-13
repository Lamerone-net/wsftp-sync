import { Client, FTPResponse } from 'basic-ftp';
import { createServer, isIPv4, Socket } from 'node:net';
import { connect as connectTLS, TLSSocket } from 'node:tls';

// Active FTP accepts the server data connection instead of sending EPSV/PASV.
export async function activeTransfer(client: Client, command: string, transfer: (socket: Socket) => Promise<void>): Promise<void> {
  const ftp = client.ftp;
  const control = ftp.socket;
  const normalize = (address: string) => address.replace(/^::ffff:/, '');
  const address = normalize(control.localAddress ?? '');
  if (!address) throw new Error('Cannot determine the local address for active FTP.');
  let data: Socket | undefined;
  let running: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let rejectConnection: (error: Error) => void = () => {};
  let resolveConnection: (socket: Socket) => void = () => {};
  const connection = new Promise<Socket>((resolve,reject) => { resolveConnection=resolve; rejectConnection=reject; });
  // The server may connect before the transfer command is sent.
  void connection.catch(() => {});
  const fail = (error: Error) => { rejectConnection(error); ftp.closeWithError(error); };
  const server = createServer(socket => {
    if (data || normalize(socket.remoteAddress ?? '') !== normalize(control.remoteAddress ?? '')) {
      socket.destroy(); return;
    }
    data = socket;
    socket.pause();
    server.close();
    socket.on('error',fail);
    if (control instanceof TLSSocket) {
      const secure = connectTLS({...ftp.tlsOptions,socket,session:control.getSession()});
      data = secure;
      secure.on('error',fail);
      secure.once('secureConnect',() => resolveConnection(secure));
    } else resolveConnection(socket);
  });
  const closed = () => rejectConnection(new Error('Control connection closed during active FTP transfer.'));
  control.once('close',closed);
  try {
    await new Promise<void>((resolve,reject) => {
      server.once('error',reject);
      server.listen(0,address,() => { server.removeListener('error',reject); resolve(); });
    });
    server.on('error',fail);
    timer = setTimeout(() => fail(new Error('Active FTP data connection timed out. Check incoming connections and firewall settings.')),ftp.timeout);
    const port = (server.address() as {port:number}).port;
    const setup = isIPv4(address)
      ? `PORT ${address.replace(/\./g,',')},${port >> 8},${port & 255}`
      : `EPRT |2|${address}|${port}|`;
    await ftp.request(setup);
    let started = false;
    let dataDone = false;
    let response: FTPResponse | undefined;
    await ftp.handle(command,(result,task) => {
      const finish = () => { if (dataDone && response) task.resolve(response); };
      if (result instanceof Error) { task.reject(result); return; }
      if (result.code === 125 || result.code === 150) {
        if (started) return;
        started = true;
        running = connection.then(async socket => {
          clearTimeout(timer);
          control.setTimeout(0);
          socket.setTimeout(ftp.timeout,() => fail(new Error('Active FTP data transfer timed out.')));
          ftp.log(`Active data transfer: ${command}`);
          await transfer(socket);
          socket.setTimeout(0);
          control.setTimeout(ftp.timeout);
          dataDone = true;
          finish();
        }).catch(error => { control.setTimeout(ftp.timeout); task.reject(error); });
      } else if (result.code >= 200 && result.code < 300) {
        response = result;
        if (!started) task.reject(new Error(`Active FTP transfer ended without opening a data stream: ${result.message}`));
        else finish();
      } else if (result.code >= 300) task.reject(new Error(`Unexpected active FTP response: ${result.message}`));
    });
  } finally {
    clearTimeout(timer);
    control.removeListener('close',closed);
    rejectConnection(new Error('Active FTP transfer ended.'));
    data?.destroy();
    if (server.listening) server.close();
    await running;
  }
}
