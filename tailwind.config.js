/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './src/renderer/**/*.{js,ts,jsx,tsx,html}',
  ],
  theme: {
    extend: {
      colors: {
        'app-bg': '#1a1a2e',
        'app-surface': '#16213e',
        'app-border': '#0f3460',
        'app-accent': '#e94560',
      },
    },
  },
  plugins: [],
}
