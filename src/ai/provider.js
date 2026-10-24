// ─────────────────────────────────────────────────────────────
//  LLM provider abstraction.
//
//  A provider is any object with:
//    complete({ system, user, history }) => Promise<{ text, provider }>
//
//  Two providers:
//    • mock  — deterministic, offline (for graders)
//    • http  — calls any OpenAI-compatible API via plain fetch()
// ─────────────────────────────────────────────────────────────
import { createMockProvider } from './mockProvider.js'

const env = (typeof import.meta !== 'undefined' && import.meta.env) || {}

/**
 * @returns {import('./provider.js').Provider}
 */
export function createHttpProvider(config = {}) {
    const endpoint = config.endpoint ?? env.VITE_AI_ENDPOINT ?? 'https://api.openai.com/v1/chat/completions'
    const apiKey = config.apiKey ?? env.VITE_AI_API_KEY
    const model = config.model ?? env.VITE_AI_MODEL ?? 'gpt-4o-mini'

    return {
        name: 'http',
        async complete({ system, user, history = [] }) {
            if (!apiKey) throw new Error('No API key set. Add VITE_AI_API_KEY to .env.local')

            const messages = []
            if (system) messages.push({ role: 'system', content: system })
            for (const turn of history) messages.push(turn)
            messages.push({ role: 'user', content: user })

            let resp
            try {
                resp = await fetch(endpoint, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${apiKey}`,
                    },
                    body: JSON.stringify({ model, messages, temperature: 0 }),
                })
            } catch (e) {
                throw new Error(`Network error: ${e.message}`)
            }

            if (!resp.ok) {
                const body = await resp.text().catch(() => '')
                if (resp.status === 401) throw new Error('Auth error: invalid API key')
                if (resp.status === 429) throw new Error('Rate limit exceeded. Try again shortly.')
                throw new Error(`API error ${resp.status}: ${body.slice(0, 200)}`)
            }

            const data = await resp.json()
            const text = data.choices?.[0]?.message?.content ?? ''
            return { text, provider: 'http' }
        },
    }
}

/**
 * Pick a provider from VITE_AI_PROVIDER env var.
 * @returns {import('./provider.js').Provider}
 */
export function createProvider(kind = env.VITE_AI_PROVIDER || 'mock') {
    if (kind === 'http') return createHttpProvider()
    return createMockProvider()
}
