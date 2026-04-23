import fs from 'fs';
import path from 'path';

const file = 'C:/Users/Administrator/Desktop/GFA/apps/web/src/app/globals.css';
let content = fs.readFileSync(file, 'utf-8');

const cyberClasses = `

/* Cyberpunk Transitions */
.cyber-viewport {
  position: relative;
  overflow: hidden;
}

.cyber-slide-enter {
  animation: cyber-slide 0.5s cubic-bezier(0.1, 0.9, 0.2, 1) forwards;
}

@keyframes cyber-slide {
  0% {
    opacity: 0;
    transform: translateX(40px) skewX(-10deg);
    filter: brightness(2) contrast(1.5) hue-rotate(90deg);
  }
  50% {
    opacity: 1;
    transform: translateX(-5px) skewX(2deg);
    filter: brightness(1.5) contrast(1.2) hue-rotate(20deg);
  }
  100% {
    opacity: 1;
    transform: translateX(0) skewX(0deg);
    filter: brightness(1) contrast(1) hue-rotate(0deg);
  }
}

.cyber-progress-fill {
  background: var(--accent);
  box-shadow: 0 0 10px var(--accent);
}

.cyber-text-box {
  background: rgba(5, 10, 20, 0.8) !important;
  border: 1px solid var(--accent) !important;
  box-shadow: 0 0 15px rgba(0, 240, 255, 0.2) inset !important;
}

.cyber-status-badge {
  background: rgba(0, 240, 255, 0.1) !important;
  color: var(--accent) !important;
  border: 1px solid var(--accent) !important;
}

.cyber-glitch-text {
  text-shadow: 0 0 8px var(--accent) !important;
}
`;

fs.writeFileSync(file, content + cyberClasses, 'utf-8');
console.log('CSS updated part 3');
