import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { createLanServer } from '../desktop/server.mjs';
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vpvi-lan-test-'));
const source = await fs.readFile(new URL('../sync-client.js', import.meta.url), 'utf8');
const scope = { AbortController, URLSearchParams, setTimeout, clearTimeout, crypto: webcrypto, fetch };
scope.window = scope; vm.runInNewContext(source, scope);
const Client = scope.VictoryPVISyncClient;
let app = await createLanServer({ dataDir, port: 0, bind: '127.0.0.1', pollMs: 100, leaseMs: 500 });
const base = `http://127.0.0.1:${app.port}`;
const request = (url, body) => fetch(base + '/api/lan/' + url, body ? { method: 'POST', body: JSON.stringify(body) } : undefined);
const record = count => ({ schemaVersion: 7, counts: { 'test': count }, sequenceEvents: [] });
const wait = async (condition, label) => {
  const start = Date.now();
  while (!condition()) { if (Date.now() - start > 12000) throw new Error(label); await new Promise(r => setTimeout(r, 20)); }
};
let networkDown = false, saves = [], receivedA = [], receivedB = [], errors = [], superseded = false;
const transport = (url, options) => {
  if (networkDown) return Promise.reject(new Error('simulated outage'));
  return fetch(base + url, options);
};
const host = new Client({ fetch: transport, getSnapshot: () => record(0), onSaved: ack => saves.push(ack), onSuperseded: () => superseded = true });
const a = new Client({ fetch: transport, onSnapshot: (payload, envelope) => receivedA.push({ payload, ...envelope }) });
const b = new Client({ fetch: transport, onSnapshot: payload => receivedB.push(payload), onStatus: state => { if (state.state === 'offline') errors.push(state); } });
try {
  await host.connect({ role: 'host', deviceId: 'computer', initialSnapshot: record(1) });
  await wait(() => saves.length, 'Initial record persisted');
  await Promise.all([a.connect({ role: 'mirror', deviceId: 'phone', roomId: app.roomId }), b.connect({ role: 'mirror', deviceId: 'tablet', roomId: app.roomId })]);
  await wait(() => receivedA.length && receivedB.length, 'Both mirrors receive saved state without a new edit');
  assert.equal(receivedA.at(-1).payload.counts.test, 1);
  host.sendSnapshot({ ...record(2), patientName: 'must not be saved', sequenceEvents: Array.from({ length: 1800 }, (_, n) => ({ id: n, activeElectrodes: [1, 2, 3] })) }, 2);
  await wait(() => receivedB.at(-1).counts.test === 2, 'Large snapshot reaches tablet');
  assert.equal((await fs.readFile(path.join(dataDir, 'record.json'), 'utf8')).includes('must not be saved'), false);
  networkDown = true;
  host.sendSnapshot(record(3), 3); host.sendSnapshot(record(4), 4);
  await new Promise(r => setTimeout(r, 250));
  networkDown = false;
  await wait(() => receivedA.at(-1).payload.counts.test === 4, 'Newest pending record recovers after outage');
  // A repeated request with an older client revision cannot roll state back.
  const stale = await request('snapshot', { writerId: host.writerId, clientRevision: 2, payload: record(999) });
  assert.equal(stale.status, 200);
  assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, 'record.json'), 'utf8')).snapshot.payload.counts.test, 4);
  // Restart the real server: room identity, writer epoch, and saved state survive.
  const port = app.port, roomId = app.roomId;
  await app.close();
  host.sendSnapshot(record(5), 5);
  await new Promise(r => setTimeout(r, 400));
  app = await createLanServer({ dataDir, port, bind: '127.0.0.1', pollMs: 100, leaseMs: 500 });
  assert.equal(app.roomId, roomId);
  await wait(() => receivedB.at(-1).counts.test === 5, 'Restart reconnects and persists pending edits');
  // A fresh mobile page asks for the saved snapshot using revision zero.
  a.disconnect(); receivedA = [];
  await a.connect({ role: 'mirror', deviceId: 'phone', roomId });
  await wait(() => receivedA.at(-1)?.payload.counts.test === 5, 'Refresh restores latest state');
  const previousWriter = host.writerId;
  const secondHost = new Client({ fetch: transport });
  let restored;
  await secondHost.connect({ role: 'host', deviceId: 'computer', onRestore: value => { restored = value; } });
  assert.equal(restored.counts.test, 5);
  await wait(() => superseded, 'Old operation window becomes read-only');
  assert.equal((await request('snapshot', { writerId: previousWriter, clientRevision: 100, payload: record(999) })).status, 409);
  secondHost.disconnect();
  assert.equal((await request('snapshot', { writerId: secondHost.writerId, clientRevision: 1, payload: record(1) })).status, 409);
  assert.equal((await fetch(base + '/desktop/server.mjs')).status, 404);
  assert.match(await (await fetch(base)).text(), /window.VICTORYPVI_DESKTOP=\{hostAllowed:true\}/);
  assert.ok(errors.length, 'Disconnection is visible');
  const beforeDuplicate = await fs.readFile(path.join(dataDir, 'record.json'), 'utf8');
  await assert.rejects(createLanServer({ dataDir, port: app.port, bind: '127.0.0.1' }), /EADDRINUSE/);
  assert.equal(await fs.readFile(path.join(dataDir, 'record.json'), 'utf8'), beforeDuplicate, 'Duplicate launch cannot overwrite live state');
  const writer = (await (await request('host', { deviceId: 'computer' })).json()).writerId;
  assert.equal((await request('snapshot', { writerId: writer, clientRevision: 1, payload: { ...record(10), sequenceEvents: ['x'.repeat(2200000)] } })).status, 413);
  assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, 'record.json'), 'utf8')).snapshot.payload.counts.test, 5);
  const corruptDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vpvi-corrupt-test-'));
  await fs.writeFile(path.join(corruptDir, 'record.json'), 'corrupt saved file');
  await assert.rejects(createLanServer({ dataDir: corruptDir, port: 0, bind: '127.0.0.1' }), /无法读取已保存记录/);
  assert.equal(await fs.readFile(path.join(corruptDir, 'record.json'), 'utf8'), 'corrupt saved file');
  await fs.rm(corruptDir, { recursive: true, force: true });
  console.log('sync-client-smoke: two mirrors, large records, durable ACKs, retries, restart, refresh, takeover and static serving passed');
} finally {
  host.disconnect(); a.disconnect(); b.disconnect(); await app.close(); await fs.rm(dataDir, { recursive: true, force: true });
}
