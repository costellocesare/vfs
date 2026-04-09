import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [
    tailwindcss(),
  ],
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      ignored: [
        '**/logs.txt',
        '**/.env',
        '**/dist/**',
        '**/node_modules/**',
        '**/server.js'
      ]
    },
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      }
    }
  }
});
