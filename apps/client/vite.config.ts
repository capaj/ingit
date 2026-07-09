import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const rootPackageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version?: string }

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(rootPackageJson.version ?? '0.0.0'),
  },
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
