import fs from 'fs';

const css = `
/* Store Button Sci-Fi Animation */
.btn-store-sci-fi {
  position: relative;
  overflow: hidden;
  background: linear-gradient(135deg, rgba(88, 166, 255, 0.1), rgba(163, 113, 247, 0.2));
  border: 1px solid rgba(163, 113, 247, 0.5);
  color: #c9d1d9;
  text-shadow: 0 0 8px rgba(163, 113, 247, 0.6);
  transition: all 0.3s ease;
  z-index: 1;
}

.btn-store-sci-fi::before {
  content: '';
  position: absolute;
  top: 0;
  left: -200%;
  width: 100%;
  height: 100%;
  background: linear-gradient(90deg, transparent, rgba(163, 113, 247, 0.6), transparent);
  transform: skewX(-30deg);
  animation: sweep 4s infinite cubic-bezier(0.4, 0, 0.2, 1);
  z-index: -1;
}

.btn-store-sci-fi:hover {
  border-color: rgba(163, 113, 247, 0.8);
  box-shadow: 0 0 15px rgba(163, 113, 247, 0.5), inset 0 0 10px rgba(88, 166, 255, 0.2);
  color: #fff;
}

@keyframes sweep {
  0% { left: -200%; }
  30% { left: 200%; }
  100% { left: 200%; }
}
`;

fs.appendFileSync('apps/web/src/app/globals.css', css);
console.log('Appended CSS to globals.css');
