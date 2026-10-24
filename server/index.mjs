// Optional production server: serves dist/ and the AI relay on one origin.
// Usage: npm run build && npm run server   (PORT defaults to 4173)
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { loadEnv } from 'vite'
import { createAiRelay } from './aiRelay.js'

const root = new URL('../dist/', import.meta.url).pathname
const relay = createAiRelay(loadEnv('production', new URL('..', import.meta.url).pathname, 'AI_'))
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' }
const port = Number(process.env.PORT ?? 4173)

createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname
  if (path === '/api/ai/chat') return relay(req, res)
  const file = join(root, normalize(path === '/' ? '/index.html' : path).replace(/^(\.\.[/\\])+/, ''))
  try {
    const body = await readFile(file)
    res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404); res.end('Not found')
  }
}).listen(port, () => console.log(`Serving dist/ and /api/ai/chat on http://localhost:${port}`))
