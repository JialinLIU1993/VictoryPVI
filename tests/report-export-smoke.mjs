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

function escapeHtml(value) {
  const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" };
  return String(value).replace(/[&<>"']/g, (character) => entities[character]);
}

const veins = [
  { id: "LSPV", name: "左上肺静脉", common: false },
  { id: "LIPV", name: "左下肺静脉", common: false },
  { id: "RSPV", name: "右上肺静脉", common: false },
  { id: "RIPV", name: "右下肺静脉", common: false },
];
const assessmentFor = (vein) => ({
  vein,
  progress: { target: 4, total: 3, planProgress: [true, true, true, false], countLabel: "3 / 4" },
  ablationStatus: { complete: false, coverageComplete: false, hasAblation: true },
  endpointStatus: "entrance-block",
  endpointLabel: "PVI 已验证：传入阻滞（无肺静脉电位）",
  treatmentSummary: "口部 2/2 次消融；前庭 1/2 次消融",
  criteriaSummary: "单支 PV · 待满足 · 前庭扇区 7/8 · 总数 3/≥4",
  coverageSummary: "覆盖待复核：前庭 4区",
});

const reportContext = vm.createContext({
  Intl,
  Date,
  veins,
  ridgeSites: [],
  ridgeApplications: {},
  counts: {},
  settings: { anatomyMode: "standard" },
  MIN_SINGLE_VEIN_TOTAL_APPLICATIONS: 4,
  ELECTRODE_NUMBERS: Array.from({ length: 10 }, (_, index) => index + 1),
  protocolSummary: { textContent: "标准四支肺静脉 · 口部 2 次 · 前庭 2 次" },
  lastOperation: null,
  getVeinClinicalAssessment: assessmentFor,
  getAblationOverviewMetrics: () => ({
    total: 12,
    covered: 24,
    totalPositions: 64,
    targetMetPercentage: 38,
  }),
  progressSegments: (progress) => progress
    .map((filled) => `<i class="progress-segment${filled ? " filled" : ""}"></i>`)
    .join(""),
  activeElectrodeNumbers: () => [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  buildReportMapMarkup: () => '<svg class="report-map-svg" viewBox="0 0 980 650"></svg>',
  formatOperationTime: () => "10:20",
  localDateInputValue: () => "2026-09-03",
  escapeHtml,
});
vm.runInContext(
  sourceBetween("function buildClinicalReport", "function createReportRenderFrame"),
  reportContext,
);

const basePatient = {
  name: "测试患者<script>",
  sex: "女",
  diagnosis: "阵发性房颤",
  procedureType: "初发",
  surgeryDate: "2026-09-03",
  recordNumber: "TEST-001",
  otherInfo: "短备注",
};
const shortReport = reportContext.buildClinicalReport(new Date("2026-09-03T10:20:30+08:00"), basePatient);
const longReport = reportContext.buildClinicalReport(
  new Date("2026-09-03T10:20:30+08:00"),
  { ...basePatient, otherInfo: "较长补充信息。".repeat(70) },
);

assert.equal((shortReport.match(/data-report-page/g) || []).length, 2);
assert.equal((longReport.match(/data-report-page/g) || []).length, 3);
assert.match(shortReport, /width: 210mm/);
assert.match(shortReport, /height: 297mm/);
assert.match(shortReport, /测试患者&lt;script&gt;/);
assert.match(shortReport, /单支 PV · 待满足 · 前庭扇区 7\/8 · 总数 3\/≥4/);
assert.match(shortReport, /消融与覆盖判定/);
assert.doesNotMatch(shortReport, /window\.print|print-button|A4 landscape/);

const exportSource = sourceBetween("function createReportRenderFrame", "aboutButton.addEventListener");
assert.doesNotMatch(exportSource, /window\.open|\.print\s*\(/);

const renderedCanvases = [];
const pdfCalls = { addPage: 0, addImage: [], save: null, options: null };
class FakePDF {
  constructor(options) {
    pdfCalls.options = options;
  }
  setProperties() {}
  addPage(format, orientation) {
    pdfCalls.addPage += 1;
    assert.equal(format, "a4");
    assert.equal(orientation, "portrait");
  }
  addImage(...args) {
    pdfCalls.addImage.push(args);
  }
  save(fileName) {
    pdfCalls.save = fileName;
  }
}

const fakePages = [{ id: 1 }, { id: 2 }];
const fakeReportDocument = {
  querySelectorAll: () => fakePages,
  documentElement: { scrollWidth: 794, scrollHeight: 2246 },
};
const fakeFrame = { contentDocument: fakeReportDocument, removeCalled: false, remove() { this.removeCalled = true; } };
const messages = [];
const exportButton = { textContent: "导出 PDF 报告", disabled: false };
const exportWindow = {
  jspdf: { jsPDF: FakePDF },
  html2canvas: async () => {
    const canvas = {
      width: 1588,
      height: 2246,
      toDataURL: () => "data:image/jpeg;base64,AA==",
    };
    renderedCanvases.push(canvas);
    return canvas;
  },
};
const exportContext = vm.createContext({
  console,
  Date,
  navigator: { deviceMemory: 8 },
  window: exportWindow,
  document: {},
  exportButton,
  pdfExportInProgress: false,
  showToast: (message) => messages.push(message),
  localDateInputValue: () => "2026-09-03",
  buildClinicalReport: () => "<html></html>",
});
vm.runInContext(exportSource, exportContext);
exportContext.createReportRenderFrame = () => fakeFrame;
exportContext.waitForReportLayout = async () => {};
assert.equal(exportContext.reportRenderScale(), 2);
exportContext.navigator.deviceMemory = 2;
assert.equal(exportContext.reportRenderScale(), 1.6);
exportContext.navigator.deviceMemory = 8;

await exportContext.exportClinicalReport(basePatient);

assert.deepEqual(
  { orientation: pdfCalls.options.orientation, unit: pdfCalls.options.unit, format: pdfCalls.options.format },
  { orientation: "portrait", unit: "mm", format: "a4" },
);
assert.equal(pdfCalls.addPage, 1);
assert.equal(pdfCalls.addImage.length, 2);
for (const imageCall of pdfCalls.addImage) {
  assert.deepEqual(imageCall.slice(1, 6), ["JPEG", 0, 0, 210, 297]);
}
assert.equal(pdfCalls.save, "VARIPULSE-PFA-clinical-report-2026-09-03.pdf");
assert.ok(renderedCanvases.every((canvas) => canvas.width === 1 && canvas.height === 1));
assert.equal(fakeFrame.removeCalled, true);
assert.equal(exportButton.textContent, "导出 PDF 报告");
assert.equal(exportButton.disabled, false);
assert.equal(messages.at(-1), "A4 PDF 已生成并开始下载");

for (const dependency of ["vendor/html2canvas.min.js", "vendor/jspdf.umd.min.js"]) {
  assert.ok(fs.existsSync(new URL(`../${dependency}`, import.meta.url)), `Missing ${dependency}`);
}

console.log("report-export-smoke: ok");
