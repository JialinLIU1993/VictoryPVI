import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const indexHtml = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const inlineScripts = [...indexHtml.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
const appScript = inlineScripts.at(-1)?.[1] || "";
const start = appScript.indexOf("function getVeinAblationStatus");
const end = appScript.indexOf("function getActiveRidgeSites", start);
assert.ok(start >= 0 && end > start, "Unable to locate the vein status function");

const layers = { outer: {}, inner: {} };
const counts = {};
const applications = {};
const settings = {
  innerSequenceTarget: 2,
  outerSequenceTarget: 2,
  commonSequenceTarget: 8,
};
const ringKey = (veinId, layerId) => `${veinId}:${layerId}`;
const sectorKey = (key, sector) => `${key}:${sector}`;
const context = vm.createContext({
  layers,
  counts,
  applications,
  settings,
  MIN_SINGLE_VEIN_TOTAL_APPLICATIONS: 4,
  ringKey,
  sectorKey,
  requiredVeinSectorCount: () => 1,
});
vm.runInContext(appScript.slice(start, end), context);

const singleVein = { id: "LSPV", name: "左上肺静脉", common: false };
const commonVein = { id: "LCPV", name: "左共同肺静脉", common: true };

function setApplications(vein, inner, outer) {
  applications[ringKey(vein.id, "inner")] = inner;
  applications[ringKey(vein.id, "outer")] = outer;
}

function setLayerSectorCoverage(vein, layerId, sectorCount) {
  for (let sector = 1; sector <= 8; sector += 1) {
    const key = sectorKey(ringKey(vein.id, layerId), sector);
    if (sector <= sectorCount) counts[key] = 1;
    else delete counts[key];
  }
}

setApplications(singleVein, 2, 2);
let status = context.getVeinAblationStatus(singleVein);
assert.equal(status.totalApplications, 4);
assert.equal(status.outerSectorsAtTarget, 0);
assert.equal(status.complete, false, "Four total without all vestibular sectors must fail");

setLayerSectorCoverage(singleVein, "outer", 7);
status = context.getVeinAblationStatus(singleVein);
assert.equal(status.outerSectorsAtTarget, 7);
assert.equal(status.outerSectorsComplete, false);
assert.equal(status.complete, false, "Seven of eight vestibular sectors must fail");

setLayerSectorCoverage(singleVein, "outer", 8);
setApplications(singleVein, 1, 2);
status = context.getVeinAblationStatus(singleVein);
assert.equal(status.outerSectorsComplete, true);
assert.equal(status.minimumTotalMet, false);
assert.equal(status.complete, false, "All vestibular sectors without four total must fail");

setApplications(singleVein, 2, 2);
status = context.getVeinAblationStatus(singleVein);
assert.equal(status.complete, true, "All eight vestibular sectors plus four total must pass");
assert.equal(status.coverageComplete, false, "The remaining sector coverage stays a separate check");
assert.match(status.criteriaSummary, /已满足 · 前庭扇区 8\/8 · 总数 4\/≥4/);

setApplications(singleVein, 3, 1);
assert.equal(context.getVeinAblationStatus(singleVein).complete, true, "Vestibular application count alone is not the sector criterion");

setApplications(commonVein, 4, 4);
assert.equal(context.getVeinAblationStatus(commonVein).complete, false, "Common veins still require complete coverage");
for (const layerId of Object.keys(layers)) {
  for (let sector = 1; sector <= 8; sector += 1) {
    counts[sectorKey(ringKey(commonVein.id, layerId), sector)] = 1;
  }
}
assert.equal(context.getVeinAblationStatus(commonVein).complete, true, "Common-vein behavior remains unchanged");

console.log("single-vein-isolation-smoke: ok");
