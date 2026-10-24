// ─────────────────────────────────────────────────────────────
//  LLM provider abstraction.
//
//  The app never talks to a model directly — it talks to a
//  `provider`, any object with:
//
//      complete({ system, user, history, prompt }) => Promise<{ text, provider }>
//
//  `text` is the raw model output; parsing and validation happen in
//  runtime.js. Failures throw a ProviderError whose `code` is one of
//  AUTH_ERROR, RATE_LIMIT, NETWORK_ERROR, PROVIDER_ERROR.
//
//    • mock — deterministic, offline, answers fixtures/ai-eval/*.json.
//    • http — any OpenAI-compatible chat-completions API, via plain fetch
//             to the same-origin relay (server/aiRelay.js), which adds the
//             endpoint, key and model from .env.local so no key ever ships
//             in the browser bundle.
// ─────────────────────────────────────────────────────────────
import { createMockProvider } from './mockProvider.js'

class ProviderError extends Error {
  constructor(code, message, retryAfter = null) {
    super(message)
    this.code = code
    this.retryAfter = retryAfter
  }
}

const RELAY_PATH = '/api/ai/chat'

async function describeFailure(response) {
  let detail = ''
  try { detail = (await response.text()).slice(0, 300) } catch { /* body unreadable: status alone */ }
  const retry = response.headers.get('retry-after')
  const status = response.status
  if (status === 401 || status === 403) return new ProviderError('AUTH_ERROR', `Authentication failed (HTTP ${status}). Check AI_API_KEY in .env.local.`)
  if (status === 429) return new ProviderError('RATE_LIMIT', `Rate limited (HTTP 429)${retry ? `; retry after ${retry}s` : ''}.`, retry)
  if (status >= 500) return new ProviderError('PROVIDER_ERROR', `Provider error (HTTP ${status})${detail ? `: ${detail}` : ''}`)
  return new ProviderError('PROVIDER_ERROR', `Request rejected (HTTP ${status})${detail ? `: ${detail}` : ''}`)
}

/** @param {{ endpoint?: string, fetch?: typeof fetch }} config */
export function createHttpProvider(config = {}) {
  const endpoint = config.endpoint ?? RELAY_PATH
  const send = config.fetch ?? ((...args) => fetch(...args))
  const post = async body => {
    let response
    try { response = await send(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) }
    catch (error) { throw new ProviderError('NETWORK_ERROR', `Could not reach the AI provider: ${error.message}`) }
    return response
  }
  return {
    name: 'http',
    async complete({ system, user, history = [] }) {
      const body = { messages: [{ role: 'system', content: system }, ...history, { role: 'user', content: user }], temperature: 0, response_format: { type: 'json_object' } }
      let response = await post(body)
      if (response.status === 400) {
        const { response_format: _dropped, ...plain } = body
        response = await post(plain)
      }
      if (!response.ok) throw await describeFailure(response)
      let data
      try { data = await response.json() } catch { throw new ProviderError('PROVIDER_ERROR', 'The provider returned a non-JSON body') }
      const text = data?.choices?.[0]?.message?.content
      if (typeof text !== 'string') throw new ProviderError('PROVIDER_ERROR', 'The response has no choices[0].message.content')
      return { text, provider: 'http' }
    },
  }
}

/** The mode resolved at build time by vite.config.js: 'http' only when AI_PROVIDER=http and a key is configured. */
export const providerMode = () => (typeof import.meta !== 'undefined' && import.meta.env?.AI_MODE) || 'mock'

export function createProvider(kind = providerMode()) {
  return kind === 'http' ? createHttpProvider() : createMockProvider()
}
