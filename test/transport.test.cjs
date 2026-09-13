const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { generateKeyPairSync } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { Server, utils } = require('ssh2');
const FtpSrv = require('ftp-srv');
const selfsigned = require('selfsigned');
const extensionRoot = process.env.WSFTP_TEST_EXTENSION || path.join(__dirname,'..');
const { connect } = require(path.join(extensionRoot,'dist/transport'));
const { parseConfig } = require(path.join(extensionRoot,'dist/core'));

test('FTP and explicit FTPS round trips; untrusted TLS certificate rejected', {timeout:30000}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'wsftp-ftp-'));
  const pems = await selfsigned.generate([{name:'commonName',value:'localhost'}],{algorithm:'sha256',extensions:[{name:'basicConstraints',cA:true},{name:'subjectAltName',altNames:[{type:7,ip:'127.0.0.1'},{type:2,value:'localhost'}]}]});
  const server = new FtpSrv({url:'ftp://127.0.0.1:0',pasv_url:'127.0.0.1',tls:{key:pems.private,cert:pems.cert},log:require('bunyan').createLogger({name:'test',level:'fatal'})});
  let requireTLS = false;
  server.on('login',({connection,username,password},resolve,reject) => username === 'test' && password === 'test' && (!requireTLS || connection.secure) ? resolve({root}) : reject(new Error('TLS required or credentials denied')));
  server.on('client-error',() => {});
  try {
    await server.listen();
    const port = server.server.address().port;
    const c = parseConfig({protocol:'ftp',host:'127.0.0.1',port,username:'test',remote_path:'/'});
    const input = path.join(root,'input.txt');
    await fs.writeFile(input,'WSFTP round trip\n');
    const diagnostics = [];
    const t = await connect({...c,debug:true},'test',async () => true,message => diagnostics.push(message));
    try {
      await t.upload(input,'/nested/remote.txt');
      assert.ok((await t.list('/nested')).some(e => e.name === 'remote.txt' && e.size === 17));
      await t.download('/nested/remote.txt',path.join(root,'output.txt'));
      assert.equal(await fs.readFile(path.join(root,'output.txt'),'utf8'),'WSFTP round trip\n');
      await assert.rejects(t.remove('/nested',true));
      await t.remove('/nested/remote.txt',false); await t.remove('/nested',true);
      await t.mkdir('/empty'); await t.remove('/empty',true);
      assert.ok(!(await t.list('/')).some(e => e.name === 'nested' || e.name === 'empty'));
    } finally { await t.close(); }
    assert.ok(diagnostics.some(line => line.includes('> USER')));
    assert.ok(diagnostics.some(line => line.includes('> STOR')));
    assert.ok(diagnostics.some(line => line.includes('> RETR')));
    assert.ok(diagnostics.some(line => /< 220/.test(line)));
    assert.ok(diagnostics.some(line => line.includes('> PASS [REDACTED]')));
    assert.ok(diagnostics.every(line => !line.includes('test')));
    const quiet = [];
    const quietTransport = await connect(c,'test',async () => true,message => quiet.push(message));
    await quietTransport.close();
    assert.deepEqual(quiet,[]);
    await assert.rejects(connect({...c,protocol:'ftps'},'test',async () => true));
    const refusedLogs = [];
    await assert.rejects(connect({...c,protocol:'ftps',debug:true},'test',async () => true,line => refusedLogs.push(line),async identity => {
      assert.ok(identity.error);
      assert.match(identity.fingerprint,/^[a-f0-9]{64}$/);
      return false;
    }),/certificate was not accepted/);
    assert.ok(!refusedLogs.some(line => /^> (USER|PASS)/.test(line)));
    for (const passive of [true,false]) {
      const trusted = await connect({...c,protocol:'ftps',passive},'test',async () => true,() => {},async identity => {
        assert.ok(identity.error);
        assert.ok(identity.subject.includes('localhost'));
        return true;
      });
      try {
        await trusted.upload(input,'/trusted/file.txt');
        assert.ok((await trusted.list('/trusted')).some(entry => entry.name === 'file.txt'));
        await trusted.download('/trusted/file.txt',path.join(root,'trusted-output.txt'));
        assert.equal(await fs.readFile(path.join(root,'trusted-output.txt'),'utf8'),'WSFTP round trip\n');
      } finally { await trusted.close(); }
    }
    const legacy = require('../dist/config').parseConnectionConfig({protocol:'ftps',host:'127.0.0.1',port,username:'test',password:'test',remote_path:'/',passive:true});
    const tlsDiagnostics = [];
    const legacyTransport = await connect({...legacy,debug:true,rejectUnauthorized:false},legacy.password,async () => true,message => tlsDiagnostics.push(message));
    try { await legacyTransport.upload(input,'/legacy/file.txt'); }
    finally { await legacyTransport.close(); }
    assert.ok(tlsDiagnostics.some(line => line.includes('> AUTH TLS')));
    assert.ok(tlsDiagnostics.some(line => line.includes('> STOR')));
    assert.ok(tlsDiagnostics.every(line => !line.includes('test')));
    assert.equal(await fs.readFile(path.join(root,'legacy','file.txt'),'utf8'),'WSFTP round trip\n');
    for (const protocol of ['ftp','ftps']) {
      const activeLogs = [];
      const active = await connect({...c,protocol,passive:false,debug:true,rejectUnauthorized:false},'test',async () => true,line => activeLogs.push(line));
      try {
        await active.upload(input,`/active-${protocol}/file.txt`);
        assert.ok((await active.list(`/active-${protocol}`)).some(entry => entry.name === 'file.txt' && entry.size === 17));
        const destination = path.join(root,`active-${protocol}-output.txt`);
        await active.download(`/active-${protocol}/file.txt`,destination);
        assert.equal(await fs.readFile(destination,'utf8'),'WSFTP round trip\n');
        await assert.rejects(active.download('/missing.txt',path.join(root,'missing-output')));
        await assert.rejects(active.remove(`/active-${protocol}`,true));
        await active.remove(`/active-${protocol}/file.txt`,false);
        await active.remove(`/active-${protocol}`,true);
        await active.mkdir('/empty-active'); await active.remove('/empty-active',true);
      } finally { await active.close(); }
      assert.ok(activeLogs.some(line => line.startsWith('> PORT ')));
      assert.ok(!activeLogs.some(line => /^> (EPSV|PASV)/.test(line)));
    }
    assert.ok(diagnostics.some(line => /^> (EPSV|PASV)/.test(line)));
    const cert = path.join(root,'ca.pem'); await fs.writeFile(cert,pems.cert);
    const script = `const {connect}=require('./dist/transport'); (async()=>{ const t=await connect(${JSON.stringify({...c,protocol:'ftps'})},'test',async()=>true); try {await t.upload(${JSON.stringify(input)},'/tls/file.txt'); await t.download('/tls/file.txt',${JSON.stringify(path.join(root,'tls-output.txt'))});}finally{await t.close();} })().catch(e=>{console.error(e);process.exitCode=1;});`;
    await promisify(execFile)(process.execPath,['-e',script],{cwd:extensionRoot,env:{...process.env,NODE_EXTRA_CA_CERTS:cert},timeout:10000});
    assert.equal(await fs.readFile(path.join(root,'tls-output.txt'),'utf8'),'WSFTP round trip\n');
    requireTLS = true;
    const discoveryScript = `const {discoverProtocol}=require('./dist/discovery'); (async()=>{const logs=[]; const result=await discoverProtocol(${JSON.stringify({...c,discover:true,timeout:1000})},'test',async()=>{throw Error('FTP server must not present an SSH host key');},async()=>{throw Error('Must detect FTPS before plaintext FTP');},()=>{},line=>logs.push(line)); if(result.protocol!=='ftps'||result.passive!==true)throw Error(JSON.stringify({result,logs})); console.log(JSON.stringify({result,logs}));})().catch(e=>{console.error(e);process.exitCode=1;});`;
    const discovered = await promisify(execFile)(process.execPath,['-e',discoveryScript],{cwd:extensionRoot,env:{...process.env,NODE_EXTRA_CA_CERTS:cert},timeout:10000});
    assert.equal(JSON.parse(discovered.stdout).result.protocol,'ftps');

  } finally { await server.close(); await fs.rm(root,{recursive:true,force:true}); }
});

