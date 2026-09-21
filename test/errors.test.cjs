const { test } = require('node:test');
const assert = require('node:assert/strict');
const { operationError } = require('../dist/errors');
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
