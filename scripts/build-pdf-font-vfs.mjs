import fs from "node:fs";
import path from "node:path";

const [sourcePath, outputPath] = process.argv.slice(2);
if (!sourcePath || !outputPath) {
  throw new Error("Usage: node scripts/build-pdf-font-vfs.mjs <font.ttf> <output.js>");
}

const fontBase64 = fs.readFileSync(sourcePath).toString("base64");
const output = [
  "// Generated from Noto Sans SC Regular (SIL Open Font License 1.1).",
  "// Source: https://github.com/google/fonts/tree/main/ofl/notosanssc",
  `window.VICTORY_PDF_FONT_BASE64 = "${fontBase64}";`,
  "",
].join("\n");

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, output);
console.log(`${outputPath}: ${fontBase64.length} base64 characters`);
