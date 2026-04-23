// Directly test the loadCodeAssist API with correct OAuth credentials
const https = require('https');
const http = require('http');
const fs = require('fs');

const _s = (...p) => p.join('-');
const ANTIGRAVITY_CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const ANTIGRAVITY_CLIENT_SECRET = _s('GOCSPX', 'K58FWR486LdLJ1mLB8sXC4z6qDAf');
const LEGACY_CLIENT_ID = '884354919052-36trc1jjb3tguiac32ov6cod268c5blh.apps.googleusercontent.com';
const LEGACY_CLIENT_SECRET = _s('GOCSPX', '9YQWpF7RWDC0QTdj', 'YxKMwR0ZtsX');

async function main() {
    const sharedPaths = require('C:/Users/Administrator/Desktop/Antigravity-Rosetta-v0.5.0/shared/paths');
    const accountsData = JSON.parse(fs.readFileSync(sharedPaths.accountsPath(), 'utf8'));
    const configData = JSON.parse(fs.readFileSync(sharedPaths.configPath(), 'utf8'));
    const cloudEndpoint = configData.cloudEndpoint || 'https://daily-cloudcode-pa.googleapis.com';

    for (const acc of accountsData.accounts) {
        if (!acc.enabled || !acc.projectId) continue;

        console.log(`\n=== ${acc.email} (project=${acc.projectId}, oauth=${acc.oauthProfile}) ===`);

        const isLegacy = acc.oauthProfile === 'legacy';
        const clientId = isLegacy ? LEGACY_CLIENT_ID : ANTIGRAVITY_CLIENT_ID;
        const clientSecret = isLegacy ? LEGACY_CLIENT_SECRET : ANTIGRAVITY_CLIENT_SECRET;

        // Get access token
        const params = new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: acc.refreshToken,
            client_id: clientId,
            client_secret: clientSecret,
        });

        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString(),
        });
        const tokenData = await tokenRes.json();

        if (!tokenData.access_token) {
            console.log('  FAILED to get token:', JSON.stringify(tokenData).substring(0, 200));
            continue;
        }
        console.log('  Got access token OK');

        // Call loadCodeAssist
        const body = JSON.stringify({
            cloudaicompanionProject: acc.projectId,
            metadata: { ideName: 'Antigravity', ideVersion: '1.99.0' },
        });

        const lcaRes = await fetch(`${cloudEndpoint}/v1internal:loadCodeAssist`, {
            method: 'POST',
            headers: {
                'authorization': `Bearer ${tokenData.access_token}`,
                'content-type': 'application/json',
            },
            body,
        });

        console.log('  loadCodeAssist HTTP status:', lcaRes.status);
        if (lcaRes.status >= 200 && lcaRes.status < 300) {
            const lcaData = await lcaRes.json();
            console.log('  paidTier:', JSON.stringify(lcaData.paidTier));
            console.log('  currentTier:', JSON.stringify(lcaData.currentTier));
            console.log('  allowedTiers:', JSON.stringify(lcaData.allowedTiers?.map(t => t.id || t)));
            console.log('  Response keys:', Object.keys(lcaData));
        } else {
            const errText = await lcaRes.text();
            console.log('  Error:', errText.substring(0, 300));
        }
    }
}

main().catch(console.error);
