import './style.css';

import {
    GetConfig,
    SaveConfig,
    ActivateCard,
    GetStats,
    RestartProxy,
    GetLogs,
    ClearLogs,
    GetIDEStatus,
    InjectSelected,
    RestoreSelected,
    GetDetectedPaths,
    BrowseForPath,
    CheckForUpdate,
    DownloadUpdate,
    RestartToUpdate,
    GetAppVersion,
    GetPoolAccounts,
    GetPoolStatus,
    AddPoolAccount,
    RemovePoolAccount,
    TogglePoolAccount,
    SetPoolMode,
    GetPoolMode,
} from '../wailsjs/go/main/App';

import { BrowserOpenURL } from '../wailsjs/runtime/runtime';

let currentConfig = null;
let statsInterval = null;
let lastLogLength = 0;
let lastLogContent = '';
let isAnyInjected = false;
let logPollingInterval = null;
let countdownInterval = null;
let refillEpoch = null;

// DOM
const pillDot = document.getElementById('pill-dot');
const pillText = document.getElementById('pill-text');
const pillContainer = document.getElementById('pill-status-container');
const ideStatusText = document.getElementById('ide-status-text');
const hubStatusText = document.getElementById('hub-status-text');
const ideToggleBadge = document.getElementById('ide-toggle-badge');
const hubToggleBadge = document.getElementById('hub-toggle-badge');
const ideInjectHint = document.getElementById('ide-inject-hint');
const expiryBox = document.getElementById('expiry-box');
const expiryText = document.getElementById('expiry-text');
const btnInjectToggle = document.getElementById('btn-inject-toggle');
const statTotalReqs = document.getElementById('stat-total-reqs');
const statInputTokens = document.getElementById('stat-input-tokens');
const statOutputTokens = document.getElementById('stat-output-tokens');
const statErrors = document.getElementById('stat-errors');
const savingsBar = document.getElementById('savings-bar');
const savingsAmount = document.getElementById('savings-amount');
const currentCardInfo = document.getElementById('current-card-info');
const currentCardText = document.getElementById('current-card-text');
const btnCopyCard = document.getElementById('btn-copy-card');
const cfgAccountCard = document.getElementById('cfg-account-card');
const formProxySettings = document.getElementById('proxy-settings-form');
const cfgUpstreamProxy = document.getElementById('cfg-upstream-proxy');
const cfgDeviceId = document.getElementById('cfg-device-id');
const btnActivateCard = document.getElementById('btn-activate-card');
const btnClearLogs = document.getElementById('btn-clear-logs');
const btnCopyLogs = document.getElementById('btn-copy-logs');
const logViewBox = document.getElementById('log-view-box');
const cfgIdePath = document.getElementById('cfg-ide-path');
const cfgHubPath = document.getElementById('cfg-hub-path');
const btnSavePaths = document.getElementById('btn-save-paths');
const detectedIdePath = document.getElementById('detected-ide-path');
const detectedHubPath = document.getElementById('detected-hub-path');
const customModal = document.getElementById('custom-modal');
const modalTitle = document.getElementById('modal-title');
const modalBodyText = document.getElementById('modal-body-text');
const modalFooterBtns = document.getElementById('modal-footer-btns');
const modalCloseX = document.getElementById('modal-close-x');
let modalResolve = null;
const infoActiveAccount = document.getElementById('info-active-account');
const infoLeaseStatus = document.getElementById('info-lease-status');

// ===== Page Routing =====
let currentPage = 'home';
document.querySelectorAll('.nav-item[data-page]').forEach(item => {
    item.addEventListener('click', () => {
        const pg = item.dataset.page;
        currentPage = pg;
        document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + pg));
        document.querySelectorAll('.nav-item[data-page]').forEach(n => n.classList.toggle('active', n.dataset.page === pg));
        if (pg === 'logs' && !logPollingInterval) startLogPolling();
        if (pg === 'pool') refreshPoolAccounts();
        if (pg === 'settings') loadSettingsPage();
    });
});

// ===== Log Polling =====
let logFilter = 'all', logSearchQuery = '';
function startLogPolling() { pollLogs(); if (logPollingInterval) clearInterval(logPollingInterval); logPollingInterval = setInterval(pollLogs, 1500); }
async function pollLogs() { try { const raw = await GetLogs(); if (raw === lastLogContent) return; lastLogContent = raw; renderFilteredLogs(raw.split('\n').filter(l => l.trim())); } catch(e){} }
function renderFilteredLogs(lines) {
    if (!logViewBox) return;
    const filtered = lines.filter(line => {
        if (logSearchQuery && !line.toLowerCase().includes(logSearchQuery.toLowerCase())) return false;
        if (logFilter === 'all') return true;
        const lo = line.toLowerCase();
        if (logFilter === 'error') return lo.includes('error') || lo.includes('failed');
        if (logFilter === 'warn') return lo.includes('warn') || lo.includes('retrying');
        if (logFilter === 'proxy') return lo.includes('[proxy]');
        if (logFilter === 'inject') return lo.includes('[ide-inject]');
        if (logFilter === 'pool') return lo.includes('[pool]') || lo.includes('[local-pool]');
        return true;
    });
    logViewBox.innerHTML = '';
    filtered.forEach(line => logViewBox.appendChild(createLogElement(line)));
    logViewBox.scrollTop = logViewBox.scrollHeight;
}
document.querySelectorAll('.log-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => { document.querySelectorAll('.log-filter-btn').forEach(b => b.classList.remove('active')); btn.classList.add('active'); logFilter = btn.dataset.filter; lastLogContent = ''; pollLogs(); });
});
const logSearchInput = document.getElementById('log-search');
if (logSearchInput) logSearchInput.addEventListener('input', () => { logSearchQuery = logSearchInput.value; lastLogContent = ''; pollLogs(); });
if (btnClearLogs) btnClearLogs.addEventListener('click', async () => { try { await ClearLogs(); lastLogContent = ''; if (logViewBox) logViewBox.innerHTML = ''; } catch(e){} });
if (btnCopyLogs) btnCopyLogs.addEventListener('click', () => { if (!logViewBox) return; const text = Array.from(logViewBox.querySelectorAll('.log-line')).map(el => el.dataset.raw || el.textContent).join('\n'); navigator.clipboard.writeText(text); });

