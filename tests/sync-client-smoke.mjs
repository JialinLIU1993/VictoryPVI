import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const source = fs.readFileSync(new URL('../sync-client.js', import.meta.url), 'utf8');
const context = { TextEncoder, TextDecoder, URL, Blob, CompressionStream, DecompressionStream, setTimeout, clearTimeout, crypto: webcrypto,
  btoa: value => Buffer.from(value, 'binary').toString('base64'), atob: value => Buffer.from(value, 'base64').toString('binary') };
context.window = context;
vm.runInNewContext(source, context);
const Client = context.VictoryPVISyncClient;
assert.doesNotMatch(source, /\bfetch\s*\(|new (?:global\.)?WebSocket|stun:|turn:/);
const hostStates = [], received1 = [], received2 = [];
const host = new Client({ onStatus: state => hostStates.push(state) });
const mirror1 = new Client({ onSnapshot: async (payload, envelope) => { await new Promise(resolve => setTimeout(resolve, 1)); received1.push({ payload, revision: envelope.revision }); } });
const mirror2 = new Client({ onSnapshot: (payload, envelope) => received2.push({ payload, revision: envelope.revision }) });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  const start = Date.now();
  while (!check()) { if (Date.now() - start > 4000) throw new Error(label); await delay(2); }
}
function wire(host, mirror, name) {
  const eventsA = new Map(), eventsB = new Map();
  let paused = false;
  const channel = events => ({ readyState: 'open', bufferedAmount: 0, addEventListener: (type, handler) => events.set(type, handler), close() { this.readyState = 'closed'; } });
  const a = channel(eventsA), b = channel(eventsB);
  a.send = value => { if (!paused) queueMicrotask(() => eventsB.get('message')?.({ data: value })); };
  b.send = value => { if (!paused) queueMicrotask(() => eventsA.get('message')?.({ data: value })); };
  const peer = (deviceId) => ({ pairId: name, deviceId, deviceName: deviceId, pc: { close() {} }, channel: null, ackedRevision: 0, lastSeen: Date.now(), sentAt: 0, receiveQueue: Promise.resolve() });
  const hp = peer(name), mp = peer('host');
  host.peers.set(name, hp); mirror.peers.set(name, mp);
  host.attachChannel(hp, a); mirror.attachChannel(mp, b);
  eventsA.get('open')(); eventsB.get('open')();
  return { hp, mp, pause() { paused = true; }, resume() { paused = false; hp.sentAt = 0; mirror.wake(); } };
}
try {
  host.start('host', 'room-a', 'host', '操作端');
  mirror1.start('mirror', 'room-a', 'mirror-1', '镜像1');
  mirror2.start('mirror', 'room-a', 'mirror-2', '镜像2');
  host.pairingData = { type: 'offer', roomId: 'room-a', pairId: 'pair-a', deviceId: 'host', sdp: 'v=0\r\n测试连接' };
  const raw = await host.compatiblePairingCode();
  assert.equal((await Client.parseLocalPairingCode(raw, 'offer')).pairId, 'pair-a');
  await assert.rejects(() => Client.parseLocalPairingCode(raw, 'answer'));
  await assert.rejects(() => Client.parseLocalPairingCode('VPVI-LAN1.old'));
  assert.equal((await Client.parseLocalPairingCode(Client.makeLocalPairingLink(raw, 'https://example.com'), 'offer')).roomId, 'room-a');
  // Store latest state before anyone joins; both new channels must receive it.
  host.sendSnapshot({ count: 1, note: '初次记录' }, 1);
  const first = wire(host, mirror1, 'mirror-1');
  await until(() => first.hp.ackedRevision === 1, 'First mirror acknowledges applied initial snapshot');
  const second = wire(host, mirror2, 'mirror-2');
  await until(() => second.hp.ackedRevision === 1, 'Late mirror receives latest without a new host edit');
  assert.equal(host.isConnected, true);
  // This exceeds SCTP's typical single-message size by orders of magnitude.
  const large = { text: '离线同步🙂'.repeat(30000), count: 8 };
  host.sendSnapshot(large, 8);
  await until(() => first.hp.ackedRevision === 8 && second.hp.ackedRevision === 8, 'Chunked large snapshot acknowledged by two mirrors');
  assert.equal(received1.at(-1).payload.text, large.text);
  assert.equal(received2.at(-1).payload.text, large.text);
  // Lost transmissions do not remove the latest snapshot. Recovery asks for the latest full state.
  second.pause();
  host.sendSnapshot({ count: 9 }, 9);
  await until(() => first.hp.ackedRevision === 9, 'Other mirror remains unaffected by outage');
  host.sendSnapshot({ count: 0 }, 10);
  await until(() => first.hp.ackedRevision === 10, 'Clear records propagates');
  assert.equal(second.hp.ackedRevision, 8);
  second.resume();
  await until(() => second.hp.ackedRevision === 10, 'Recover latest clear after missed revisions');
  assert.equal(received2.at(-1).payload.count, 0);
  host.sendSnapshot({ count: 999 }, 3);
  await delay(10);
  assert.equal(host.latestSnapshot.revision, 10);
  assert.equal(received2.at(-1).revision, 10);
  // Repeated snapshots are acknowledged but never replayed as extra operations.
  const previousCount = received2.length;
  host.sendSnapshot({ count: 0 }, 10);
  await delay(20);
  assert.equal(received2.length, previousCount);
  assert.ok(hostStates.some(state => state.syncedCount === 2));
  first.hp.lastSeen = Date.now() - 30000;
  host.status();
  assert.equal(hostStates.at(-1).disconnectedCount, 1);
  console.log('sync-client-smoke: codec, no online transports, multiple mirrors, late join, large chunks, ACK, outage recovery, dedupe, stale heartbeat: ok');
} finally { host.disconnect(); mirror1.disconnect(); mirror2.disconnect(); }
