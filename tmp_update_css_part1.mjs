import fs from 'fs';
import path from 'path';

const file = 'C:/Users/Administrator/Desktop/GFA/apps/web/src/app/globals.css';
let content = fs.readFileSync(file, 'utf-8');

content = content.replace(
  /:root \{[\s\S]*?\}/,
  `:root {
  --background: #050a15;
  --foreground: #e0faff;
  --foreground-muted: rgba(224, 250, 255, 0.68);
  --line: rgba(0, 240, 255, 0.2);
  --line-strong: rgba(0, 240, 255, 0.4);
  --accent: #00f0ff;
  --accent-strong: #00c3d9;
  --accent-soft: rgba(0, 240, 255, 0.15);
  --warm: #ff0055;
  --surface: rgba(10, 15, 30, 0.74);
  --surface-strong: rgba(10, 15, 30, 0.9);
  --shadow: 0 0 30px rgba(0, 240, 255, 0.15);
  --shadow-soft: 0 0 15px rgba(0, 240, 255, 0.08);
  --radius-xl: 4px;
  --radius-lg: 4px;
  --radius-md: 4px;
  --radius-sm: 2px;
}`
);

content = content.replace(
  /body \{[\s\S]*?\}/,
  `body {
  margin: 0;
  min-height: 100%;
  color: var(--foreground);
  background:
    radial-gradient(circle at top left, rgba(0, 240, 255, 0.15), transparent 33%),
    radial-gradient(circle at 90% 12%, rgba(255, 0, 85, 0.15), transparent 20%),
    linear-gradient(135deg, #02050a 0%, #050a15 52%, #010308 100%);
  font-family:
    "Cascadia Code", "JetBrains Mono",
    "Aptos", "Segoe UI", "PingFang SC", sans-serif;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}`
);

content = content.replace(
  /body::before \{[\s\S]*?\}/,
  `body::before {
  content: "";
  position: fixed;
  inset: 0;
  pointer-events: none;
  background-image:
    linear-gradient(rgba(0, 240, 255, 0.05) 1px, transparent 1px),
    linear-gradient(90deg, rgba(0, 240, 255, 0.05) 1px, transparent 1px);
  background-size: 40px 40px;
  mask-image: radial-gradient(circle at center, black 40%, transparent 92%);
}`
);

content = content.replace(
  /body::after \{[\s\S]*?\}/,
  `body::after {
  content: "";
  position: fixed;
  inset: 0;
  pointer-events: none;
  background: 
    linear-gradient(rgba(18, 16, 16, 0) 50%, rgba(0, 0, 0, 0.25) 50%),
    linear-gradient(90deg, rgba(255, 0, 0, 0.06), rgba(0, 255, 0, 0.02), rgba(0, 0, 255, 0.06));
  background-size: 100% 3px, 6px 100%;
  z-index: 100;
  opacity: 0.15;
}`
);

content = content.replace(
  /\.nav-strip \{[\s\S]*?\}/,
  `.nav-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 18px;
  padding: 14px 18px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: rgba(10, 15, 30, 0.54);
  backdrop-filter: blur(14px);
  box-shadow: 0 0 10px rgba(0,240,255,0.1);
}`
);

content = content.replace(
  /\.nav-mark \{[\s\S]*?\}/,
  `.nav-mark {
  width: 42px;
  height: 42px;
  display: grid;
  place-items: center;
  border-radius: 4px;
  background:
    linear-gradient(145deg, rgba(0, 240, 255, 0.18), rgba(0, 240, 255, 0.04)),
    rgba(5, 10, 20, 0.75);
  border: 1px solid var(--accent);
  box-shadow: 0 0 15px rgba(0, 240, 255, 0.2);
  font-family: "Cascadia Code", monospace;
  font-size: 20px;
  color: var(--accent);
  text-shadow: 0 0 5px var(--accent);
}`
);

content = content.replace(
  /\.public-frame \{[\s\S]*?\}/,
  `.public-frame {
  position: relative;
  overflow: hidden;
  padding: 24px;
  border: 1px solid var(--line-strong);
  border-radius: 4px;
  background: rgba(5, 10, 20, 0.85);
  box-shadow: 0 0 30px rgba(0, 240, 255, 0.1);
  backdrop-filter: blur(20px);
}`
);

content = content.replace(
  /\.public-frame::before \{[\s\S]*?\}/,
  `.public-frame::before {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  background:
    linear-gradient(130deg, rgba(0, 240, 255, 0.05), transparent 26%),
    radial-gradient(circle at top right, rgba(255, 0, 85, 0.08), transparent 24%);
  border-top: 2px solid var(--accent);
}`
);

content = content.replace(
  /\.portal-tabs \{[\s\S]*?\}/,
  `.portal-tabs {
  position: relative;
  z-index: 1;
  display: inline-flex;
  gap: 8px;
  margin-top: 18px;
  padding: 6px;
  border-radius: 4px;
  background: rgba(10, 15, 30, 0.78);
  border: 1px solid var(--line);
}`
);

content = content.replace(
  /\.tab-chip \{[\s\S]*?\}/,
  `.tab-chip {
  min-height: 42px;
  padding: 0 16px;
  border: 1px solid transparent;
  border-radius: 2px;
  background: transparent;
  color: var(--foreground-muted);
  font-family: "Cascadia Code", monospace;
  font-weight: 700;
  cursor: pointer;
  transition: all 180ms ease;
  position: relative;
}`
);

content = content.replace(
  /\.tab-chip\.active \{[\s\S]*?\}/,
  `.tab-chip.active {
  background: rgba(0, 240, 255, 0.1);
  border-color: var(--accent);
  color: var(--accent);
  box-shadow: 0 0 15px rgba(0, 240, 255, 0.2);
  text-shadow: 0 0 8px var(--accent);
}`
);

content = content.replace(
  /\.plain-index \{[\s\S]*?\}/,
  `.plain-index {
  min-width: 48px;
  height: 48px;
  display: grid;
  place-items: center;
  border-radius: 4px;
  background: rgba(0, 240, 255, 0.1);
  color: var(--accent);
  border: 1px solid var(--accent);
  box-shadow: 0 0 10px rgba(0,240,255,0.2) inset;
  font-family: "Cascadia Code", monospace;
  font-size: 0.95rem;
  font-weight: 700;
}`
);

content = content.replace(
  /\.recent-card \{[\s\S]*?\}/,
  `.recent-card {
  width: 100%;
  display: grid;
  gap: 10px;
  padding: 16px;
  border-radius: 4px;
  border: 1px solid var(--line);
  background: var(--surface);
  text-align: left;
  cursor: pointer;
  transition: all 180ms ease;
}`
);

content = content.replace(
  /\.recent-card:hover \{[\s\S]*?\}/,
  `.recent-card:hover {
  transform: translateY(-1px);
  border-color: var(--accent);
  box-shadow: 0 0 15px rgba(0, 240, 255, 0.15);
  background: rgba(0, 240, 255, 0.05);
}`
);

fs.writeFileSync(file, content, 'utf-8');
console.log('CSS updated successfully');