// ===== 5h Countdown =====
function startRefillCountdown() { refillEpoch = Date.now(); if (countdownInterval) clearInterval(countdownInterval); countdownInterval = setInterval(updateRefillCountdown, 1000); }
function updateRefillCountdown() { const el = document.getElementById('refill-countdown'); if (!el||!refillEpoch) return; const r = Math.max(0, 5*3600000-(Date.now()-refillEpoch)); if (r<=0){el.textContent='已恢复';el.style.color='var(--success)';refillEpoch=Date.now();return;} const h=Math.floor(r/3600000),m=Math.floor((r%3600000)/60000),s=Math.floor((r%60000)/1000); el.textContent=`${h}h ${String(m).padStart(2,'0')}m ${String(s).padStart(2,'0')}s`; el.style.color=r<1800000?'var(--success)':'var(--warn)'; }

// ===== Settings Page =====
async function loadSettingsPage() { try { const cfg=await GetConfig(); if(cfgUpstreamProxy) cfgUpstreamProxy.value=cfg.upstreamProxy||''; const ad=document.getElementById('about-device-id'); if(ad) ad.textContent=cfg.deviceId||'-'; try{const v=await GetAppVersion();const el=document.getElementById('about-version');if(el) el.textContent='v'+v;}catch(e){} const paths=await GetDetectedPaths(); if(cfgIdePath) cfgIdePath.value=cfg.idePath||paths.idePath||''; if(cfgHubPath) cfgHubPath.value=cfg.hubPath||paths.hubPath||''; if(detectedIdePath) detectedIdePath.textContent=cfg.idePath?'自定义':(paths.idePath?'已检测':'未检测到'); if(detectedHubPath) detectedHubPath.textContent=cfg.hubPath?'自定义':(paths.hubPath?'已检测':'未检测到'); } catch(e){} }

// 初始化
async function initApp() {
    try {
        const cfg = await GetConfig();
        currentConfig = cfg;
        
        cfgAccountCard.value = '';
        cfgUpstreamProxy.value = cfg.upstreamProxy || '';
        cfgDeviceId.textContent = cfg.deviceId || '-';

        renderCardInfoCard(cfg.accountCard);

        updateStats();
        statsInterval = setInterval(updateStats, 1500);
        updateIDEStatus();
        startRefillCountdown();
        startLogPolling();
    } catch (err) {
        addLogLine('[系统] 读取本地配置失败: ' + err, 'error');
    }
}

function renderCardInfoCard(accountCard) {
    if (accountCard && accountCard.trim() !== '') {
        currentCardInfo.style.display = 'flex';
        currentCardText.textContent = maskCard(accountCard);
        cfgAccountCard.placeholder = '输入新账号卡以更换';
        btnActivateCard.textContent = '保存新账号卡';
    } else {
        currentCardInfo.style.display = 'none';
        cfgAccountCard.placeholder = '输入账号卡 (AI...)';
        btnActivateCard.textContent = '验证激活';
    }
}

// IDE 产品检测状态
let ideDetected = true, hubDetected = true;

// 更新 IDE 注入状态 + 切换按钮显示
async function updateIDEStatus() {
    try {
        const status = await GetIDEStatus();
        let anyInjected = false;

        for (const product of status.products) {
            if (product.id === 'antigravity_ide') {
                if (product.detected) {
                    ideDetected = true;
                    ideStatusText.textContent = product.injected ? '已接管' : '未接管';
                    ideStatusText.className = 'ide-product-status' + (product.injected ? ' status-active' : '');
                    if (product.injected) anyInjected = true;
                } else {
                    ideDetected = false;
                    ideStatusText.textContent = '未安装';
                    ideStatusText.className = 'ide-product-status';
                    ideToggleBadge.dataset.selected = 'false';
                    ideToggleBadge.classList.add('disabled');
                }
            } else if (product.id === 'antigravity_hub') {
                if (product.detected) {
                    hubDetected = true;
                    hubStatusText.textContent = product.injected ? '已接管' : '未接管';
                    hubStatusText.className = 'ide-product-status' + (product.injected ? ' status-active' : '');
                    if (product.injected) anyInjected = true;
                } else {
                    hubDetected = false;
                    hubStatusText.textContent = '未安装';
                    hubStatusText.className = 'ide-product-status';
                    hubToggleBadge.dataset.selected = 'false';
                    hubToggleBadge.classList.add('disabled');
                }
            }
        }

        // LS proxy status
        const lsRow = document.getElementById('ls-status-row');
        const lsDot = document.getElementById('ls-dot');
        const lsText = document.getElementById('ls-text');
        if (lsRow && anyInjected) {
            lsRow.style.display = 'flex';
            if (status.isLsProxyApplied) {
                lsDot.className = 'ls-dot ok';
                lsText.textContent = 'Language Server 已连接代理';
            } else {
                lsDot.className = 'ls-dot partial';
                lsText.textContent = 'Language Server 尚未全部接管';
            }
        } else if (lsRow) {
            lsRow.style.display = 'none';
        }

        updateBadgeDisplay(ideToggleBadge);
        updateBadgeDisplay(hubToggleBadge);

        isAnyInjected = anyInjected;
        updateToggleButton();
    } catch (err) {
        console.error('IDE status check failed:', err);
    }
}

