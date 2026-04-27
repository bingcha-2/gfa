#!/usr/bin/env node
'use strict';

/**
 * Debug script: Fetch the actual loadCodeAssist API response
 * to understand why planType detection returns "free".
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const ACCOUNTS_PATH = path.join(
  process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming'),
  'Antigravity', 'rosetta', 'accounts.json'
);

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const CLIENT_SECRET = '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';

function httpPost(url, headers, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function refreshToken(rt) {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: rt,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  }).toString();

  const res = await httpPost(GOOGLE_TOKEN_URL, {
    'content-type': 'application/x-www-form-urlencoded',
    'content-length': String(Buffer.byteLength(params)),
  }, params);

  const data = JSON.parse(res.body);
  return data.access_token;
}

async function main() {
  const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_PATH, 'utf8')).accounts;
  
  const ENDPOINTS = [
    'https://daily-cloudcode-pa.sandbox.googleapis.com',
  ];

  for (const acc of accounts) {
    if (!acc.enabled || !acc.refreshToken) continue;
    
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Account: ${acc.email}`);
    console.log(`Current planType in file: "${acc.planType}"`);
    console.log(`ProjectId: ${acc.projectId || '(none)'}`);
    
    try {
      const token = await refreshToken(acc.refreshToken);
      
      for (const endpoint of ENDPOINTS) {
        // Test loadCodeAssist
        const payload = JSON.stringify({
          metadata: { ideType: 'ANTIGRAVITY' },
        });
        
        const res = await httpPost(`${endpoint}/v1internal:loadCodeAssist`, {
          'authorization': `Bearer ${token}`,
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(payload)),
          'user-agent': 'antigravity/1.99.0 google-api-nodejs-client/10.3.0',
        }, payload);
        
        console.log(`\n  loadCodeAssist SANDBOX (${res.status}):`);
        
        if (res.status >= 200 && res.status < 300) {
          const data = JSON.parse(res.body);
          // Print all tier-related fields
          console.log(`    paidTier: ${JSON.stringify(data.paidTier)}`);
          console.log(`    currentTier.id: ${data.currentTier?.id}`);
          console.log(`    currentTier.name: ${data.currentTier?.name}`);
          console.log(`    allowedTiers: ${JSON.stringify((data.allowedTiers || []).map(t => ({id: t.id, name: t.name, isDefault: t.isDefault})))}`);
          console.log(`    ineligibleTiers: ${JSON.stringify(data.ineligibleTiers?.map(t => t.reasonCode) || [])}`);
          console.log(`    upgradeSubscriptionType: ${data.currentTier?.upgradeSubscriptionType || '(none)'}`);
          
          // Apply Antigravity-Manager's multi-level logic
          let tier = data.paidTier?.name || data.paidTier?.id || '';
          if (!tier) {
            const isIneligible = Array.isArray(data.ineligibleTiers) && data.ineligibleTiers.length > 0;
            if (!isIneligible) {
              tier = data.currentTier?.name || data.currentTier?.id || '';
            } else {
              const allowed = data.allowedTiers || [];
              const def = allowed.find(t => t.isDefault === true);
              if (def) tier = (def.name || def.id) + ' (Restricted)';
            }
          }
          console.log(`    >>> DETECTED TIER: "${tier}"`);
          
          // Print all top-level keys
          console.log(`    TOP-LEVEL KEYS: ${Object.keys(data).join(', ')}`);
        } else {
          console.log(`    ERROR: ${res.body.substring(0, 300)}`);
        }
      }
    } catch (err) {
      console.log(`  ERROR: ${err.message}`);
    }
    
    // Rate limit
    await new Promise(r => setTimeout(r, 1000));
  }
}

main().catch(console.error);
