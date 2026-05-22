#!/usr/bin/env node
/**
 * Obfuscation build script for token-proxy.js
 *
 * Obfuscates critical token-counting and integrity-check code to make
 * reverse-engineering and tampering significantly harder.
 *
 * Usage:
 *   node scripts/obfuscate-token-proxy.js          # obfuscate in-place
 *   node scripts/obfuscate-token-proxy.js --check   # dry-run, show stats
 *
 * Requires: npm install -g javascript-obfuscator
 *   or:     npx javascript-obfuscator (auto-installed)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const crypto = require('crypto');

const TOKEN_PROXY_PATH = path.resolve(
  __dirname,
  '../apps/gfa-extension/bundled-rosetta/token-proxy/token-proxy.js'
);
const BACKUP_DIR = path.resolve(__dirname, '../apps/gfa-extension/bundled-rosetta/token-proxy');
const INTEGRITY_HASHES_PATH = path.resolve(
  process.env.APPDATA || path.join(require('os').homedir(), '.config'),
  'Antigravity/rosetta/integrity-hashes.json'
);

const isDryRun = process.argv.includes('--check') || process.argv.includes('--dry-run');

function main() {
  if (!fs.existsSync(TOKEN_PROXY_PATH)) {
    console.error(`❌ File not found: ${TOKEN_PROXY_PATH}`);
    process.exit(1);
  }

  const original = fs.readFileSync(TOKEN_PROXY_PATH, 'utf8');
  const originalHash = crypto.createHash('sha256').update(original).digest('hex');
  const originalSize = Buffer.byteLength(original);

  console.log(`📄 Source: ${TOKEN_PROXY_PATH}`);
  console.log(`📏 Original size: ${(originalSize / 1024).toFixed(1)} KB`);
  console.log(`🔑 Original SHA-256: ${originalHash}`);

  if (isDryRun) {
    console.log('\n🔍 Dry-run mode — no changes will be made.');
    console.log('   Run without --check to perform obfuscation.');
    return;
  }

  // Create backup
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').substring(0, 19);
  const backupPath = path.join(BACKUP_DIR, `token-proxy.pre-obfuscate-${timestamp}.js`);
  fs.copyFileSync(TOKEN_PROXY_PATH, backupPath);
  console.log(`💾 Backup saved: ${backupPath}`);

  // Run javascript-obfuscator
  console.log('\n⏳ Running javascript-obfuscator...');
  const outputPath = path.join(BACKUP_DIR, `_obfuscated_output_${Date.now()}.js`);

  try {
    execSync(
      `npx -y javascript-obfuscator "${TOKEN_PROXY_PATH}" ` +
      `--output "${outputPath}" ` +
      // Medium obfuscation — good balance between protection and performance
      '--compact true ' +
      '--control-flow-flattening true ' +
      '--control-flow-flattening-threshold 0.5 ' +
      '--dead-code-injection true ' +
      '--dead-code-injection-threshold 0.2 ' +
      '--identifier-names-generator hexadecimal ' +
      '--rename-globals false ' +       // Don't rename exports/requires
      '--rename-properties false ' +     // Don't rename object properties
      '--self-defending false ' +        // Disable — can cause issues in Node.js
      '--string-array true ' +
      '--string-array-encoding rc4 ' +
      '--string-array-threshold 0.75 ' +
      '--string-array-calls-transform true ' +
      '--string-array-rotate true ' +
      '--string-array-shuffle true ' +
      '--string-array-wrappers-count 2 ' +
      '--string-array-wrappers-type function ' +
      '--split-strings true ' +
      '--split-strings-chunk-length 10 ' +
      '--transform-object-keys false ' + // Keep object keys readable for API compat
      '--unicode-escape-sequence false ' +
      '--target node ',
      {
        stdio: 'pipe',
        timeout: 120000,
      }
    );
  } catch (err) {
    console.error(`❌ Obfuscation failed: ${err.message}`);
    if (err.stderr) console.error(err.stderr.toString());
    // Clean up
    try { fs.unlinkSync(outputPath); } catch {}
    process.exit(1);
  }

  if (!fs.existsSync(outputPath)) {
    console.error('❌ Obfuscated output not found');
    process.exit(1);
  }

  // Replace original with obfuscated
  const obfuscated = fs.readFileSync(outputPath, 'utf8');
  const obfuscatedSize = Buffer.byteLength(obfuscated);
  const obfuscatedHash = crypto.createHash('sha256').update(obfuscated).digest('hex');

  fs.copyFileSync(outputPath, TOKEN_PROXY_PATH);
  fs.unlinkSync(outputPath);

  console.log(`\n✅ Obfuscation complete!`);
  console.log(`📏 Obfuscated size: ${(obfuscatedSize / 1024).toFixed(1)} KB (${((obfuscatedSize / originalSize - 1) * 100).toFixed(0)}% increase)`);
  console.log(`🔑 Obfuscated SHA-256: ${obfuscatedHash}`);
  console.log(`💾 Backup: ${backupPath}`);

  // Register the obfuscated hash in the integrity whitelist
  try {
    let data = { hashes: [] };
    try {
      data = JSON.parse(fs.readFileSync(INTEGRITY_HASHES_PATH, 'utf8'));
      if (!Array.isArray(data.hashes)) data.hashes = [];
    } catch {}

    // Add both original and obfuscated hashes
    let added = 0;
    for (const hash of [originalHash, obfuscatedHash]) {
      if (!data.hashes.includes(hash)) {
        data.hashes.push(hash);
        added++;
      }
    }
    if (added > 0) {
      data.updatedAt = new Date().toISOString();
      fs.mkdirSync(path.dirname(INTEGRITY_HASHES_PATH), { recursive: true });
      fs.writeFileSync(INTEGRITY_HASHES_PATH, JSON.stringify(data, null, 2));
      console.log(`\n🔐 Registered ${added} hash(es) in integrity whitelist:`);
      console.log(`   ${INTEGRITY_HASHES_PATH}`);
    } else {
      console.log('\n🔐 Hashes already registered in integrity whitelist.');
    }
  } catch (err) {
    console.warn(`⚠ Could not update integrity whitelist: ${err.message}`);
    console.warn(`  Manually add this hash to ${INTEGRITY_HASHES_PATH}:`);
    console.warn(`  ${obfuscatedHash}`);
  }

  console.log('\n📌 Next steps:');
  console.log('   1. Restart the remote token server to load the new integrity hash');
  console.log('   2. Package and publish your VSCode extension');
  console.log('   3. To restore the original: copy the backup file back');
}

main();
