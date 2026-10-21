// ─────────────────────────────────────────────────────────────
//  LLM provider abstraction.
//
//  The app never talks to a model directly — it talks to a
//  `provider`. A provider is any object with:
//
//      complete({ system, user, history }) => Promise<{ text, provider }>
//
//  `text` is the raw model output; parsing and validation happen
//  elsewhere (validate.js). This is the only file that knows which
//  wire format the configured endpoint speaks.
//
//    • mock  — deterministic, offline, answers the prompts listed in
//              fixtures/ai-eval/*.json. Used by graders. The default.
//    • http  — plain fetch() to the endpoint in VITE_AI_ENDPOINT. Two
//              wire formats are supported, picked from the URL:
//                …/v1/messages          → Anthropic Messages API
//                anything else          → OpenAI-compatible
//                                         /chat/completions (OpenAI,
//                                         Groq, OpenRouter, Ollama,
//                                         Gemini's OpenAI endpoint, …)
// ─────────────────────────────────────────────────────────────
import { createMockProvider } from './mockProvider.js'

/**
 * @typedef {{ role: 'user' | 'assistant', content: string }} ChatTurn
 * @typedef {{ system: string, user: string, history?: ChatTurn[] }} CompletionRequest
 * @typedef {{ text: string, provider: string }} CompletionResponse
 * @typedef {{ name: string, complete: (req: CompletionRequest) => Promise<CompletionResponse> }} Provider
 */

const env = (typeof import.meta !== 'undefined' && import.meta.env) || {}
const TIMEOUT_MS = 30000

export class ProviderError extends Error {
    constructor(kind, message, status) {
        super(message)
        this.kind = kind // 'config' | 'network' | 'auth' | 'rate_limit' | 'http' | 'format' | 'timeout'
        this.status = status
    }
}

function isAnthropic(endpoint) {
    return /\/v1\/messages\/?$/.test(endpoint) || /anthropic\.com/.test(endpoint)
}

function buildRequest(kind, { endpoint, apiKey, model }, { system, user, history = [] }) {
    const turns = [...history, { role: 'user', content: user }]
    if (kind === 'anthropic') {
        return {
            url: endpoint,
            headers: {
                'content-type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
                'anthropic-dangerous-direct-browser-access': 'true',
            },
            body: { model, max_tokens: 1024, temperature: 0, system, messages: turns },
        }
    }
    const headers = { 'content-type': 'application/json' }
    if (apiKey) headers.authorization = `Bearer ${apiKey}`
    return {
        url: endpoint,
        headers,
        body: { model, temperature: 0, messages: [{ role: 'system', content: system }, ...turns] },
    }
}

function readText(kind, data) {
    if (kind === 'anthropic') {
        const blocks = Array.isArray(data?.content) ? data.content : []
        return blocks.filter(b => b.type === 'text').map(b => b.text).join('')
    }
    return data?.choices?.[0]?.message?.content ?? ''
}

async function errorFromResponse(res) {
    let detail = ''
    try {
        const body = await res.text()
        try {
            const json = JSON.parse(body)
            detail = json?.error?.message || json?.message || body
        } catch { detail = body }
    } catch { /* body unreadable */ }
    detail = String(detail).slice(0, 300)
    if (res.status === 401 || res.status === 403) {
        return new ProviderError('auth', `Authentication failed (${res.status}). Check VITE_AI_API_KEY. ${detail}`.trim(), res.status)
    }
    if (res.status === 429) {
        const retry = res.headers.get('retry-after')
        return new ProviderError('rate_limit', `Rate limited by the provider (429)${retry ? `; retry after ${retry}s` : ''}. ${detail}`.trim(), 429)
    }
    return new ProviderError('http', `Provider returned HTTP ${res.status}. ${detail}`.trim(), res.status)
}

/** @returns {Provider} */
export function createHttpProvider(config = {}) {
    const endpoint = config.endpoint ?? env.VITE_AI_ENDPOINT
    const apiKey = config.apiKey ?? env.VITE_AI_API_KEY
    const model = config.model ?? env.VITE_AI_MODEL
    const fetchImpl = config.fetch ?? ((...args) => fetch(...args))

    return {
        name: 'http',
        async complete(request) {
            if (!endpoint) throw new ProviderError('config', 'VITE_AI_ENDPOINT is not set (see .env.example).')
            if (!model) throw new ProviderError('config', 'VITE_AI_MODEL is not set (see .env.example).')
            const kind = isAnthropic(endpoint) ? 'anthropic' : 'openai'
            const { url, headers, body } = buildRequest(kind, { endpoint, apiKey, model }, request)
            const controller = new AbortController()
            const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
            let res
            try {
                res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal })
            } catch (e) {
                if (e?.name === 'AbortError') throw new ProviderError('timeout', `The provider did not answer within ${TIMEOUT_MS / 1000}s.`)
                throw new ProviderError('network', `Network error calling ${url}: ${e?.message || e}. (Offline, wrong URL, or blocked by CORS?)`)
            } finally {
                clearTimeout(timer)
            }
            if (!res.ok) throw await errorFromResponse(res)
            let data
            try { data = await res.json() } catch {
                throw new ProviderError('format', 'The provider response was not JSON.')
            }
            return { text: readText(kind, data), provider: 'http' }
        },
    }
}

/**
 * Pick a provider from VITE_AI_PROVIDER. Unknown values fall back to mock
 * so the app always boots.
 * @returns {Provider}
 */
export function createProvider(kind = env.VITE_AI_PROVIDER || 'mock') {
    if (kind === 'http') return createHttpProvider()
    return createMockProvider()
}
