import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    forwardConsole: true,
    port: 5184,
    proxy: {
      '/rpc': { target: 'ws://127.0.0.1:8488', ws: true }
    }
  },
  build: {
    outDir: 'dist'
  }
})