function updateBadgeDisplay(badge) {
    const selected = badge.dataset.selected === 'true';
    badge.textContent = selected ? '✓' : '○';
    if (selected && !badge.classList.contains('disabled')) {
        badge.classList.add('selected');
    } else {
        badge.classList.remove('selected');
    }
}

// 整行点击切换选中状态
document.getElementById('ide-product-ide').addEventListener('click', () => {
    if (!ideDetected) return;
    ideToggleBadge.dataset.selected = ideToggleBadge.dataset.selected === 'true' ? 'false' : 'true';
    updateBadgeDisplay(ideToggleBadge);
});

document.getElementById('ide-product-hub').addEventListener('click', () => {
    if (!hubDetected) return;
    hubToggleBadge.dataset.selected = hubToggleBadge.dataset.selected === 'true' ? 'false' : 'true';
    updateBadgeDisplay(hubToggleBadge);
});

// 根据注入状态切换按钮文本和样式
function updateToggleButton() {
    if (isAnyInjected) {
        btnInjectToggle.textContent = '⏹ 停止接管';
        btnInjectToggle.className = 'btn btn-d btn-inject-toggle injected';
        ideInjectHint.textContent = '';
    } else {
        btnInjectToggle.textContent = '🔌 开启接管';
        btnInjectToggle.className = 'btn btn-p btn-inject-toggle';
        ideInjectHint.textContent = '点击右侧圆标选择产品，再点击按钮开启接管。';
    }
}

// 接管切换按钮点击
btnInjectToggle.addEventListener('click', async () => {
    if (isAnyInjected) {
        await doRestore();
    } else {
        await doInject();
    }
});

async function doInject() {
    const targets = [];
    if (ideToggleBadge.dataset.selected === 'true' && ideDetected) targets.push('ide');
    if (hubToggleBadge.dataset.selected === 'true' && hubDetected) targets.push('hub');

    if (targets.length === 0) {
        // 弹出提示让用户选择产品
        showModal('⚠️ 请选择产品', '请先在上方勾选要接管的产品（Antigravity IDE 或 Hub），再点击开启接管。');
        return;
    }

    // 校验卡密 / 本地号池是否已配置
    const cfg = await GetConfig();
    const poolMode = cfg.poolMode || 'remote';
    if (poolMode === 'remote') {
        if (!cfg.accountCard || cfg.accountCard.trim() === '') {
            showModal('⚠️ 请先激活账号卡', '当前为远程续杯模式，请先在下方输入并激活账号卡，再开启接管。');
            return;
        }
    } else if (poolMode === 'local') {
        try {
            const poolStatus = await GetPoolStatus();
            if (!poolStatus.total || poolStatus.total <= 0) {
                showModal('⚠️ 本地号池为空', '当前为本地号池模式，但尚未添加任何账号。请先添加至少一个账号，再开启接管。');
                return;
            }
        } catch (e) { /* 号池检查失败不阻塞 */ }
    }

    btnInjectToggle.disabled = true;
    btnInjectToggle.textContent = '接管中...';
    try {
        const result = await InjectSelected(targets);
        (result || '').split('\n').forEach(line => {
            if (line.trim()) addLogLine('[系统] ' + line, line.includes('失败') ? 'error' : 'success');
        });
        await updateIDEStatus();
    } catch (err) {
        addLogLine('[系统] 操作失败: ' + err, 'error');
    } finally {
        btnInjectToggle.disabled = false;
        updateToggleButton();
    }
}

async function doRestore() {
    // 根据 UI 状态恢复已接管的产品，不重新检测（避免 IDE 重启后状态丢失）
    const targets = [];
    if (ideStatusText.textContent === '已接管') targets.push('ide');
    if (hubStatusText.textContent === '已接管') targets.push('hub');

    if (targets.length === 0) {
        addLogLine('[系统] 没有检测到已接管的产品', 'warn');
        return;
    }

    btnInjectToggle.disabled = true;
    btnInjectToggle.textContent = '恢复中...';
    try {
        const result = await RestoreSelected(targets);
        (result || '').split('\n').forEach(line => {
            if (line.trim()) addLogLine('[系统] ' + line, line.includes('失败') ? 'error' : 'system');
        });
        await updateIDEStatus();
    } catch (err) {
        addLogLine('[系统] 操作失败: ' + err, 'error');
    } finally {
        btnInjectToggle.disabled = false;
        updateToggleButton();
    }
}


