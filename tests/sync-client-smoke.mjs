import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

const binaryToBase64 = (value) => Buffer.from(value, "binary").toString("base64");
const base64ToBinary = (value) => Buffer.from(value, "base64").toString("binary");
const context = {
  TextEncoder,
  TextDecoder,
  URL,
  setTimeout,
  clearTimeout,
  btoa: binaryToBase64,
  atob: base64ToBinary,
  crypto: webcrypto,
};
context.window = context;
context.WebSocket = class {};
vm.runInNewContext(
  fs.readFileSync(new URL("../sync-client.js", import.meta.url), "utf8"),
  context,
);

const toBase64Url = (value) => Buffer.from(value).toString("base64url");
const details = {
  workerUrl: "https://sync.example.workers.dev",
  roomId: "room_1234567890123456",
  accessToken: toBase64Url("a".repeat(32)),
  roomKey: toBase64Url("b".repeat(32)),
};
const client = context.VictoryPVISyncClient;
const parsed = client.parsePairingCode(client.makePairingCode(details));
assert.equal(parsed.workerUrl, details.workerUrl);
assert.equal(parsed.roomId, details.roomId);
assert.equal(parsed.accessToken, details.accessToken);
assert.equal(parsed.roomKey, details.roomKey);
assert.throws(() => client.parsePairingCode("VPVI1.invalid"));
const localDetails = {
  roomId: details.roomId,
  roomKey: details.roomKey,
  sdp: "v=0\\r\\no=- 1 2 IN IP4 127.0.0.1\\r\\n",
};
const localOffer = client.makeLocalPairingCode({ ...localDetails, type: "offer" });
const parsedLocalOffer = client.parseLocalPairingCode(localOffer, "offer");
assert.equal(parsedLocalOffer.type, "offer");
assert.equal(parsedLocalOffer.roomId, localDetails.roomId);
assert.equal(parsedLocalOffer.roomKey, localDetails.roomKey);
assert.equal(parsedLocalOffer.sdp, localDetails.sdp);
assert.throws(() => client.parseLocalPairingCode(localOffer, "answer"));
console.log("sync-client-smoke: ok");
