/// <reference types="vitest" />
import {defineConfig, type Plugin} from 'vite';
import react from '@vitejs/plugin-react';

// The built page loads nothing from outside: scripts, styles and the long poll are all same-origin.
const CSP = ["default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", "connect-src 'self'",
  "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"].join('; ');
const csp = (): Plugin => ({name: 'csp', apply: 'build', transformIndexHtml: (html) => html.replace('<!--CSP-->', `<meta http-equiv="Content-Security-Policy" content="${CSP}" />`)});

export default defineConfig({
  plugins: [react(), csp()],
  server: {proxy: {'/api': 'http://127.0.0.1:5480'}}, // npm start in another terminal, then vite web for live editing
  build: {sourcemap: false, emptyOutDir: true},
  test: {environment: 'jsdom', globals: true, setupFiles: ['./test/setup.ts'], include: ['test/**/*.test.tsx']},
});
