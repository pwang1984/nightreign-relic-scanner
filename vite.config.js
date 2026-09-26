import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  // Set by the Pages deploy workflow (e.g. /nightreign-relic-scanner/);
  // local dev and preview serve from the root.
  base: process.env.BASE_PATH || '/',
  plugins: [react()],
})
