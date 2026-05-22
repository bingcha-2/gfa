#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");

const filePath = path.resolve(__dirname, "../apps/web/public/add-account.html");
let content = fs.readFileSync(filePath, "utf8");

// Normalize to \n for processing, restore later
const hadCRLF = content.includes("\r\n");
content = content.replace(/\r\n/g, "\n");

const lines = content.split("\n");

// ── Step 1: Replace sidebar nav buttons ──
const sideNavStart = lines.findIndex(l => l.includes('<aside class="side-nav">'));
const sideNavEnd = lines.findIndex((l, i) => i > sideNavStart && l.includes('</aside>'));
if (sideNavStart < 0 || sideNavEnd < 0) { console.error("Cannot find side-nav"); process.exit(1); }

lines.splice(sideNavStart, sideNavEnd - sideNavStart + 1,
  '      <aside class="side-nav">',
  '        <button class="nav-btn active" data-tab="captcha-unblock" onclick="switchWorkspace(\'captcha-unblock\')">🔓 人机解封</button>',
  '        <button class="nav-btn" data-tab="adspower" onclick="switchWorkspace(\'adspower\')" style="color:#eab308;border-color:rgba(234,179,8,.3)">AdsPower录入</button>',
  '        <button class="nav-btn" data-tab="load" onclick="switchWorkspace(\'load\')">账号负载</button>',
  '        <button class="nav-btn" data-tab="users" onclick="switchWorkspace(\'users\')">用户管理</button>',
  '        <button class="nav-btn" data-tab="employees" onclick="switchWorkspace(\'employees\')">员工管理</button>',
  '      </aside>'
);
console.log("✅ Sidebar nav buttons replaced");

// Re-join and re-split after splice to keep indices correct
content = lines.join("\n");

// ── Step 2: Remove mothers section (data-section="mothers" first occurrence — the main panel) ──
// Find and remove: <div class="panel nav-section" data-section="mothers"> ... </div>
// Also remove children and accounts sections
// And the family events section (second data-section="mothers")

function removeSectionByDataSection(src, sectionName, occurrence = 1) {
  const lines = src.split("\n");
  let found = 0;
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(`data-section="${sectionName}"`) && lines[i].includes('panel')) {
      found++;
      if (found === occurrence) {
        startIdx = i;
        break;
      }
    }
  }
  if (startIdx < 0) return src;

  // Find closing </div> at same indent level
  const indent = lines[startIdx].match(/^\s*/)[0].length;
  let depth = 0;
  let endIdx = startIdx;
  for (let i = startIdx; i < lines.length; i++) {
    const opens = (lines[i].match(/<div[\s>]/g) || []).length;
    const closes = (lines[i].match(/<\/div>/g) || []).length;
    depth += opens - closes;
    if (depth <= 0) { endIdx = i; break; }
  }
  lines.splice(startIdx, endIdx - startIdx + 1);
  return lines.join("\n");
}

content = removeSectionByDataSection(content, "mothers", 1);
console.log("✅ Removed mothers section");
content = removeSectionByDataSection(content, "children", 1);
console.log("✅ Removed children section");
content = removeSectionByDataSection(content, "accounts", 1);
console.log("✅ Removed accounts section");
// Remove family events (second mothers section)
content = removeSectionByDataSection(content, "mothers", 1);
console.log("✅ Removed family events section");