// 刷新状态
async function updateStats() {
    try {
        const data = await GetStats();
        const cfg = await GetConfig();
        currentConfig = cfg;

        // ---- 运行信息：显示当天数据 ----
        const today = data.today || {};
        if (statTotalReqs) statTotalReqs.textContent = (today.requests || 0).toLocaleString();
        if (statInputTokens) statInputTokens.textContent = formatTokens(today.inputTokens || 0);
        if (statOutputTokens) statOutputTokens.textContent = formatTokens(today.outputTokens || 0);
        if (statErrors) statErrors.textContent = (today.errors || 0).toLocaleString();

        // ---- 已节省：显示累计总金额 ----
        const cumSaving = data.cumulativeSaving || 0;
        if (savingsAmount) savingsAmount.textContent = `$${cumSaving.toFixed(2)}`;
        if (savingsBar) savingsBar.style.display = 'flex';

        // ---- 代理状态 ----
        const proxyStatusDot = document.getElementById('proxy-status-dot');
        const proxyStatusText = document.getElementById('proxy-status-text');
        if (proxyStatusDot && proxyStatusText) {
            if (data.proxyRunning) {
                proxyStatusDot.className = 'badge-dot active';
                proxyStatusText.textContent = `代理 :${data.proxyPort}`;
            } else {
                proxyStatusDot.className = 'badge-dot error';
                proxyStatusText.textContent = '代理未启动';
            }
        }

        // ---- 服务状态 ----
        const leaserState = data.leaser.serviceState || 'unconfigured';
        let stateChinese = '未激活';
        if (leaserState === 'ready') stateChinese = '授权有效';
        else if (leaserState === 'waiting_first_lease') stateChinese = '获取令牌...';
        else if (leaserState === 'error') stateChinese = '卡号异常';

        const serviceBadgeText = document.getElementById('service-badge-text');
        const statusCardBadge = document.getElementById('status-card-badge');
        if (serviceBadgeText) serviceBadgeText.textContent = stateChinese;
        if (statusCardBadge) statusCardBadge.className = 'activation-banner ' + leaserState;

        // ---- 账户/租约信息 ----
        const infoActiveAccount = document.getElementById('info-active-account');
        const infoLeaseStatus = document.getElementById('info-lease-status');
        if (infoActiveAccount) {
            infoActiveAccount.textContent = data.leaser.accountId ? `账户 ID #${data.leaser.accountId}` : '暂无';
        }
        let leaseStatusStr = '闲置';
        if (data.leaser.autoLeaseRunning) {
            leaseStatusStr = data.leaser.hasToken ? '正常工作' : '获取令牌...';
        }
        if (data.leaser.lastError) {
            leaseStatusStr = `异常: ${data.leaser.lastError}`;
        }
        if (infoLeaseStatus) infoLeaseStatus.textContent = leaseStatusStr;

        // ---- 到期时间 ----
        const expiryVal = data.leaser.activationExpiresAt;
        const expiryBox = document.getElementById('expiry-box');
        const expiryText = document.getElementById('expiry-text');
        if (expiryVal && expiryVal !== '' && expiryVal !== 'null') {
            const d = new Date(expiryVal);
            const isValid = !isNaN(d.getTime());
            if (isValid) {
                const dateStr = d.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
                if (expiryText) { expiryText.textContent = dateStr; }
                if (expiryBox) { expiryBox.style.display = 'flex'; }
            } else {
                if (expiryBox) expiryBox.style.display = 'none';
            }
        } else {
            if (expiryBox) expiryBox.style.display = 'none';
        }

        // ---- Pill 状态条 ----
        const stats = data.stats || {};
        if (pillDot && pillText && pillContainer) {
            if (!data.proxyRunning) {
                pillDot.className = 'dot dot-off';
                pillText.innerHTML = '代理未启动 · 请点击重启代理';
                pillContainer.className = 'pill';
            } else if (data.leaser.lastError) {
                pillDot.className = 'dot dot-err';
                pillText.innerHTML = '<b>错误</b> · ' + escapeHtml(data.leaser.lastError);
                pillContainer.className = 'pill pill-error';
            } else if (leaserState === 'waiting_first_lease') {
                pillDot.className = 'dot dot-warn';
                pillText.innerHTML = '<b>获取租约中</b> · 正在连接上游网关';
                pillContainer.className = 'pill';
            } else if (leaserState === 'unconfigured' || !cfg.accountCard) {
                pillDot.className = 'dot dot-off';
                pillText.innerHTML = '请配置并激活账号卡以开始接管';
                pillContainer.className = 'pill';
            } else {
                const hasGeneration = stats.totalSuccessfulGenerations > 0;
                pillDot.className = 'dot dot-on';
                pillText.innerHTML = '<b>' + (hasGeneration ? '服务正常' : '代理已就绪') + '</b> · 127.0.0.1:' + data.proxyPort;
                pillContainer.className = 'pill pill-active';
            }
        }

        // ---- 用量统计报表 ----
        updateUsageReport(data);

        // ---- 自动更新状态 ----
        if (data.updateStatus) {
            handleUpdateStatus(data.updateStatus);
        }

        // ---- 号池状态 ----
        if (data.poolMode !== undefined) {
            updatePoolModeUI(data.poolMode);
        }
        if (data.poolStatus) {
            updatePoolStatusBar(data.poolStatus);
        }

    } catch (err) {
        console.error('统计抓取失败:', err);
    }
}

// ===== 用量统计报表 =====
const appStartTime = Date.now();

