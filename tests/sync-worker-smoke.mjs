import assert from "node:assert/strict";
import fs from "node:fs";

const worker = fs.readFileSync(new URL("../cloudflare/worker.js", import.meta.url), "utf8");
const client = fs.readFileSync(new URL("../sync-client.js", import.meta.url), "utf8");
const config = JSON.parse(fs.readFileSync(new URL("../cloudflare/wrangler.jsonc", import.meta.url), "utf8"));

assert.match(worker, /export class SyncRoom extends DurableObject/);
assert.match(worker, /new WebSocketPair\(\)/);
assert.match(worker, /acceptWebSocket\(server/);
assert.match(worker, /webSocketMessage\(/);
assert.match(worker, /storage\.put\("snapshot"/);
assert.match(worker, /this\.broadcast\(\{ type: "snapshot"/);
assert.equal(config.name, "victorypvi-sync");
assert.equal(config.durable_objects.bindings[0].class_name, "SyncRoom");
assert.deepEqual(config.migrations[0].new_sqlite_classes, ["SyncRoom"]);
assert.match(client, /AES-GCM/);
assert.match(client, /VPVI1\./);
assert.match(client, /sendSnapshot\(payload, revision\)/);
assert.match(client, /scheduleReconnect\(\)/);
console.log("sync-worker-smoke: ok");
