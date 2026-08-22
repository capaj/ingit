import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const rootPackageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version?: string }
const appVersion = process.env.INGIT_VERSION?.replace(/^v/, '') ?? rootPackageJson.version ?? '0.0.0'

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  server: {
    forwardConsole: true,
    port: 5184,
    proxy: {
      '/rpc': { target: 'ws://127.0.0.1:8449', ws: true }
    }
  },
  build: {
    outDir: 'dist'
  }
})