function updateUsageReport(data) {
    const today = data.today || {};
    const stats = data.stats || {};

    // ---- 会话时长 ----
    const dur = document.getElementById('session-duration');
    if (dur) {
        const mins = Math.floor((Date.now() - appStartTime) / 60000);
        if (mins < 60) {
            dur.textContent = `本次会话: ${mins}分钟`;
        } else {
            const hrs = Math.floor(mins / 60);
            const rm = mins % 60;
            dur.textContent = `本次会话: ${hrs}小时${rm}分钟`;
        }
    }

    // ---- Opus 用量 ----
    const opusInput = stats.opusInputTokens || 0;
    const opusOutput = stats.opusOutputTokens || 0;
    const opusTotal = opusInput + opusOutput;
    const OPUS_LIMIT = 1000000;
    const GEMINI_LIMIT = 2000000;

    const opusTokensText = document.getElementById('opus-tokens-text');
    const opusBar = document.getElementById('opus-bar');
    if (opusTokensText && opusBar) {
        if (opusTotal === 0) {
            opusTokensText.textContent = `满额度 · ${formatTokens(OPUS_LIMIT)}`;
            opusBar.style.width = '100%';
            opusBar.className = 'model-bar opus-bar full';
        } else {
            const pct = Math.min(100, (opusTotal / OPUS_LIMIT) * 100);
            opusTokensText.textContent = `${formatTokens(opusTotal)} / ${formatTokens(OPUS_LIMIT)}`;
            opusBar.style.width = pct + '%';
            opusBar.className = 'model-bar opus-bar' + (pct >= 95 ? ' exhausted' : '');
        }
    }

    // ---- Gemini 用量 ----
    const geminiInput = stats.geminiInputTokens || 0;
    const geminiOutput = stats.geminiOutputTokens || 0;
    const geminiTotal = geminiInput + geminiOutput;

    const geminiTokensText = document.getElementById('gemini-tokens-text');
    const geminiBar = document.getElementById('gemini-bar');
    if (geminiTokensText && geminiBar) {
        if (geminiTotal === 0) {
            geminiTokensText.textContent = `满额度 · ${formatTokens(GEMINI_LIMIT)}`;
            geminiBar.style.width = '100%';
            geminiBar.className = 'model-bar gemini-bar full';
        } else {
            const pct = Math.min(100, (geminiTotal / GEMINI_LIMIT) * 100);
            geminiTokensText.textContent = `${formatTokens(geminiTotal)} / ${formatTokens(GEMINI_LIMIT)}`;
            geminiBar.style.width = pct + '%';
            geminiBar.className = 'model-bar gemini-bar' + (pct >= 95 ? ' exhausted' : '');
        }
    }

    // ---- 5h 恢复倒计时 ----
    const recoveryTimeText = document.getElementById('recovery-time-text');
    const recoveryBar = document.getElementById('recovery-bar');
    const proxyStartedAt = data.proxyStartedAt;
    if (recoveryTimeText && recoveryBar && proxyStartedAt) {
        const startTime = new Date(proxyStartedAt).getTime();
        if (startTime > 0) {
            const FIVE_HOURS = 5 * 3600 * 1000;
            const elapsed = Date.now() - startTime;
            const remaining = Math.max(0, FIVE_HOURS - elapsed);
            const progressPct = Math.min(100, (elapsed / FIVE_HOURS) * 100);

            if (remaining <= 0) {
                recoveryTimeText.textContent = '已恢复';
                recoveryTimeText.className = 'recovery-time done';
                recoveryBar.style.width = '100%';
                recoveryBar.className = 'model-bar recovery-bar done';
            } else {
                const h = Math.floor(remaining / 3600000);
                const m = Math.floor((remaining % 3600000) / 60000);
                const s = Math.floor((remaining % 60000) / 1000);
                recoveryTimeText.textContent = `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
                recoveryTimeText.className = 'recovery-time' + (remaining < 1800000 ? ' done' : '');
                recoveryBar.style.width = progressPct + '%';
                recoveryBar.className = 'model-bar recovery-bar';
            }
        }
    }

    // ---- 请求统计（保留旧元素兼容）----
    const metricSuccess = document.getElementById('metric-success');
    const metricErrors = document.getElementById('metric-errors');
    const metricRetries = document.getElementById('metric-retries');
    const metricTotal = document.getElementById('metric-total');
    if (metricSuccess) metricSuccess.textContent = (today.generations || 0).toLocaleString();
    if (metricErrors) metricErrors.textContent = (today.errors || 0).toLocaleString();
    if (metricRetries) metricRetries.textContent = (today.retries || 0).toLocaleString();
    if (metricTotal) metricTotal.textContent = (today.requests || 0).toLocaleString();
}


function maskCard(card) {
    if (!card || card.length < 12) return card;
    return card.substring(0, 6) + '***' + card.substring(card.length - 4);
}

function formatTokens(n) {
    n = Number(n || 0);
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(n);
}

function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = String(s || '');
    return d.innerHTML;
}

function parseLogLine(line) {
    const raw = String(line || '');
    let time = '';
    let rest = raw;

    // 1. ISO 格式: 2026-05-22T15:04:05.000+08:00 [tag] message
    const isoMatch = raw.match(/^(\d{4}-\d{2}-\d{2}T\S+)\s+(.*)$/);
    if (isoMatch) {
        const parsedDate = new Date(isoMatch[1]);
        time = Number.isNaN(parsedDate.getTime()) ? isoMatch[1].substring(11, 19) : parsedDate.toLocaleTimeString();
        rest = isoMatch[2];
    } else {
        // 2. 简单时间格式: 15:28:59 [tag] message
        const simpleMatch = raw.match(/^(\d{1,2}:\d{2}:\d{2})\s+(.*)$/);
        if (simpleMatch) {
            time = simpleMatch[1];
            rest = simpleMatch[2];
        }
    }

    const tagMatch = rest.match(/^(\[[^\]]+\])\s*(.*)$/);
    if (tagMatch) return { raw, time, tag: tagMatch[1], message: tagMatch[2] || '' };
    // 如果没匹配到 tag，整行作为 message
    return { raw, time, tag: '', message: rest };
}

function classifyLogLine(parsed, explicitType = '') {
    const lower = parsed.raw.toLowerCase();
    const tag = parsed.tag.toLowerCase();
    const classes = ['log-line'];
    if (explicitType) {
        classes.push(explicitType);
    } else if (lower.includes('[error]') || lower.includes('failed') || lower.includes('error:') || lower.includes('失败')) {
        classes.push('error');
    } else if (lower.includes('warn') || lower.includes('blocked') || lower.includes('retrying')) {
        classes.push('warn');
    } else if (lower.includes('obtained') || lower.includes('成功') || lower.includes('完成') || lower.includes('已重启')) {
        classes.push('success');
    } else if (lower.includes('===') || tag === '[system]' || tag === '[系统]' || tag === '[app]') {
        classes.push('system');
    }
    if (tag.includes('proxy')) classes.push('tag-proxy');
    if (tag.includes('token-leaser')) classes.push('tag-leaser');
    if (tag.includes('ide-inject')) classes.push('tag-injector');
    return classes.join(' ');
}

function createLogElement(line, type = '') {
    const parsed = parseLogLine(line);
    const div = document.createElement('div');
    div.className = classifyLogLine(parsed, type);
    div.dataset.raw = parsed.raw;

    const timeSpan = document.createElement('span');
    timeSpan.className = 'log-time';
    timeSpan.textContent = parsed.time || '--:--:--';

    const tagSpan = document.createElement('span');
    tagSpan.className = 'log-tag';
    tagSpan.textContent = parsed.tag || '[log]';

    const messageSpan = document.createElement('span');
    messageSpan.className = 'log-message';
    messageSpan.textContent = parsed.message || parsed.raw;

    div.appendChild(timeSpan);
    div.appendChild(tagSpan);
    div.appendChild(messageSpan);
    return div;
}

function renderLogs(lines) {
    if (!logViewBox) return;
    logViewBox.innerHTML = '';
    lines.forEach(line => logViewBox.appendChild(createLogElement(line)));
    scrollToBottom();
}

function addLogLine(text, type = '') {
    console.log(`[${type || 'info'}] ${text}`);
    if (logViewBox) {
        logViewBox.appendChild(createLogElement(`${new Date().toLocaleTimeString()} ${text}`, type));
        scrollToBottom();
    }
}

function scrollToBottom() {
    if (logViewBox) logViewBox.scrollTop = logViewBox.scrollHeight;
}

// 事件绑定
formProxySettings.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentConfig) return;
    try {
        const val = cfgUpstreamProxy.value.trim();
        const cfg = { ...currentConfig, upstreamProxy: val };
        await SaveConfig(cfg);
        addLogLine('[系统] 前置代理设置已保存并生效。', 'system');
        const submitBtn = formProxySettings.querySelector('button[type="submit"]');
        const origText = submitBtn.textContent;
        submitBtn.textContent = '保存成功! ✓';
        submitBtn.style.background = 'rgba(52, 211, 153, 0.15)';
        submitBtn.style.color = 'var(--success)';
        setTimeout(() => { submitBtn.textContent = origText; submitBtn.style.background = ''; submitBtn.style.color = ''; }, 1500);
    } catch (err) {
        addLogLine('[系统] 保存前置代理失败: ' + err, 'error');
    }
});

btnActivateCard.addEventListener('click', async () => {
    const card = cfgAccountCard.value.trim();
    if (!card) {
        await showModal('提示', '请输入账号卡号！');
        return;
    }
    btnActivateCard.disabled = true;
    btnActivateCard.textContent = '激活中...';
    try {
        const expiry = await ActivateCard(card);
        // 格式化日期
        let expiryFormatted = expiry;
        try {
            const d = new Date(expiry);
            if (!isNaN(d.getTime())) {
                expiryFormatted = d.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
            }
        } catch(e) {}
        addLogLine(`[客户端] 卡号验证激活成功！有效期至: ${expiryFormatted}`, 'success');
        await showModal('验证激活成功', `账号卡激活成功！\n有效期至: ${expiryFormatted}`);
        const cfg = { accountCard: card, proxyPort: currentConfig ? currentConfig.proxyPort : 60670, upstreamProxy: cfgUpstreamProxy.value.trim(), deviceId: cfgDeviceId.textContent };
        await SaveConfig(cfg);
        cfgAccountCard.value = '';
        renderCardInfoCard(card);
        // 立即显示到期时间在顶部 pill
        const expiryBox = document.getElementById('expiry-box');
        const expiryTextEl = document.getElementById('expiry-text');
        if (expiryBox && expiryTextEl && expiryFormatted) {
            expiryTextEl.textContent = expiryFormatted;
            expiryBox.style.display = 'flex';
        }
    } catch (err) {
        addLogLine('[客户端] 激活失败: ' + err, 'error');
        await showModal('激活失败', `错误: ${err}`);
    } finally {
        btnActivateCard.disabled = false;
        btnActivateCard.textContent = currentConfig && currentConfig.accountCard ? '保存新账号卡' : '验证激活';
    }
});

btnCopyCard.addEventListener('click', () => {
    if (!currentConfig || !currentConfig.accountCard) return;
    navigator.clipboard.writeText(currentConfig.accountCard).then(() => {
        btnCopyCard.textContent = '✓';
        btnCopyCard.style.color = 'var(--success)';
        setTimeout(() => { btnCopyCard.innerHTML = '&#x2398;'; btnCopyCard.style.color = ''; }, 1500);
    });
});

document.getElementById('shop-banner')?.addEventListener('click', () => { BrowserOpenURL('https://pay.ldxp.cn/shop/3A2TLWOJ'); });
document.getElementById('shop-banner-settings')?.addEventListener('click', () => { BrowserOpenURL('https://pay.ldxp.cn/shop/3A2TLWOJ'); });



// 弹窗
function showModal(title, message, type = 'alert') {
    return new Promise((resolve) => {
        modalResolve = resolve;
        modalTitle.textContent = title;
        modalBodyText.textContent = message;
        modalFooterBtns.innerHTML = '';
        customModal.style.display = 'flex';
        customModal.offsetHeight;
        customModal.classList.add('show');
        if (type === 'confirm') {
            const cancelBtn = document.createElement('button');
            cancelBtn.className = 'modal-btn modal-btn-secondary';
            cancelBtn.textContent = '取消';
            cancelBtn.addEventListener('click', () => closeModal(false));
            const okBtn = document.createElement('button');
            okBtn.className = 'modal-btn modal-btn-primary';
            okBtn.textContent = '确认';
            okBtn.addEventListener('click', () => closeModal(true));
            modalFooterBtns.appendChild(cancelBtn);
            modalFooterBtns.appendChild(okBtn);
        } else {
            const okBtn = document.createElement('button');
            okBtn.className = 'modal-btn modal-btn-primary';
            okBtn.textContent = '我知道了';
            okBtn.addEventListener('click', () => closeModal(true));
            modalFooterBtns.appendChild(okBtn);
        }
    });
}

function closeModal(val) {
    customModal.classList.remove('show');
    setTimeout(() => {
        customModal.style.display = 'none';
        if (modalResolve) { modalResolve(val); modalResolve = null; }
    }, 200);
}

modalCloseX.addEventListener('click', () => closeModal(false));
customModal.addEventListener('click', (e) => { if (e.target === customModal) closeModal(false); });

// ====== Browse Buttons ======
const btnBrowseIde = document.getElementById('btn-browse-ide');
const btnBrowseHub = document.getElementById('btn-browse-hub');
if (btnBrowseIde) { btnBrowseIde.addEventListener('click', async () => { const path = await BrowseForPath('选择 Antigravity IDE 安装目录'); if (path) cfgIdePath.value = path; }); }
if (btnBrowseHub) { btnBrowseHub.addEventListener('click', async () => { const path = await BrowseForPath('选择 Antigravity Hub 安装目录'); if (path) cfgHubPath.value = path; }); }
if (btnSavePaths) { btnSavePaths.addEventListener('click', async () => { const cfg = await GetConfig(); cfg.idePath = cfgIdePath ? cfgIdePath.value.trim() : ''; cfg.hubPath = cfgHubPath ? cfgHubPath.value.trim() : ''; try { await SaveConfig(cfg); addLogLine('[设置] 安装路径已保存', 'system'); updateIDEStatus(); } catch(e) { addLogLine('[设置] 保存失败: ' + e, 'error'); } }); }

initApp();

// ====== 自动更新 UI ======
let lastUpdateStatus = '';
let updateBannerVisible = false;

function handleUpdateStatus(status) {
    if (!status || status.status === lastUpdateStatus) return;
    lastUpdateStatus = status.status;

    const banner = document.getElementById('update-banner');
    if (!banner) return;

    if (status.status === 'available') {
        banner.innerHTML = `
            <div class="update-info">
                <span class="update-icon">✨</span>
                <span>新版本 v${status.version} 可用</span>
            </div>
            <button class="btn-update" id="btn-do-update">立即更新</button>
        `;
        banner.style.display = 'flex';
        banner.className = 'update-banner available';
        document.getElementById('btn-do-update')?.addEventListener('click', doUpdate);
    } else if (status.status === 'downloading') {
        const pct = Math.round(status.percent || 0);
        banner.innerHTML = `
            <div class="update-info">
                <span class="update-icon">⬇️</span>
                <span>正在下载更新 v${status.version}... ${pct}%</span>
            </div>
            <div class="update-progress"><div class="update-progress-bar" style="width:${pct}%"></div></div>
        `;
        banner.style.display = 'flex';
        banner.className = 'update-banner downloading';
    } else if (status.status === 'ready') {
        banner.innerHTML = `
            <div class="update-info">
                <span class="update-icon">✅</span>
                <span>更新 v${status.version} 已就绪</span>
            </div>
            <button class="btn-update" id="btn-restart-update">重启应用</button>
        `;
        banner.style.display = 'flex';
        banner.className = 'update-banner ready';
        document.getElementById('btn-restart-update')?.addEventListener('click', doRestart);
    } else if (status.status === 'error' && status.error) {
        banner.innerHTML = `
            <div class="update-info">
                <span class="update-icon">⚠️</span>
                <span>更新失败: ${escapeHtml(status.error)}</span>
            </div>
            <button class="btn-update btn-retry" id="btn-retry-update">重试</button>
        `;
        banner.style.display = 'flex';
        banner.className = 'update-banner error';
        document.getElementById('btn-retry-update')?.addEventListener('click', () => {
            lastUpdateStatus = '';
            CheckForUpdate();
        });
    } else {
        banner.style.display = 'none';
    }
}

async function doUpdate() {
    const btn = document.getElementById('btn-do-update');
    if (btn) { btn.disabled = true; btn.textContent = '下载中...'; }
    try {
        await DownloadUpdate();
    } catch (err) {
        addLogLine('[updater] 下载失败: ' + err, 'error');
    }
}

async function doRestart() {
    try {
        await RestartToUpdate();
    } catch (err) {
        addLogLine('[updater] 重启失败: ' + err, 'error');
    }
}

// ===== 本地号池 UI =====

let currentPoolMode = 'remote';

function updatePoolModeUI(mode) {
    if (mode === currentPoolMode) return;
    currentPoolMode = mode || 'remote';

    document.getElementById('btn-mode-remote').classList.toggle('active', currentPoolMode === 'remote');
    document.getElementById('btn-mode-local').classList.toggle('active', currentPoolMode === 'local');
    document.getElementById('pool-panel').style.display = currentPoolMode === 'local' ? 'flex' : 'none';

    // Show/hide card config based on mode
    const cardConfig = document.querySelector('#pool-mode-card')?.nextElementSibling;
    // Account card section is only useful in remote mode, but keep visible for now

    if (currentPoolMode === 'local') {
        refreshPoolAccounts();
    }
}

function updatePoolStatusBar(status) {
    if (!status) return;
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set('pool-total', status.total || 0);
    set('pool-available', status.available || 0);
    set('pool-exhausted', status.exhausted || 0);
    set('pool-with-token', status.withToken || 0);
}

async function refreshPoolAccounts() {
    try {
        const accounts = await GetPoolAccounts();
        renderPoolAccounts(accounts || []);
    } catch (err) {
        console.error('Failed to load pool accounts:', err);
    }
}

function renderPoolAccounts(accounts) {
    const container = document.getElementById('pool-account-list');
    if (!container) return;
    if (!accounts || accounts.length === 0) { container.innerHTML = '<div class="pool-empty">暂无账号，请在下方添加</div>'; return; }
    container.innerHTML = accounts.map(acc => {
        let dotClass = 'ok';
        if (!acc.enabled) dotClass = 'disabled';
        else if (acc.quotaStatus === 'exhausted') dotClass = 'exhausted';
        else if (acc.consecutiveErrors >= 3) dotClass = 'error';
        const metaParts = [];
        if (acc.oauthProfile) metaParts.push(acc.oauthProfile);
        if (acc.hasAccessToken) metaParts.push(`token: ${acc.tokenExpiresIn}s`);
        if (acc.projectId) metaParts.push(`proj: ${acc.projectId.substring(0, 12)}...`);
        if (acc.quotaStatus === 'exhausted') metaParts.push('❗冷却中');
        // Model badges
        let modelBadgesHtml = '';
        if (acc.blockedModels && Object.keys(acc.blockedModels).length > 0) {
            const badges = Object.entries(acc.blockedModels).map(([model, until]) => {
                const remaining = new Date(until) - Date.now();
                if (remaining <= 0) return `<span class="model-badge ok"><span class="model-name">${model}</span><span class="model-countdown">可用</span></span>`;
                const h = Math.floor(remaining/3600000), m = Math.floor((remaining%3600000)/60000);
                const cls = remaining < 1800000 ? 'warning' : 'blocked';
                return `<span class="model-badge ${cls}"><span class="model-name">${model}</span><span class="model-countdown">${h}h${m}m</span></span>`;
            }).join('');
            modelBadgesHtml = `<div class="pool-model-list">${badges}</div>`;
        }
        return `<div class="pool-account-item ${acc.enabled ? '' : 'disabled'}" data-id="${acc.id}">
            <div class="pool-acc-header">
                <div class="pool-acc-dot ${dotClass}"></div>
                <div class="pool-acc-info">
                    <div class="pool-acc-email">${acc.email}</div>
                    <div class="pool-acc-meta">${metaParts.join(' · ')}</div>
                </div>
                <div class="pool-acc-actions">
                    <button class="pool-acc-btn btn-toggle" onclick="togglePoolAcc(${acc.id}, ${!acc.enabled})">${acc.enabled ? '✅' : '⚪'}</button>
                    <button class="pool-acc-btn btn-remove" onclick="removePoolAcc(${acc.id})">✖</button>
                </div>
            </div>
            ${modelBadgesHtml}
        </div>`;
    }).join('');
}

// Global handlers for onclick in rendered HTML
window.togglePoolAcc = async function(id, enabled) {
    try {
        const result = await TogglePoolAccount(id, enabled);
        if (result.success) {
            refreshPoolAccounts();
        } else {
            addLogLine('[pool] 切换失败: ' + (result.error || 'unknown'), 'error');
        }
    } catch (err) {
        addLogLine('[pool] 切换失败: ' + err, 'error');
    }
};

window.removePoolAcc = async function(id) {
    try {
        const result = await RemovePoolAccount(id);
        if (result.success) {
            refreshPoolAccounts();
            addLogLine('[pool] 账号已删除', 'info');
        } else {
            addLogLine('[pool] 删除失败: ' + (result.error || 'unknown'), 'error');
        }
    } catch (err) {
        addLogLine('[pool] 删除失败: ' + err, 'error');
    }
};

// Mode toggle buttons
document.getElementById('btn-mode-remote')?.addEventListener('click', async () => {
    if (currentPoolMode === 'remote') return;
    try {
        const result = await SetPoolMode('remote');
        if (result.success) {
            updatePoolModeUI('remote');
            addLogLine('[pool] 已切换到远程租约模式', 'info');
        }
    } catch (err) {
        addLogLine('[pool] 模式切换失败: ' + err, 'error');
    }
});

document.getElementById('btn-mode-local')?.addEventListener('click', async () => {
    if (currentPoolMode === 'local') return;
    try {
        const result = await SetPoolMode('local');
        if (result.success) {
            updatePoolModeUI('local');
            addLogLine('[pool] 已切换到本地号池模式', 'info');
        }
    } catch (err) {
        addLogLine('[pool] 模式切换失败: ' + err, 'error');
    }
});

// Add account button
document.getElementById('btn-pool-add')?.addEventListener('click', async () => {
    const email = document.getElementById('pool-add-email')?.value?.trim();
    const token = document.getElementById('pool-add-token')?.value?.trim();
    const profile = document.getElementById('pool-add-profile')?.value || 'antigravity';

    if (!email || !token) {
        addLogLine('[pool] 请填写邮箱和 Refresh Token', 'error');
        return;
    }

    const btn = document.getElementById('btn-pool-add');
    if (btn) { btn.disabled = true; btn.textContent = '添加中...'; }

    try {
        const result = await AddPoolAccount(email, token, profile);
        if (result.success) {
            addLogLine(`[pool] 账号 ${email} 添加成功 (ID: ${result.id})`, 'info');
            document.getElementById('pool-add-email').value = '';
            document.getElementById('pool-add-token').value = '';
            refreshPoolAccounts();
        } else {
            addLogLine('[pool] 添加失败: ' + (result.error || 'unknown'), 'error');
        }
    } catch (err) {
        addLogLine('[pool] 添加失败: ' + err, 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '+ 添加'; }
    }
});

// Init pool mode on startup
(async function initPoolMode() {
    try {
        const mode = await GetPoolMode();
        updatePoolModeUI(mode);
    } catch (e) {
        // default to remote
    }
})();
