import fs from 'fs';
import path from 'path';

const file = 'C:/Users/Administrator/Desktop/GFA/apps/web/src/app/globals.css';
let content = fs.readFileSync(file, 'utf-8');

content = content.replace(
  /\.status-pill \{[\s\S]*?\}/,
  `.status-pill {
  display: inline-flex;
  align-items: center;
  min-height: 28px;
  padding: 0 10px;
  border-radius: 2px;
  background: rgba(0, 240, 255, 0.15);
  color: var(--accent);
  border: 1px solid var(--accent);
  box-shadow: 0 0 10px rgba(0, 240, 255, 0.2);
  font-size: 11px;
  font-weight: 800;
  font-family: "Cascadia Code", monospace;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}`
);

content = content.replace(
  /\.pill-link,\s*\.button \{[\s\S]*?\}/,
  `.pill-link,
.button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 38px;
  padding: 0 16px;
  border-radius: 2px;
  border: 1px solid var(--accent);
  background: rgba(0, 240, 255, 0.05);
  color: var(--accent);
  font-family: "Cascadia Code", monospace;
  font-size: 14px;
  font-weight: 600;
  text-transform: uppercase;
  transition: all 160ms ease;
  box-shadow: 0 0 10px rgba(0, 240, 255, 0.1);
  cursor: pointer;
  position: relative;
  overflow: hidden;
}`
);

content = content.replace(
  /\.pill-link:hover,\s*\.button:hover \{[\s\S]*?\}/,
  `.pill-link:hover,
.button:hover {
  transform: translateY(-1px);
  box-shadow: 0 0 20px rgba(0, 240, 255, 0.3), inset 0 0 10px rgba(0, 240, 255, 0.2);
  background: rgba(0, 240, 255, 0.15);
  color: #fff;
  text-shadow: 0 0 5px #fff, 0 0 10px var(--accent);
}`
);

content = content.replace(
  /\.button \{[\s\S]*?\}/,
  `.button {
  border-color: var(--accent);
  background: rgba(0, 240, 255, 0.1);
  color: var(--accent);
  font-weight: 700;
}`
);

content = content.replace(
  /\.button\.secondary \{[\s\S]*?\}/,
  `.button.secondary {
  border-color: rgba(255, 255, 255, 0.2);
  background: transparent;
  color: var(--foreground-muted);
  box-shadow: none;
}`
);

content = content.replace(
  /\.button\.secondary:hover \{[\s\S]*?\}/,
  `.button.secondary:hover {
  border-color: rgba(255, 255, 255, 0.6);
  color: var(--foreground);
  box-shadow: 0 0 15px rgba(255, 255, 255, 0.1);
}`
);

// We should also replace the input fields
content = content.replace(
  /input\[type="text"\],\s*input\[type="password"\],\s*input\[type="email"\],\s*input\[type="search"\],\s*input\[type="number"\],\s*input\[type="tel"\],\s*input\[type="url"\],\s*select,\s*textarea \{[\s\S]*?\}/,
  `input[type="text"],
input[type="password"],
input[type="email"],
input[type="search"],
input[type="number"],
input[type="tel"],
input[type="url"],
select,
textarea {
  width: 100%;
  appearance: none;
  background: rgba(5, 10, 20, 0.6);
  border: 1px solid var(--line-strong);
  border-radius: 2px;
  padding: 12px 16px;
  color: var(--foreground);
  font-family: "Cascadia Code", monospace;
  font-size: 15px;
  line-height: inherit;
  transition: all 200ms ease;
  box-shadow: inset 0 0 10px rgba(0, 0, 0, 0.5);
}`
);

content = content.replace(
  /input:focus,\s*select:focus,\s*textarea:focus \{[\s\S]*?\}/,
  `input:focus,
select:focus,
textarea:focus {
  outline: none;
  border-color: var(--accent);
  background: rgba(0, 240, 255, 0.05);
  box-shadow: 0 0 0 1px var(--accent), 0 0 15px rgba(0, 240, 255, 0.2) inset;
}`
);

fs.writeFileSync(file, content, 'utf-8');
console.log('CSS updated part 2');
