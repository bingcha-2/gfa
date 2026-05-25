/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        primary: { DEFAULT: '#1d4ed8', hover: '#1e40af', light: 'rgba(29,78,216,0.12)' },
        accent: '#0ea5a5',
        success: '#22c55e',
        warning: '#f59e0b',
        danger: '#ef4444',
        surface: { primary: '#f6f5f2', secondary: '#ffffff', tertiary: '#eef2f7', card: 'rgba(255,255,255,0.75)' },
        txt: { primary: '#0f172a', secondary: '#475569', muted: '#94a3b8' },
        bdr: { DEFAULT: 'rgba(15,23,42,0.12)', light: 'rgba(15,23,42,0.08)' },
      },
      fontFamily: {
        sans: ['Inter', 'Segoe UI', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'SFMono-Regular', 'monospace'],
      },
      borderRadius: {
        sm: '8px',
        md: '12px',
        lg: '18px',
        xl: '24px',
      },
      boxShadow: {
        sm: '0 2px 6px rgba(15,23,42,0.08)',
        md: '0 12px 24px rgba(15,23,42,0.12)',
        lg: '0 20px 40px rgba(15,23,42,0.18)',
      },
    },
  },
  plugins: [],
}
