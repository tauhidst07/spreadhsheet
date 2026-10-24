// Same-origin relay for the http AI provider. The browser posts chat messages
// to /api/ai/chat; this adds the model and the bearer key from .env.local and
// forwards to the configured OpenAI-compatible endpoint, passing status codes
// (401/403/429 with retry-after/5xx) straight through. The key never reaches
// the browser bundle. Used by the Vite dev/preview servers and `npm run server`.

const readBody = req => new Promise((resolve, reject) => {
  let data = ''
  req.on('data', chunk => { data += chunk })
  req.on('end', () => resolve(data))
  req.on('error', reject)
})

const reply = (res, status, payload, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
  res.end(typeof payload === 'string' ? payload : JSON.stringify(payload))
}

/** @param env {{ AI_ENDPOINT?: string, AI_API_KEY?: string, AI_MODEL?: string }} */
export function createAiRelay(env) {
  return async function relay(req, res) {
    if (req.method !== 'POST') return reply(res, 405, { error: 'POST only' })
    if (!env.AI_ENDPOINT || !env.AI_API_KEY || !env.AI_MODEL) {
      return reply(res, 503, { error: 'AI relay is not configured: set AI_ENDPOINT, AI_API_KEY and AI_MODEL in .env.local' })
    }
    let body
    try { body = JSON.parse(await readBody(req)) } catch { return reply(res, 400, { error: 'Invalid JSON body' }) }
    let upstream
    try {
      upstream = await fetch(env.AI_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.AI_API_KEY}` },
        body: JSON.stringify({ ...body, model: env.AI_MODEL }),
      })
    } catch (error) {
      return reply(res, 502, { error: `Network error reaching the AI endpoint: ${error.message}` })
    }
    const retry = upstream.headers.get('retry-after')
    reply(res, upstream.status, await upstream.text(), retry ? { 'Retry-After': retry } : {})
  }
}

/** 'http' when AI_PROVIDER=http and a key is set, otherwise 'mock'. */
export const resolveMode = env => (env.AI_PROVIDER === 'http' && env.AI_API_KEY ? 'http' : 'mock')
