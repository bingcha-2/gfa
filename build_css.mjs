import fs from 'fs';

const cssContent = `
:root {
  --background: #0d1117;
  --surface: #161b22;
  --surface-strong: #21262d;
  --border-muted: #30363d;
  --border: #30363d;
  --foreground: #c9d1d9;
  --foreground-muted: #8b949e;
  
  --accent: #58a6ff;
  --accent-soft: rgba(88, 166, 255, 0.1);
  --accent-strong: #79c0ff;
  
  --success: #238636;
  --success-hover: #2ea043;
  --success-fg: #ffffff;
  
  --warm: #f85149;
  --warm-soft: rgba(248, 81, 73, 0.1);
  
  --radius-xl: 6px;
  --radius-lg: 6px;
  --radius-md: 6px;
  --radius-sm: 4px;
}

* {
  box-sizing: border-box;
}

html {
  min-height: 100%;
  scroll-behavior: smooth;
}

body {
  margin: 0;
  min-height: 100%;
  background-color: var(--background);
  color: var(--foreground);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji";
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
  position: relative;
  overflow-x: hidden;
}

/* Background animated particles (GitHub tech/sci-fi style) */
.particles-bg {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 0;
  overflow: hidden;
}

.particle {
  position: absolute;
  background-color: var(--accent);
  border-radius: 50%;
  opacity: 0;
  animation: float-up linear infinite;
  box-shadow: 0 0 4px var(--accent);
}

@keyframes float-up {
  0% { transform: translateY(100vh) scale(0); opacity: 0; }
  10% { opacity: 0.8; transform: translateY(90vh) scale(1); }
  90% { opacity: 0.8; transform: translateY(10vh) scale(1); }
  100% { transform: translateY(0vh) scale(0); opacity: 0; }
}

@keyframes fade-in-up {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}

.animate-fade-in-up {
  animation: fade-in-up 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards;
}
.delay-100 { animation-delay: 50ms; opacity: 0; }
.delay-300 { animation-delay: 100ms; opacity: 0; }

::selection {
  background: rgba(88, 166, 255, 0.3);
}

a {
  color: var(--accent);
  text-decoration: none;
}
a:hover {
  text-decoration: underline;
}

button, input, select, textarea {
  font: inherit;
}

.page-shell {
  position: relative;
  z-index: 1;
  width: min(1012px, calc(100vw - 32px));
  margin: 0 auto;
  padding: 40px 0 80px;
}
.page-shell.compact {
  width: min(1012px, calc(100vw - 32px));
}

.nav-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 24px;
}

.public-frame {
  position: relative;
  background: transparent;
}

.public-topbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 24px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border-muted);
}

.public-brand {
  display: flex;
  align-items: center;
  gap: 12px;
}
.public-brand-copy {
  display: flex;
  flex-direction: column;
}

.portal-tabs {
  display: flex;
  gap: 8px;
  border-bottom: 1px solid var(--border-muted);
  margin-bottom: 24px;
}

.tab-chip {
  padding: 8px 16px;
  border: 1px solid transparent;
  border-bottom: 2px solid transparent;
  border-radius: 6px 6px 0 0;
  background: transparent;
  color: var(--foreground-muted);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
  margin-bottom: -1px;
}

.tab-chip:hover {
  background: var(--surface-strong);
  color: var(--foreground);
}

.tab-chip.active {
  color: var(--foreground);
  border-color: var(--border-muted);
  border-bottom-color: var(--background);
  background: var(--background);
  font-weight: 600;
}

.public-grid {
  display: grid;
  gap: 24px;
  grid-template-columns: 296px 1fr;
  align-items: start;
}

@media (max-width: 768px) {
  .public-grid {
    grid-template-columns: 1fr;
  }
}

.glass-panel, .form-card, .metric-tile, .recent-card, .callout {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 24px;
}

.panel-stack {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.plain-list {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.plain-item {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}

.plain-index {
  min-width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--surface-strong);
  border: 1px solid var(--border-muted);
  color: var(--foreground-muted);
  font-size: 12px;
  font-weight: 600;
}

h2.public-panel-title {
  font-size: 20px;
  font-weight: 600;
  margin: 0 0 8px 0;
  color: var(--foreground);
}

.label {
  font-size: 12px;
  font-weight: 600;
  color: var(--foreground-muted);
  text-transform: uppercase;
  margin-bottom: 8px;
}

.muted {
  color: var(--foreground-muted);
  font-size: 14px;
  line-height: 1.5;
}

/* Forms */
.field-grid {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.field label {
  font-size: 14px;
  font-weight: 600;
  color: var(--foreground);
}

.field small {
  font-size: 12px;
  color: var(--foreground-muted);
}

input, select, textarea {
  background: #010409;
  border: 1px solid var(--border);
  color: var(--foreground);
  padding: 5px 12px;
  border-radius: var(--radius-md);
  font-size: 14px;
  line-height: 20px;
  outline: none;
  transition: border-color 0.15s, box-shadow 0.15s;
}

input:focus, select:focus, textarea:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px rgba(88, 166, 255, 0.3);
}

/* Buttons */
.button, .pill-link {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 5px 16px;
  font-size: 14px;
  font-weight: 500;
  line-height: 20px;
  white-space: nowrap;
  vertical-align: middle;
  cursor: pointer;
  border-radius: var(--radius-md);
  appearance: none;
  border: 1px solid var(--border-muted);
  background: var(--surface-strong);
  color: var(--foreground);
  text-decoration: none;
  transition: 80ms cubic-bezier(0.33, 1, 0.68, 1);
  transition-property: color, background-color, box-shadow, border-color;
}

.button:hover, .pill-link:hover {
  background: var(--border-muted);
  text-decoration: none;
}

.button.premium-primary {
  background: var(--success);
  border-color: rgba(240, 246, 252, 0.1);
  color: var(--success-fg);
}

.button.premium-primary:hover {
  background: var(--success-hover);
}

.button.secondary {
  background: transparent;
  color: var(--accent);
  border-color: var(--border-muted);
}
.button.secondary:hover {
  background: var(--surface-strong);
}

.button.danger {
  color: var(--warm);
}
.button.danger:hover {
  background: var(--warm);
  color: #fff;
  border-color: var(--warm);
}

.button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Lists and Cards */
.recent-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 16px;
  cursor: pointer;
  background: transparent;
  border: 1px solid var(--border-muted);
  transition: border-color 0.2s, background-color 0.2s;
  text-align: left;
}

.recent-card:hover {
  border-color: var(--accent);
}

.recent-card.active {
  border-color: var(--accent);
  border-left: 3px solid var(--accent);
  background: var(--surface-strong);
}

.recent-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.recent-meta {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: var(--foreground-muted);
}

.mono {
  font-family: ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, monospace;
}

/* Status variants */
.status-pill {
  font-size: 12px;
  font-weight: 500;
  padding: 2px 8px;
  border-radius: 2em;
  border: 1px solid var(--border-muted);
  background: var(--surface-strong);
  color: var(--foreground);
}

/* Notices and Alerts */
.notice {
  padding: 16px;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-muted);
  background: var(--surface-strong);
  font-size: 14px;
}

.notice.warn {
  border-color: rgba(210, 153, 34, 0.4);
  background: rgba(210, 153, 34, 0.1);
  color: #d29922;
}

.notice.error {
  border-color: rgba(248, 81, 73, 0.4);
  background: rgba(248, 81, 73, 0.1);
  color: #f85149;
}

.notice.subtle {
  background: transparent;
  border: none;
  padding: 0;
  color: var(--foreground-muted);
  font-size: 12px;
}

/* Helpers */
.flex { display: flex; }
.items-center { align-items: center; }
.gap-2 { gap: 8px; }
.gap-3 { gap: 12px; }
.mt-4 { margin-top: 16px; }

/* Keep existing animations simple */
.animate-spin {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}

`;

fs.writeFileSync('apps/web/src/app/globals.css', cssContent);
console.log('Saved globals.css successfully.');
