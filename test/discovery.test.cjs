const { test } = require('node:test');
const assert = require('node:assert/strict');
const { discoverProtocol } = require('../dist/discovery');
const { parseConnectionConfig } = require('../dist/config');
const config = () => parseConnectionConfig({discover:true,host:'localhost',port:2121,username:'user',password:'secret'});

test('discovery validates its flag and requires an explicit port, not protocol or remotePath', () => {
  assert.equal(config().remotePath,'/');
  assert.throws(() => parseConnectionConfig({discover:'true'}),/discover must be a boolean/);
  assert.throws(() => parseConnectionConfig({discover:true,host:'localhost',username:'user'}),/port is required/);
});

test('discovery tries the required order on the configured port and verifies listings', async () => {
  const attempts = [], closed = [];
  let warnings = 0;
  const result = await discoverProtocol(config(),'secret',async () => true,async () => { warnings++; return true; },() => {},() => {},async (c,secret) => {
    attempts.push([c.protocol,c.passive]);
    assert.equal(c.port,2121);
    assert.equal(secret,'secret');
    assert.equal(c.rejectUnauthorized,true);
    assert.equal(c.privateKeyPath,undefined);
    return {list:async remote => {assert.equal(remote,'/'); if (attempts.length < 5) throw new Error('failed data mode'); return [];},close:async () => closed.push(c.protocol)};
  });
  assert.deepEqual(attempts,[['sftp',true],['ftps',true],['ftps',false],['ftp',true],['ftp',false]]);
  assert.deepEqual(result,{protocol:'ftp',passive:false});
  assert.equal(warnings,1);
  assert.equal(closed.length,5);
});

test('discovery stops after secure success or FTP warning refusal', async () => {
  let count = 0;
  const result = await discoverProtocol(config(),'secret',async () => true,async () => {throw new Error('unexpected warning');},() => {},() => {},async () => {
    count++; return {list:async () => [],close:async () => {}};
  });
  assert.deepEqual(result,{protocol:'sftp'});
  assert.equal(count,1);
  count = 0;
  await assert.rejects(discoverProtocol(config(),'secret',async () => true,async () => false,() => {},() => {},async c => {
    count++; assert.notEqual(c.protocol,'ftp'); throw new Error('unavailable');
  }),/cancelled before unencrypted FTP/);
  assert.equal(count,3);
});

test('discovery returns SFTP without passive and stops when host trust is rejected', async () => {
  const connector = async (c,secret,verify) => {
    if (c.protocol !== 'sftp') throw new Error('no FTP');
    if (!await verify('fingerprint')) throw new Error('host rejected');
    return {list:async () => [],close:async () => {}};
  };
  const result = await discoverProtocol(config(),'secret',async () => true,async () => {throw new Error('unexpected FTP');},() => {},() => {},connector);
  assert.deepEqual(result,{protocol:'sftp'});
  await assert.rejects(discoverProtocol(config(),'secret',async () => false,async () => {throw new Error('unexpected FTP');},() => {},() => {},connector),/host key was not trusted/);
});

test('discovery reports complete failure and honours cancellation', async () => {
  await assert.rejects(discoverProtocol(config(),'secret',async () => true,async () => true,() => {},() => {},async () => {throw new Error('unavailable');}),/No working protocol/);
  await assert.rejects(discoverProtocol(config(),'secret',async () => true,async () => true,() => {throw new Error('cancelled');},() => {},async () => {throw new Error('should not connect');}),/cancelled/);
});


test('discovery falls back from SFTP to FTPS and stops at the first working FTPS mode', async () => {
  for (const passive of [true,false]) {
    const attempts = [];
    const result = await discoverProtocol(config(),'secret',async () => true,async () => {throw new Error('FTP must not be attempted');},() => {},() => {},async c => {
      attempts.push(c.protocol);
      if (c.protocol === 'sftp' || c.passive !== passive) throw new Error('unavailable');
      return {list:async () => [],close:async () => {}};
    });
    assert.deepEqual(result,{protocol:'ftps',passive});
    assert.deepEqual(attempts,passive ? ['sftp','ftps'] : ['sftp','ftps','ftps']);
  }
});


test('TLS certificate rejection stops discovery without plaintext fallback', async () => {
  const { TLSNotTrusted } = require('../dist/transport');
  const attempts = [];
  await assert.rejects(discoverProtocol(config(),'secret',async () => true,async () => {throw new Error('Unexpected plaintext fallback');},() => {},() => {},async c => {
    attempts.push(c.protocol);
    if (c.protocol === 'sftp') throw new Error('Not SSH');
    throw new TLSNotTrusted('Certificate rejected');
  }),/Certificate rejected/);
  assert.deepEqual(attempts,['sftp','ftps']);
});