test('SFTP round trip, password authentication and host key rejection', {timeout:20000}, async (testContext) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'wsftp-sftp-'));
  const hostKey = generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs1',format:'pem'},publicKeyEncoding:{type:'pkcs1',format:'pem'}}).privateKey;
  const files = new Map(); const directories = new Set(['/']);
  const S = utils.sftp.STATUS_CODE;
  const attrs = (name) => ({mode:directories.has(name) ? 0o40755 : 0o100644,uid:0,gid:0,size:files.get(name)?.length ?? 0,atime:100,mtime:100});
  const server = new Server({hostKeys:[hostKey]},client => {
    client.on('error',() => {});
    client.on('authentication',ctx => ctx.method === 'password' && ctx.username === 'test' && ctx.password === 'test' ? ctx.accept() : ctx.reject());
    client.on('ready',() => client.on('session',accept => accept().on('sftp',acceptSftp => {
      const s = acceptSftp(); const handles = new Map(); let id = 0;
      const handle = (req,p,dir=false) => {const h=Buffer.alloc(4);h.writeUInt32BE(++id);handles.set(id,{p,dir,read:false});s.handle(req,h);};
      s.on('REALPATH',(req,p) => s.name(req,[{filename:p === '.' ? '/' : p,longname:p,attrs:attrs(p)}]));
      const stat = (req,p) => files.has(p) || directories.has(p) ? s.attrs(req,attrs(p)) : s.status(req,S.NO_SUCH_FILE);
      s.on('STAT',stat); s.on('LSTAT',stat);
      s.on('REMOVE',(req,p) => s.status(req,files.delete(p) ? S.OK : S.NO_SUCH_FILE));
      s.on('RMDIR',(req,p) => {
        if ([...files.keys(),...directories].some(child => child.startsWith(p+'/'))) return s.status(req,S.FAILURE);
        s.status(req,directories.delete(p) ? S.OK : S.NO_SUCH_FILE);
      });
      s.on('MKDIR',(req,p) => {directories.add(p);s.status(req,S.OK);});
      s.on('OPEN',(req,p,flags) => {if (flags & utils.sftp.OPEN_MODE.WRITE) files.set(p,Buffer.alloc(0)); if(!files.has(p)) return s.status(req,S.NO_SUCH_FILE);handle(req,p);});
      s.on('WRITE',(req,h,offset,data) => {const p=handles.get(h.readUInt32BE()).p;const old=files.get(p);const next=Buffer.alloc(Math.max(old.length,offset+data.length));old.copy(next);data.copy(next,offset);files.set(p,next);s.status(req,S.OK);});
      s.on('READ',(req,h,offset,length) => {const data=files.get(handles.get(h.readUInt32BE()).p);if(offset>=data.length)s.status(req,S.EOF);else s.data(req,data.subarray(offset,offset+length));});
      s.on('FSTAT',(req,h) => s.attrs(req,attrs(handles.get(h.readUInt32BE()).p)));
      s.on('CLOSE',(req,h) => {handles.delete(h.readUInt32BE());s.status(req,S.OK);});
      s.on('OPENDIR',(req,p) => directories.has(p) ? handle(req,p,true) : s.status(req,S.NO_SUCH_FILE));
      s.on('READDIR',(req,h) => {const entry=handles.get(h.readUInt32BE());if(entry.read)return s.status(req,S.EOF);entry.read=true;const children=[...directories,...files.keys()].filter(p=>p!==entry.p && path.posix.dirname(p)===entry.p).map(p=>({filename:path.posix.basename(p),longname:path.posix.basename(p),attrs:attrs(p)}));if(children.length)s.name(req,children);else s.status(req,S.EOF);});
    })));
  });
  try {
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
    const c = parseConfig({protocol:'sftp',host:'127.0.0.1',port:server.address().port,username:'test',remote_path:'/'});
    await assert.rejects(connect(c,'test',async () => false));
    testContext.diagnostic('host rejection passed');
    await assert.rejects(connect(c,'wrong',async () => true));
    testContext.diagnostic('password rejection passed');
    let fingerprint;
    const diagnostics = [];
    const t = await connect({...c,debug:true},'test',async hash => {fingerprint=hash;return true;},message => diagnostics.push(message));
    testContext.diagnostic('connected');
    try {
      assert.match(fingerprint,/^[a-f0-9]{64}$/);
      const input = path.join(root,'input.txt'); await fs.writeFile(input,'SFTP data');
      await t.upload(input,'/nested/file.txt');
      testContext.diagnostic('uploaded');
      assert.ok((await t.list('/nested')).some(e => e.name === 'file.txt' && e.size === 9));
      const output = path.join(root,'output.txt'); await t.download('/nested/file.txt',output);
      assert.equal(await fs.readFile(output,'utf8'),'SFTP data');
      await assert.rejects(t.remove('/nested',true));
      await t.remove('/nested/file.txt',false); await t.remove('/nested',true);
      await t.mkdir('/empty'); await t.remove('/empty',true);
      assert.ok(!directories.has('/nested') && !directories.has('/empty'));
    } finally {await t.close();}
    assert.ok(diagnostics.some(line => line.includes('SFTP')));
    assert.ok(diagnostics.some(line => line.includes('Outbound:')));
    assert.ok(diagnostics.every(line => !line.includes('test')));
  } finally { await new Promise(resolve => server.close(resolve)); await fs.rm(root,{recursive:true,force:true}); }
});
