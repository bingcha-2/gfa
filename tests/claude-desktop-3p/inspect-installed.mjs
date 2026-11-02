// Read-only, version-specific spike for Claude Desktop 3.6556.2 on macOS.
// Execute only extracted pure request-building functions, never the app bundle.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const archive = readFileSync("/Applications/Claude.app/Contents/Resources/app.asar");
const headerSize = archive.readUInt32LE(4);
const header = JSON.parse(archive.subarray(16, 16 + archive.readUInt32LE(12)));
const files = header.files[".vite"].files.build.files;
function readEntry(entry) {
  assert(!entry.unpacked, "Expected a packed ASAR entry");
  const start = 8 + headerSize + Number(entry.offset);
  return archive.subarray(start, start + entry.size).toString("utf8");
}
const match = Object.entries(files).find(([name, entry]) =>
  name.startsWith("index.chunk-") && name.endsWith(".js") && !entry.unpacked &&
  readEntry(entry).includes("function fgn(") && readEntry(entry).includes("inferenceGatewayBaseUrl"));
assert(match, "Installed Desktop changed; inspect new function names before rerunning");
const [bundle, entry] = match;
const source = readEntry(entry);
function between(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert(from >= 0 && to > from, `Expected vendor function boundary: ${start}`);
  return source.slice(from, to);
}
const pureSource = [
  `const ${between("Gwe=", ",Kwe=")};`,
  between("function Non(", "function LT("),
  between("function zT(", "var Ron="),
  between("function fgn(", "async function MD("),
].join("\n");
const buildRequest = new Function(`${pureSource}\nreturn fgn;`)();
const key = "gfa-desktop-fixture";
const built = buildRequest("https://gateway.example.test/api/gateway/", key, "bearer", {});
assert.equal(built.requestUrl, "https://gateway.example.test/api/gateway/v1/messages");
assert.equal(built.headers.authorization, `Bearer ${key}`);
assert.equal(built.headers["anthropic-version"], "2023-06-01");
assert.equal(built.headers["anthropic-beta"], undefined);
const evidence = {
  bundle, archiveSha256: createHash("sha256").update(archive).digest("hex"),
  extractedPureRequestBuilder: "passed", requestUrl: built.requestUrl,
  gatewayProfileFieldsPresent: ["inferenceGatewayBaseUrl", "inferenceGatewayApiKey", "inferenceGatewayAuthScheme", "inferenceModels"].every(key => source.includes(key)),
  thirdPartyDisablesClaudeAiFeatures: source.includes("hasClaudeAiProductFeatures(){return!1}"),
  thirdPartyDisablesRemoteCoworkMemorySync: source.includes("canSyncCoworkMemoryRemotely(){return!1}"),
  signedBuildIgnoresCustomUserDataEnv: Object.entries(files).some(([name, entry]) => name.endsWith(".js") && !entry.unpacked && readEntry(entry).includes("signed builds ignore it")),
  fullDesktopSessionTested: false,
};
if (process.argv[2] === "--send") {
  const target = new URL(process.argv[3]);
  assert.equal(target.hostname, "127.0.0.1", "Spike sends only to a loopback fixture");
  const options = buildRequest(target.href, key, "bearer", {});
  const result = await fetch(options.requestUrl, { method: "POST", headers: options.headers, body: readFileSync(0), signal: AbortSignal.timeout(10000) });
  console.log(JSON.stringify({ status: result.status, body: await result.text() }));
} else {
  console.log(JSON.stringify(evidence, null, 2));
}
