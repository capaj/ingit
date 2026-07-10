import {defineConfig} from 'astro/config'

export default defineConfig({
  site: 'https://ingit.pages.dev',
  output: 'static',
  build: {
    assets: '_assets',
  },
  vite: {
    build: {
      cssMinify: 'lightningcss',
    },
  },
})