// ── Step 3: Add captcha-unblock section BEFORE adspower section ──
const captchaUnblockHTML = `        <div class="panel nav-section" data-section="captcha-unblock">
          <div class="panel-head">
            <div>
              <h2 class="panel-title">🔓 人机解封</h2>
              <div class="panel-note">解封遭遇人机挑战的 Google 账号。分两阶段：① 手工通过人机 + 自动手机验证 + 手工申诉 → ② 12小时后二次验证完成解封。</div>
            </div>
            <span class="badge"><span class="dot" id="unblockDot"></span><span id="unblockBadge">就绪</span></span>
          </div>
          <div class="bulk-import">
            <textarea id="unblockBatchText" placeholder="批量粘贴待解封账号，每行一个：&#10;邮箱|密码|恢复邮箱|TOTP密钥&#10;邮箱----密码----恢复邮箱----TOTP密钥&#10;邮箱|密码（恢复邮箱和TOTP可省略）" style="min-height:140px"></textarea>
            <div class="bulk-actions">
              <div class="panel-note">格式：<code>邮箱|密码|恢复邮箱|TOTP</code>（用 <code>|</code> 或 <code>----</code> 分隔）。阶段一需要手工完成人机挑战和申诉。</div>
              <button class="btn primary" id="unblockStartBtn" onclick="startCaptchaUnblock('first')">🔓 开始解封（阶段一）</button>
            </div>
          </div>

          <div style="display:flex;gap:8px;align-items:center;margin:12px 0 8px">
            <h3 style="margin:0;font-size:14px;font-weight:700">解封任务</h3>
            <button class="btn small" onclick="refreshUnblockTasks()">刷新</button>
          </div>

          <div id="unblockTaskList" class="accounts">
            <div class="empty">暂无解封任务</div>
          </div>

          <div style="margin-top:16px;border-top:1px solid var(--line);padding-top:14px">
            <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
              <h3 style="margin:0;font-size:14px;font-weight:700">⏳ 待二次验证</h3>
              <div class="panel-note" style="margin:0">申诉通过后（约12小时），点击下方按钮进行二次手机验证完成解封。</div>
            </div>
            <div id="unblockPhase2List" class="accounts">
              <div class="empty">暂无待二次验证的账号</div>
            </div>
          </div>
        </div>

`;

const adspowerIdx = content.split("\n").findIndex(l => l.includes('data-section="adspower"'));
if (adspowerIdx < 0) { console.error("Cannot find adspower section"); process.exit(1); }
const contentLines = content.split("\n");
contentLines.splice(adspowerIdx, 0, ...captchaUnblockHTML.split("\n"));
content = contentLines.join("\n");
console.log("✅ Added captcha-unblock HTML section");

// ── Step 4: Update page title and subtitle ──
content = content.replace(
  '<h1>BCAI Rosetta 账号管理</h1>',
  '<h1>BCAI Rosetta 管理</h1>'
);
content = content.replace(
  '<p class="subtitle">管理母号家庭组、子号席位与 Rosetta 账号池。</p>',
  '<p class="subtitle">人机解封、AdsPower 录入与续杯服务管理。</p>'
);
content = content.replace(
  '<title>BCAI Rosetta 账号管理</title>',
  '<title>BCAI Rosetta 管理</title>'
);
console.log("✅ Updated page title and subtitle");

// ── Step 5: Update DOMContentLoaded default tab ──
content = content.replace(
  'switchWorkspace("mothers")',
  'switchWorkspace("captcha-unblock")'
);
console.log("✅ Updated default tab to captcha-unblock");

// ── Step 6: Update state initialization — remove deleted state props, add new ones ──
content = content.replace(
  /const state = \{[^}]+\};/,
  'const state = { proxy: null, remote: null, accessKeys: [], accessKeySearch: "", accessKeyTotal: 0, accessKeyTotalAll: 0, employees: [], employeeAccounts: [], employeeSearch: "", activeTab: "captcha-unblock", unblockTasks: [], unblockPhase2: [] };'
);
console.log("✅ Updated state initialization");

// ── Step 7: Update refreshAll — remove deleted function calls ──
content = content.replace(
  /async function refreshAll\(\) \{[\s\S]*?\n    \}/,
  `async function refreshAll() {
      const results = await Promise.allSettled([loadProxyStatus(), loadRemoteStatus(), loadAccessKeys(), loadEmployees()]);
      renderAccessKeys();
      renderEmployees();
      loadAdspowerHistory();
      if (results.some((item) => item.status === "rejected")) {
        console.warn("Some Rosetta status requests failed", results);
      }
      if (state.remote) { renderServerOverview(state.remote); renderLoadTable(state.remote); }
      renderServiceDetails();
      refreshUnblockTasks();
    }`
);
console.log("✅ Updated refreshAll()");

