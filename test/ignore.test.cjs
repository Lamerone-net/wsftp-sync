const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { initializeRegex, disposeRegex } = require('../dist/ignore');
const { parseConfig, forDirection, excluded } = require('../dist/core');
const base = {protocol:'ftp',host:'localhost',username:'test',password:'test',remotePath:'/'};
before(initializeRegex);

test('PCRE2 supports Perl features, flags and mixed glob rules', () => {
  const c = parseConfig({...base,ignore_always:[String.raw`/foo\Kbar/`,String.raw`/(?i)^private\/[^/]+\.php$/`,String.raw`/^(?>secret|private)$/`,'cache/**']});
  for (const file of ['foobar','PRIVATE/file.PHP','secret/nested/file','cache/file']) assert.equal(excluded(file,c.exclude),true,file);
  assert.equal(excluded('src/file.php',c.exclude),false);
  assert.equal(excluded('abc/FILE.PHP',[String.raw`/\.php$/i`]),true);
  assert.equal(excluded('abc/file.txt',[String.raw`/\.php$/i`]),false);
  assert.equal(excluded('secret/private',[String.raw`/^ secret \/ private $/x`]),true);
});

test('PCRE2 direction rules preserve backslashes and apply to ancestors', () => {
  const c = parseConfig({...base,ignore_upload:[String.raw`/^uploads(?:/|$)/`],ignore_download:[String.raw`/\.bak$/i`]});
  assert.equal(excluded('uploads/a',forDirection(c,'upload').exclude),true);
  assert.equal(excluded('uploads/a',forDirection(c,'download').exclude),false);
  assert.equal(excluded('backup.BAK',forDirection(c,'download').exclude),true);
  assert.equal(excluded('backup.BAK',forDirection(c,'upload').exclude),false);
});

test('malformed PCRE2 patterns and flags are reported at their config position', () => {
  for (const pattern of ['/[/','/foo/z','/foo/ii','/unterminated']) {
    assert.throws(() => parseConfig({...base,ignore_always:[pattern]}),/Invalid regex in ignore_always\[0\]/);
  }
  assert.deepEqual(parseConfig({...base,ignore_always:[]}).exclude,[]);
});

test('compiled cache can be evicted and disposed without changing matches', () => {
  for (let i=0;i<300;i++) assert.equal(excluded(`file${i}`,[`/^file${i}$/`]),true);
  disposeRegex();
  assert.equal(excluded('file0',['/^file0$/']),true);
});
