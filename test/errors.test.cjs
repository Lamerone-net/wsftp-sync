const { test } = require('node:test');
const assert = require('node:assert/strict');
const { operationError, ftpServerMessage } = require('../dist/errors');
const { FTPError } = require('basic-ftp');
const { UserError } = require('../dist/core');

test('connection diagnostics distinguish authentication, trust, and connectivity', () => {
  for (const error of [Object.assign(new Error('Denied'), {code:530}), new Error('All configured authentication methods failed'), Object.assign(new Error('Denied'), {level:'client-authentication'})]) {
    assert.match(operationError('connect',error).message, /^Login failed\./);
  }
  for (const message of ['Host denied (verification failed)', 'self signed certificate', 'TLS handshake failed']) {
    assert.match(operationError('connect',new Error(message)).message, /^Secure connection failed\./);
  }
  assert.match(operationError('connect',new Error('Unexpected failure')).message, /^Connection failed\./);
});

test('operation diagnostics preserve explicit user errors and do not expose server secrets', () => {
  const trusted = new UserError('Certificate was not accepted.');
  assert.equal(operationError('connect',trusted),trusted);
  for (const [stage,prefix] of Object.entries({list:'Cannot get files list.',upload:'Upload failed.',download:'Download failed.',mkdir:'Cannot create remote directory.',remove:'Cannot delete remote file or directory.',close:'Cannot close connection cleanly.'})) {
    const message = operationError(stage,new Error('secret-password')).message;
    assert.ok(message.startsWith(prefix));
    assert.ok(!message.includes('secret-password'));
  }
});


test('host diagnostics distinguish DNS, routing, refusal and timeout without exposing addresses', () => {
  const cases = [
    ['ENOTFOUND','Host not found.'],
    ['EAI_NONAME','Host not found.'],
    ['EAI_NODATA','Host not found.'],
    ['EAI_AGAIN','Host lookup failed temporarily.'],
    ['EHOSTUNREACH','Host/IP address unreachable.'],
    ['ENETUNREACH','Host/IP address unreachable.'],
    ['EHOSTDOWN','Host/IP address unreachable.'],
    ['ENETDOWN','Host/IP address unreachable.'],
    ['ECONNREFUSED','Connection refused by host/IP address.'],
    ['ETIMEDOUT','Connection to host/IP address timed out.'],
    ['ESOCKETTIMEDOUT','Connection to host/IP address timed out.']
  ];
  for (const [code,prefix] of cases) {
    for (const error of [Object.assign(new Error('private-host'),{code}),new Error(`getConnection: ${code} private-host`)]) {
      const message = operationError('connect',error).message;
      assert.ok(message.startsWith(prefix),message);
      assert.ok(!message.includes('private-host'));
      assert.ok(operationError('list',error).message.startsWith('Cannot get files list.'));
    }
  }
  for (const detail of ['Timeout (control socket)','getConnection: Timed out while waiting for handshake']) {
    assert.ok(operationError('connect',new Error(detail)).message.startsWith('Connection to host/IP address timed out.'));
  }
});


test('authentication diagnostics include a wrong reachable host and require explicit failure evidence', () => {
  const denied = operationError('connect',Object.assign(new Error('530 Login incorrect'),{code:530}));
  assert.match(denied.message,/hostname\/IP address first/);
  assert.match(denied.message,/different server/);
  assert.match(operationError('connect',new Error('Connection closed before authentication')).message,/^Connection failed\./);
  assert.match(operationError('connect',new Error('TLS authentication failed')).message,/^Secure connection failed\./);
  assert.match(operationError('connect',Object.assign(new Error('authentication failed'),{code:'ENOTFOUND'})).message,/^Host not found\./);
});

test('FTP replies retain the server code and explanation for every operation stage', () => {
  for (const stage of ['connect','list','upload','download','mkdir','remove','close']) {
    for (const code of [421,425,450,530,550,552,553]) {
      const reply = `${code} /wrong-directory: No such file or directory`;
      const error = new FTPError({code,message:reply});
      const diagnostic = operationError(stage,error);
      assert.ok(diagnostic instanceof UserError);
      assert.ok(diagnostic.message.includes(`FTP server: ${reply}`),diagnostic.message);
      assert.equal(diagnostic.message.split(reply).length,2,'Do not duplicate reply text');
    }
  }
  assert.equal(ftpServerMessage({code:'550',message:'Directory unavailable'}),'550 Directory unavailable');
  assert.equal(ftpServerMessage(new Error('550 Permission denied')),'550 Permission denied');
  assert.equal(ftpServerMessage({code:550}),'550');
  for (const error of [null,undefined,new Error('secret-password'),{code:'ENOENT',message:'local path'},{code:4,message:'SFTP failure'}]) {
    assert.equal(ftpServerMessage(error),undefined);
  }
});

test('FTP diagnostics redact all credentials before normalizing multiline server replies', () => {
  const error = new FTPError({code:530,message:'530-Login failed for session-secret\r\nconfig-secret key-phrase secret-long\r\n530 Try again\x00'});
  const message = operationError('connect',error,['session-secret','config-secret','key-phrase','secret','secret-long']).message;
  assert.match(message,/^Login failed\. FTP server: 530-Login failed/);
  assert.match(message,/530 Try again/);
  for (const secret of ['session-secret','config-secret','key-phrase','secret-long']) assert.ok(!message.includes(secret));
  assert.equal((message.match(/\[REDACTED\]/g) || []).length,4);
  assert.ok(!message.includes('[REDACTED]-long'));
  assert.ok(!message.includes('\x00'));
});