// ── Step 8: Add captcha-unblock JS functions before showToast ──
const captchaUnblockJS = `
    // ── Captcha Unblock ──
    async function startCaptchaUnblock(phase) {
      const textarea = document.getElementById("unblockBatchText");
      const raw = (textarea?.value || "").trim();
      if (!raw) { showToast("请粘贴待解封的账号凭证", true); return; }

      const lines = raw.split(/\\n/).filter(l => l.trim());
      const accounts = lines.map(line => parseAdspowerCredentialLine(line)).filter(Boolean);
      if (!accounts.length) { showToast("未解析到有效账号", true); return; }

      const btn = document.getElementById("unblockStartBtn");
      if (btn) btn.disabled = true;

      try {
        for (const acc of accounts) {
          try {
            const body = {
              credentials: {
                email: acc.email,
                password: acc.password,
                recoveryEmail: acc.recoveryEmail || "",
                totpSecret: acc.totpSecret || "",
              },
              phase: phase,
              source: phase === "second" ? "captcha-unblock-phase2" : "captcha-unblock",
            };
            const res = await fetchJson(\`\${API}/captcha-unblock\`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            });
            showToast(\`\${acc.email} 解封任务已创建\`);
          } catch (err) {
            showToast(\`\${acc.email} 创建失败: \${err.message}\`, true);
          }
        }
        if (textarea) textarea.value = "";
        await refreshUnblockTasks();
      } finally {
        if (btn) btn.disabled = false;
      }
    }

    async function startPhase2Unblock(email, password, recoveryEmail, totpSecret) {
      try {
        const body = {
          credentials: { email, password, recoveryEmail: recoveryEmail || "", totpSecret: totpSecret || "" },
          phase: "second",
          source: "captcha-unblock-phase2",
        };
        await fetchJson(\`\${API}/captcha-unblock\`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        showToast(\`\${email} 二次验证任务已创建\`);
        await refreshUnblockTasks();
      } catch (err) {
        showToast(\`\${email} 创建失败: \${err.message}\`, true);
      }
    }

    async function refreshUnblockTasks() {
      try {
        const data = await fetchJson(\`\${API}/captcha-unblock/status\`);
        state.unblockTasks = data.tasks || [];
        state.unblockPhase2 = data.phase2 || [];
        renderUnblockTasks();
        renderUnblockPhase2();
        const dot = document.getElementById("unblockDot");
        const badge = document.getElementById("unblockBadge");
        const active = state.unblockTasks.filter(t => !["SUCCESS","FAILED_FINAL","UNBLOCKED"].includes(t.status));
        if (dot) dot.className = active.length ? "dot warn" : "dot ok";
        if (badge) badge.textContent = active.length ? \`\${active.length} 进行中\` : "就绪";
      } catch {
        // silent
      }
    }

    function unblockPhaseLabel(task) {
      const src = task.source || "";
      const status = task.status || "";
      if (status === "SUCCESS" || status === "UNBLOCKED") return '<span style="color:var(--accent-2)">✅ 已解封</span>';
      if (status === "FAILED_FINAL") return '<span style="color:var(--danger)">❌ 失败</span>';
      if (status === "MANUAL_REVIEW") {
        if (task.lastErrorCode === "PHONE_VERIFIED_APPEAL_REQUIRED") return '<span style="color:var(--warn)">📝 需手工申诉</span>';
        return '<span style="color:var(--warn)">⚠️ 需人工介入</span>';
      }
      if (status === "RUNNING") {
        if (src.includes("phase2")) return '<span style="color:var(--blue)">🔄 二次验证中</span>';
        return '<span style="color:var(--blue)">🔄 解封进行中</span>';
      }
      if (status === "PENDING") return '<span style="color:var(--muted)">⏳ 排队中</span>';
      return '<span style="color:var(--muted)">' + escapeHtml(status) + '</span>';
    }

    function renderUnblockTasks() {
      const container = document.getElementById("unblockTaskList");
      if (!container) return;
      const tasks = state.unblockTasks || [];
      if (!tasks.length) { container.innerHTML = '<div class="empty">暂无解封任务</div>'; return; }

      container.innerHTML = tasks.map(task => {
        const email = task.email || "unknown";
        const phase = unblockPhaseLabel(task);
        const phone = task.usedPhone ? \`📱 \${maskEmail(task.usedPhone)}\` : "";
        const time = task.createdAt ? formatDateTime(task.createdAt) : "";
        const error = task.lastErrorMessage ? \`<div style="color:var(--danger);font-size:11px;margin-top:4px">\${escapeHtml(task.lastErrorMessage.substring(0, 120))}</div>\` : "";
        return \`<div class="account-row">
          <div>
            <div class="email">\${escapeHtml(email)}</div>
            <div class="meta">\${phase} \${phone ? " · " + phone : ""} \${time ? " · " + time : ""}</div>
            \${error}
          </div>
          <div class="row-actions">
            \${task.status === "RUNNING" || task.status === "PENDING" ? "" : \`<button class="btn small" onclick="retryUnblock('\${escapeJs(task.id)}')">重试</button>\`}
          </div>
        </div>\`;
      }).join("");
    }

    function renderUnblockPhase2() {
      const container = document.getElementById("unblockPhase2List");
      if (!container) return;
      const tasks = state.unblockPhase2 || [];
      if (!tasks.length) { container.innerHTML = '<div class="empty">暂无待二次验证的账号</div>'; return; }

      container.innerHTML = tasks.map(task => {
        const email = task.email || "unknown";
        const appealTime = task.appealAt ? formatDateTime(task.appealAt) : "未知";
        const elapsed = task.appealAt ? Math.round((Date.now() - new Date(task.appealAt).getTime()) / 3600000) : 0;
        const ready = elapsed >= 12;
        const phone = task.usedPhone || "";
        return \`<div class="account-row" style="border-color:\${ready ? 'rgba(34,197,94,.4)' : 'var(--line)'}">
          <div>
            <div class="email">\${escapeHtml(email)}</div>
            <div class="meta">申诉时间: \${appealTime} · 已过 \${elapsed}h \${ready ? '<span style="color:var(--accent-2)">（可验证）</span>' : '<span style="color:var(--warn)">（等待中）</span>'} \${phone ? " · 📱 " + maskEmail(phone) : ""}</div>
          </div>
          <div class="row-actions">
            <button class="btn small\${ready ? ' primary' : ''}" onclick="startPhase2Unblock('\${escapeJs(email)}', '\${escapeJs(task.password || "")}', '\${escapeJs(task.recoveryEmail || "")}', '\${escapeJs(task.totpSecret || "")}')" \${ready ? "" : "disabled"}>
              \${ready ? "🔓 二次验证" : "⏳ 等待12h"}
            </button>
          </div>
        </div>\`;
      }).join("");
    }

    async function retryUnblock(taskId) {
      try {
        await fetchJson(\`\${API}/captcha-unblock/retry\`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ taskId }),
        });
        showToast("已重新提交");
        await refreshUnblockTasks();
      } catch (err) {
        showToast("重试失败: " + err.message, true);
      }
    }

`;

const showToastIdx = content.split("\n").findIndex(l => l.includes("function showToast("));
if (showToastIdx < 0) { console.error("Cannot find showToast"); process.exit(1); }
const finalLines = content.split("\n");
finalLines.splice(showToastIdx, 0, ...captchaUnblockJS.split("\n"));
content = finalLines.join("\n");
console.log("✅ Added captcha-unblock JS functions");

// ── Step 9: Remove the refreshQuota button since accounts tab is gone ──
content = content.replace(
  /<button class="btn" onclick="refreshQuota\(\)">刷新额度<\/button>/,
  ''
);
console.log("✅ Removed refreshQuota button");

// Restore CRLF if original had it
if (hadCRLF) {
  content = content.replace(/\n/g, "\r\n");
}

fs.writeFileSync(filePath, content, "utf8");
console.log("\n🎉 add-account.html transformed successfully!");
console.log("  - Removed: 母号池, 子号池, 账号池 tabs");
console.log("  - Added: 人机解封 tab");
console.log("  - Updated: sidebar, state, refreshAll, default tab");
