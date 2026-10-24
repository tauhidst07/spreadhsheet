import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { createAiRelay, resolveMode } from './server/aiRelay.js'

/** Inlines the (small) stylesheet into index.html so the first paint needs no extra request. */
const inlineCss = {
  name: 'inline-css',
  apply: 'build',
  enforce: 'post',
  generateBundle(_, bundle) {
    const html = Object.values(bundle).find(a => a.fileName === 'index.html')
    for (const asset of Object.values(bundle)) {
      if (!html || !asset.fileName.endsWith('.css')) continue
      const link = new RegExp(`<link rel="stylesheet"[^>]*href="/${asset.fileName}"[^>]*>`)
      if (!link.test(html.source)) continue
      html.source = html.source.replace(link, () => `<style>${asset.source}</style>`)
      delete bundle[asset.fileName]
    }
  },
}

// AI_* settings stay server-side: the relay reads them, and only the resolved
// provider mode ('mock' | 'http') is compiled into the bundle.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'AI_')
  const relay = createAiRelay(env)
  const mountRelay = server => { server.middlewares.use('/api/ai/chat', relay) }
  return {
    plugins: [react(), inlineCss, { name: 'ai-relay', configureServer: mountRelay, configurePreviewServer: mountRelay }],
    define: { 'import.meta.env.AI_MODE': JSON.stringify(resolveMode(env)) },
    // Measurement builds use React's profiling renderer so <Profiler> reports commits.
    resolve: { alias: process.env.VITE_MEASURE === '1' ? { 'react-dom/client': 'react-dom/profiling' } : {} },
  }
})
