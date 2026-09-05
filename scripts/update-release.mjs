#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const indexPath = path.join(projectRoot, "index.html");
const readmePath = path.join(projectRoot, "README.md");
const changelogPath = path.join(projectRoot, "CHANGELOG.md");
const releasePath = path.join(projectRoot, "release.json");

function argumentValues(name) {
  const values = [];
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1]) {
      values.push(args[index + 1]);
      index += 1;
    }
  }
  return values;
}

function argumentValue(name) {
  return argumentValues(name)[0] || "";
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function localIsoWithOffset(date = new Date()) {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffset = Math.abs(offsetMinutes);
  const offsetHours = Math.floor(absoluteOffset / 60);
  const offsetRemainder = absoluteOffset % 60;
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
    `${sign}${pad(offsetHours)}:${pad(offsetRemainder)}`,
  ].join("");
}

function iterationParts(iteration) {
  const match = String(iteration).match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2})?(?:[+-]\d{2}:?\d{2})?$/,
  );
  if (!match) throw new Error(`Invalid iteration timestamp: ${iteration}`);
  return {
    year: match[1],
    month: match[2],
    day: match[3],
    hour: match[4],
    minute: match[5],
  };
}

function htmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function readReleaseScript(html) {
  const match = html.match(
    /<script id="app-release" type="application\/json">([\s\S]*?)<\/script>/,
  );
  if (!match) throw new Error("Missing app-release JSON block in index.html");
  return match;
}

const version = argumentValue("--version");
const summary = argumentValue("--summary");
const changes = argumentValues("--change");
const iteration = argumentValue("--iteration") || localIsoWithOffset();

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error("Usage: node scripts/update-release.mjs --version X.Y.Z --summary \"...\" --change \"...\"");
}
if (!summary) throw new Error("Missing --summary");
const releaseChanges = changes.length ? changes : [summary];

const parts = iterationParts(iteration);
const displayIteration = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
const displayIterationZh = `${parts.year}年${Number(parts.month)}月${Number(parts.day)}日 ${Number(parts.hour)}点${Number(parts.minute)}分`;
const offsetMatch = iteration.match(/([+-])(\d{2}):?(\d{2})$/);
const offsetLabel = offsetMatch
  ? `UTC${offsetMatch[1]}${Number(offsetMatch[2])}${offsetMatch[3] === "00" ? "" : `:${offsetMatch[3]}`}`
  : "UTC";
const release = { version, iteration, summary, changes: releaseChanges };

let indexHtml = fs.readFileSync(indexPath, "utf8");
const releaseScript = readReleaseScript(indexHtml);
const releaseJson = JSON.stringify(release, null, 2)
  .split("\n")
  .map((line) => `      ${line}`)
  .join("\n");
indexHtml = indexHtml.replace(
  releaseScript[0],
  `<script id="app-release" type="application/json">\n${releaseJson}\n    </script>`,
);
indexHtml = indexHtml
  .replace(
    /const fallback = \{\s*version: "[^"]+",\s*iteration: "[^"]+",\s*summary: "[^"]+",\s*changes: \[\],\s*\};/,
    () => [
      "const fallback = {",
      `          version: ${JSON.stringify(version)},`,
      `          iteration: ${JSON.stringify(iteration)},`,
      `          summary: ${JSON.stringify(summary)},`,
      "          changes: [],",
      "        };",
    ].join("\n"),
  )
  .replace(
    /<meta name="application-version" content="[^"]+" \/>/,
    `<meta name="application-version" content="${version}" />`,
  )
  .replace(
    /<meta name="application-iteration" content="[^"]+" \/>/,
    `<meta name="application-iteration" content="${iteration}" />`,
  )
  .replace(
    /(<p class="app-meta" id="app-meta" aria-label=")[^"]+(">)/,
    `$1软件版本 ${version}，独立社区维护的非官方工具，迭代时间 ${displayIterationZh}$2`,
  )
  .replace(
    /(<span class="app-version" id="app-version">)v[^<]+/,
    `$1v${version}`,
  )
  .replace(
    /(<time id="app-iteration" datetime=")[^"]+(">)迭代于 [^<]+/,
    `$1${iteration}$2迭代于 ${displayIteration}`,
  )
  .replace(
    /(<strong id="about-release-version">)v[^<]+/,
    `$1v${version}`,
  )
  .replace(
    /(<time id="about-release-iteration" datetime=")[^"]+(">)迭代于 [^<]+/,
    `$1${iteration}$2迭代于 ${displayIteration}`,
  )
  .replace(
    /(<p id="about-release-summary">)更新内容：[\s\S]*?(<\/p>)/,
    `$1更新内容：${htmlEscape(summary)}$2`,
  )
  .replace(/releases\/(download|tag)\/desktop-v\d+\.\d+\.\d+/g, `releases/$1/desktop-v${version}`)
  .replace(/报告版本：v\d+\.\d+\.\d+/g, `报告版本：v${version}`);
fs.writeFileSync(indexPath, indexHtml);

fs.writeFileSync(releasePath, `${JSON.stringify(release, null, 2)}\n`);

let readme = fs.readFileSync(readmePath, "utf8");
const readmeBlock = `<!-- release-meta:start -->\n当前版本：**v${version}** · 迭代于 **${displayIteration}（${offsetLabel}）**\n\n本次更新：${summary} 完整更新记录见 [CHANGELOG.md](./CHANGELOG.md)。\n<!-- release-meta:end -->`;
if (!/<!-- release-meta:start -->[\s\S]*?<!-- release-meta:end -->/.test(readme)) {
  throw new Error("Missing release metadata markers in README.md");
}
readme = readme.replace(
  /<!-- release-meta:start -->[\s\S]*?<!-- release-meta:end -->/,
  readmeBlock,
);
fs.writeFileSync(readmePath, readme);

let changelog = fs.readFileSync(changelogPath, "utf8");
if (changelog.includes(`## v${version} ·`)) {
  throw new Error(`Changelog already contains v${version}`);
}
const changelogSection = [
  `## v${version} · ${displayIteration}（${offsetLabel}）`,
  "",
  `- ${summary}`,
  ...(changes.length ? changes.map((change) => `- ${change}`) : []),
  "",
].join("\n");
changelog = changelog.replace(/^# 更新记录\n\n/, `# 更新记录\n\n${changelogSection}`);
fs.writeFileSync(changelogPath, changelog);

console.log(`Updated release metadata to v${version} (${iteration})`);
