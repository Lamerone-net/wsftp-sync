const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ChangeMonitor, CheckLoop } = require('../dist/monitor');
const entry = (mtime = 10) => ({size:4,mtime,directory:false});
const snapshot = (mtime = 10) => ({local:new Map(),remote:new Map([['file',entry(mtime)]])});
const download = {kind:'download',relative:'file',directory:false};

test('remote files wait for two successful stable observations; changes restart stability', () => {
  const monitor = new ChangeMonitor();
  assert.equal(monitor.stableSnapshot(snapshot()).remote.get('file').blocked,true);
  assert.equal(monitor.accept(snapshot(),[]).waiting,1);
  assert.ok(!monitor.stableSnapshot(snapshot()).remote.get('file').blocked);
  assert.equal(monitor.accept(snapshot(),[download]).fresh,true);
  assert.equal(monitor.accept(snapshot(),[download]).fresh,false);
  assert.equal(monitor.stableSnapshot(snapshot(20)).remote.get('file').blocked,true);
  monitor.accept(snapshot(20),[]);
  assert.ok(!monitor.stableSnapshot(snapshot(20)).remote.get('file').blocked);
  assert.equal(monitor.accept(snapshot(20),[download]).fresh,true);
  monitor.failed();
  assert.equal(monitor.stableSnapshot(snapshot(20)).remote.get('file').blocked,true);
  monitor.accept(snapshot(20),[]);
  assert.equal(monitor.accept(snapshot(20),[download]).fresh,false,'recovery must not repeat unchanged notifications');
});

test('notifications distinguish changed items from count changes and resolved actions', () => {
  const monitor = new ChangeMonitor();
  const upload = {kind:'upload',relative:'local',directory:false};
  const current = {...snapshot(),local:new Map([['local',entry()]])};
  monitor.accept(current,[]);
  assert.equal(monitor.accept(current,[download,upload]).fresh,true);
  assert.equal(monitor.accept(current,[download]).fresh,false,'resolving an action must not notify again');
  assert.equal(monitor.accept(current,[]).fresh,false);
  assert.equal(monitor.accept(current,[download]).fresh,true,'a resolved difference appearing again is new');
});

test('poll loop never overlaps tasks and stops rescheduling after disposal during an active check', async () => {
  let callback, scheduled = 0, calls = 0, finish;
  const schedule = fn => {callback=fn;scheduled++;return {unref(){}};};
  const loop = new CheckLoop(async () => {calls++;await new Promise(resolve => {finish=resolve;});},100,schedule,() => {});
  loop.start(); loop.start(); assert.equal(scheduled,1);
  callback(); loop.start(); assert.equal(calls,1); assert.equal(scheduled,1);
  loop.dispose(); finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(scheduled,1);
});

test('poll loop recovers from a failed task', async () => {
  let callback, scheduled = 0;
  const loop = new CheckLoop(async () => {throw new Error('offline');},100,fn => {callback=fn;scheduled++;return {unref(){}};},() => {});
  loop.start(); callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(scheduled,2); loop.dispose();
});


test('poll loop recalculates its delay after each completed check', async () => {
  let callback, delay = 1000;
  const intervals = [];
  const loop = new CheckLoop(async () => {delay=3000;},() => delay,(fn,ms) => {callback=fn;intervals.push(ms);return {unref(){}};},() => {});
  loop.start(); assert.deepEqual(intervals,[1000]);
  callback(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(intervals,[1000,3000]); loop.dispose();
});
