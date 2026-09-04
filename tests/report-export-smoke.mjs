import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const indexHtml = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const inlineScripts = [...indexHtml.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
const appScript = inlineScripts.at(-1)?.[1] || "";

function sourceBetween(startMarker, endMarker) {
  const start = appScript.indexOf(startMarker);
  const end = appScript.indexOf(endMarker, start);
  assert.ok(start >= 0, `Missing source marker: ${startMarker}`);
  assert.ok(end > start, `Missing source marker: ${endMarker}`);
  return appScript.slice(start, end);
}

assert.doesNotMatch(indexHtml, /<script[^>]+html2canvas/i);
assert.doesNotMatch(appScript, /window\.html2canvas|\.toDataURL\(|\.addImage\(/);
assert.match(appScript, /putOnlyUsedFonts:\s*true/);
assert.match(appScript, /pdf\.addFileToVFS\(PDF_FONT_VFS_FILE, fontBase64\)/);
assert.match(appScript, /pdf\.addFont\(PDF_FONT_VFS_FILE, PDF_FONT_FAMILY, "normal"\)/);
assert.match(appScript, /function pdfDrawAnnularSector/);
assert.match(appScript, /pdf\.lines\(/);
assert.match(appScript, /const PDF_MAP_VIEWBOX = Object\.freeze\(\{ width: 980, height: 650 \}\)/);
assert.match(appScript, /function pdfDrawWebAnatomy/);
assert.match(appScript, /inner: 82, outer: 116/);
assert.match(appScript, /inner: 44, outer: 78/);
assert.match(appScript, /startAngle = \(sector - 1\) \* 45 \+ 1\.4/);
assert.match(appScript, /pdfDrawAblationMap\(pdf, 10, 69, 190, 104, model\)/);
assert.match(appScript, /orientation:\s*"portrait"/);
assert.match(appScript, /format:\s*"a4"/);
assert.match(appScript, /报告版本：v1\.4\.0 · 原生矢量/);
assert.doesNotMatch(appScript, /function pdfDrawClinicalBanner|function pdfDrawAssessmentTable|function pdfDrawPageTwo/);

const vectorPdfSource = sourceBetween(
  "async function createVectorClinicalPdf",
  "function buildReportMapMarkup",
);
assert.doesNotMatch(vectorPdfSource, /临床摘要|临床结论|复核清单|建议复核事项/);
assert.match(vectorPdfSource, /const otherInfoOnPageOne = pdfDrawPageOne\(pdf, model\)/);
assert.match(vectorPdfSource, /pdfDrawOtherInfoPages\(pdf, model\)/);

const exportSource = sourceBetween(
  "async function exportClinicalReport",
  "aboutButton.addEventListener",
);
const savedFiles = [];
const messages = [];
const exportButton = { textContent: "导出 PDF 报告", disabled: false };
const patientInfo = {
  name: "测试患者",
  sex: "女",
  diagnosis: "阵发性房颤",
  procedureType: "初发",
  surgeryDate: "2026-09-03",
  recordNumber: "TEST-001",
  otherInfo: "测试备注",
};
let receivedPatientInfo = null;
const exportContext = vm.createContext({
  console,
  Date,
  window: { jspdf: { jsPDF: class {} } },
  exportButton,
  pdfExportInProgress: false,
  showToast: (message) => messages.push(message),
  localDateInputValue: () => "2026-09-03",
  createVectorClinicalPdf: async (_exportTime, received) => {
    receivedPatientInfo = received;
    return { save: (fileName) => savedFiles.push(fileName) };
  },
});
vm.runInContext(exportSource, exportContext);

await exportContext.exportClinicalReport(patientInfo);

assert.equal(receivedPatientInfo, patientInfo);
assert.deepEqual(savedFiles, ["VARIPULSE-PFA-clinical-report-2026-09-03.pdf"]);
assert.equal(exportButton.textContent, "导出 PDF 报告");
assert.equal(exportButton.disabled, false);
assert.equal(messages.at(-1), "原生矢量 A4 PDF 已生成并开始下载");

const dependencies = [
  "vendor/jspdf.umd.min.js",
  "vendor/noto-sans-sc-regular-vfs.js",
  "vendor/NotoSansSC.OFL.txt",
];
for (const dependency of dependencies) {
  assert.ok(fs.existsSync(new URL(`../${dependency}`, import.meta.url)), `Missing ${dependency}`);
}

const fontAssetPath = new URL("../vendor/noto-sans-sc-regular-vfs.js", import.meta.url);
const fontAssetPrefix = fs.readFileSync(fontAssetPath, "utf8").slice(0, 400);
assert.match(fontAssetPrefix, /window\.VICTORY_PDF_FONT_BASE64 = "/);
assert.ok(fs.statSync(fontAssetPath).size > 10_000_000, "Embedded CJK font asset looks incomplete");

console.log("report-export-smoke: ok");
