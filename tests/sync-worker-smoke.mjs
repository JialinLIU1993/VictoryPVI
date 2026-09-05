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
assert.match(worker, /request\.method === "POST" && action === "snapshot"/);
assert.match(worker, /async storeSnapshot\(parsed/);
assert.match(worker, /https:\/\/sync-room\.internal\/snapshot/);
assert.equal(config.name, "victorypvi-sync");
assert.equal(config.durable_objects.bindings[0].class_name, "SyncRoom");
assert.deepEqual(config.migrations[0].new_sqlite_classes, ["SyncRoom"]);
// The legacy Worker remains available as archived source; the webpage now uses the desktop LAN host only.
assert.doesNotMatch(client, /workers\.dev|stun:|turn:|RTCPeerConnection/);
assert.match(client, /api\/lan/);
console.log("sync-worker-smoke: ok");
