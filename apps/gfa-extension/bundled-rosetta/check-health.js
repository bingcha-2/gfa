const http = require('http');
http.get('http://127.0.0.1:60700/health', (res) => {
  let data = '';
  res.on('data', (chunk) => data += chunk);
  res.on('end', () => {
    const j = JSON.parse(data);
    const now = Date.now();

    console.log('=== Current Time: ' + new Date(now).toISOString() + ' ===');
    console.log('');
    console.log('totalLeases:', j.totalLeases, '(cumulative)');
    console.log('totalReports:', j.totalReports, '(report-back from clients)');
    console.log('totalErrors:', j.totalErrors);
    console.log('activeLeases:', j.activeLeases, '(right now)');
    console.log('');

    // Check which keys are actively being used (lastUsed within 30min)
    const keys = j.accessKeys || [];
    const recentKeys = keys.filter(k => {
      const lastUsed = Date.parse(k.lastUsedAt || '');
      return lastUsed > 0 && (now - lastUsed) < 30 * 60 * 1000;
    });
    console.log('=== Keys used in last 30 min: ' + recentKeys.length + ' ===');
    for (const k of recentKeys) {
      const ago = Math.round((now - Date.parse(k.lastUsedAt)) / 1000);
      console.log(
        '  ' + k.id +
        ': requests=' + k.totalRequests +
        ' tokens=' + k.totalTokensUsed +
        ' lastUsed=' + ago + 's ago' +
        ' session=' + (k.hasActiveSession ? 'ACTIVE(' + k.sessionClientId + ')' : 'expired')
      );
    }

    // Keys with active sessions
    const activeSessions = keys.filter(k => k.hasActiveSession);
    console.log('');
    console.log('=== Keys with ACTIVE sessions: ' + activeSessions.length + ' ===');
    for (const k of activeSessions) {
      const sessAgo = Math.round((now - Date.parse(k.sessionLastSeenAt || k.sessionStartedAt)) / 1000);
      console.log(
        '  ' + k.id +
        ': client=' + k.sessionClientId +
        ' lastSeen=' + sessAgo + 's ago' +
        ' requests=' + k.totalRequests +
        ' tokens=' + k.totalTokensUsed
      );
    }

    // Summary of all keys with usage
    const usedKeys = keys.filter(k => k.totalRequests > 0);
    console.log('');
    console.log('=== All keys with usage: ' + usedKeys.length + '/' + keys.length + ' ===');
    let totalReqs = 0, totalTokens = 0;
    for (const k of usedKeys) {
      totalReqs += k.totalRequests;
      totalTokens += k.totalTokensUsed;
    }
    console.log('Total requests across all keys:', totalReqs);
    console.log('Total tokens across all keys:', totalTokens);

    // Account health breakdown
    const accounts = (j.quota && j.quota.accounts) || j.accounts || [];
    if (accounts.length > 0) {
      let hasProject = 0, noProject = 0, disabled = 0, blocked = 0;
      for (const a of accounts) {
        if (!a.enabled) disabled++;
        else if (!a.projectId) noProject++;
        else if (a.blockedModels && a.blockedModels.length > 0) blocked++;
        else hasProject++;
      }
      console.log('');
      console.log('=== Account Health ===');
      console.log('Ready (enabled+projectId+noBlocks):', hasProject);
      console.log('Has model blocks:', blocked);
      console.log('No projectId:', noProject);
      console.log('Disabled:', disabled);
    }
  });
}).on('error', (err) => {
  console.error('Failed:', err.message);
});
