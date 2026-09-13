const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { once } = require('node:events');
const { Client } = require('basic-ftp');
const { activeTransfer } = require('../dist/active');

test('active FTP closes its listener after rejection or a missing data connection', {timeout:5000}, async () => {
  for (const rejectPort of [true,false]) {
    let advertisedPort;
    const sockets = new Set();
    const server = net.createServer(socket => {
      sockets.add(socket);
      socket.on('close',() => sockets.delete(socket));
      socket.write('220 Ready\r\n');
      let buffer = '';
      socket.on('data',chunk => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf('\r\n')) >= 0) {
          const command = buffer.slice(0,end);
          buffer = buffer.slice(end+2);
          if (command.startsWith('PORT ')) {
            const parts = command.slice(5).split(',').map(Number);
            advertisedPort = parts[4]*256+parts[5];
            socket.write(rejectPort ? '502 PORT rejected\r\n' : '200 PORT accepted\r\n');
          } else if (command.startsWith('LIST')) socket.write('150 Opening data connection\r\n');
        }
      });
    });
    server.listen(0,'127.0.0.1');
    await once(server,'listening');
    const client = new Client(150);
    try {
      await client.connect('127.0.0.1',server.address().port);
      await assert.rejects(activeTransfer(client,'LIST /',async () => {throw new Error('Unexpected data connection');}),rejectPort ? /PORT rejected/ : /timed out|Timeout/);
      assert.ok(advertisedPort);
      const probe = net.connect(advertisedPort,'127.0.0.1');
      try { await assert.rejects(once(probe,'connect'),{code:'ECONNREFUSED'}); }
      finally { probe.destroy(); }
    } finally {
      client.close();
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    }
  }
});
