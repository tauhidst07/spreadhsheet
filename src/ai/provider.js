// ─────────────────────────────────────────────────────────────
//  LLM provider abstraction.
//
//  The app never talks to a model directly — it talks to a
//  `provider`. A provider is any object with:
//
//      complete({ system, user, history }) => Promise<{ text, provider }>
//
//  `text` is the raw model output. You are expected to extract and
//  validate JSON from it yourself: models wrap JSON in prose, in code
//  fences, or return something that is not JSON at all.
//
//  Two providers ship with the repo:
//    • mock  — deterministic, offline, answers the prompts listed in
//              fixtures/ai-eval/*.json. Used by graders. The default.
//    • http  — Call any LLM API (OpenAI, Gemini, Anthropic, Ollama, …)
//              with plain fetch(). Read endpoint, key and model from env.
// ─────────────────────────────────────────────────────────────
import { createMockProvider } from './mockProvider.js'

/**
 * @typedef {{ role: 'user' | 'assistant', content: string }} ChatTurn
 * @typedef {{ system: string, user: string, history?: ChatTurn[] }} CompletionRequest
 * @typedef {{ text: string, provider: string }} CompletionResponse
 * @typedef {{ name: string, complete: (req: CompletionRequest) => Promise<CompletionResponse> }} Provider
 */

const env = (typeof import.meta !== 'undefined' && import.meta.env) || {}

/** @returns {Provider} */
export function createHttpProvider(config = {}) {
    const endpoint = config.endpoint ?? env.VITE_AI_ENDPOINT ?? 'https://api.openai.com/v1/chat/completions'
    const apiKey = config.apiKey ?? env.VITE_AI_API_KEY ?? ''
    const model = config.model ?? env.VITE_AI_MODEL ?? 'gpt-4o-mini'

    return {
        name: 'http',
        async complete(request) {
            if (!endpoint) {
                throw new Error('VITE_AI_ENDPOINT is not configured in .env.local')
            }

            const messages = []
            if (request.system) {
                messages.push({ role: 'system', content: request.system })
            }
            if (request.history && Array.isArray(request.history)) {
                for (const turn of request.history) {
                    messages.push({ role: turn.role, content: turn.content })
                }
            }
            messages.push({ role: 'user', content: request.user })

            const headers = {
                'Content-Type': 'application/json',
            }

            let requestBody
            const isAnthropic = endpoint.includes('anthropic.com')
            const isGemini = endpoint.includes('googleapis.com')

            if (isAnthropic) {
                if (apiKey) {
                    headers['x-api-key'] = apiKey
                    headers['anthropic-version'] = '2023-06-01'
                    headers['anthropic-dangerous-direct-browser-access'] = 'true'
                }
                const anthropicMessages = []
                if (request.history && Array.isArray(request.history)) {
                    for (const turn of request.history) {
                        anthropicMessages.push({ role: turn.role, content: turn.content })
                    }
                }
                anthropicMessages.push({ role: 'user', content: request.user })

                requestBody = {
                    model,
                    system: request.system || undefined,
                    messages: anthropicMessages,
                    max_tokens: 2048,
                    temperature: 0.1,
                }
            } else if (isGemini) {
                if (apiKey) {
                    headers['x-goog-api-key'] = apiKey
                }
                const contents = []
                if (request.system) {
                    contents.push({ role: 'user', parts: [{ text: `System Instructions:\n${request.system}` }] })
                    contents.push({ role: 'model', parts: [{ text: 'Understood.' }] })
                }
                if (request.history && Array.isArray(request.history)) {
                    for (const turn of request.history) {
                        contents.push({
                            role: turn.role === 'assistant' ? 'model' : 'user',
                            parts: [{ text: turn.content }],
                        })
                    }
                }
                contents.push({ role: 'user', parts: [{ text: request.user }] })

                requestBody = {
                    contents,
                    generationConfig: { temperature: 0.1 },
                }
            } else {
                // OpenAI / OpenRouter / Groq / Ollama / Together / Mistral
                if (apiKey) {
                    headers['Authorization'] = `Bearer ${apiKey}`
                }
                requestBody = {
                    model,
                    messages,
                    temperature: 0.1,
                }
            }

            let response
            try {
                response = await fetch(endpoint, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(requestBody),
                })
            } catch (err) {
                throw new Error(`Network failure connecting to AI provider (${endpoint}): ${err.message}`)
            }

            if (!response.ok) {
                if (response.status === 401 || response.status === 403) {
                    throw new Error(`Authentication error (${response.status}): Invalid API key for ${endpoint}`)
                }
                if (response.status === 429) {
                    throw new Error(`Rate limit exceeded (${response.status}) on AI provider. Please retry in a few moments.`)
                }
                let errorBody = ''
                try {
                    const errJson = await response.json()
                    errorBody = errJson?.error?.message || JSON.stringify(errJson)
                } catch {
                    errorBody = response.statusText
                }
                throw new Error(`AI Provider error (${response.status}): ${errorBody}`)
            }

            let data
            try {
                data = await response.json()
            } catch (err) {
                throw new Error(`Failed to parse AI provider JSON response: ${err.message}`)
            }

            // Extract text from OpenAI, Anthropic, or Gemini response formats
            let text = ''
            if (data.choices?.[0]?.message?.content) {
                text = data.choices[0].message.content
            } else if (data.content?.[0]?.text) {
                text = data.content[0].text
            } else if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
                text = data.candidates[0].content.parts[0].text
            } else if (typeof data.text === 'string') {
                text = data.text
            } else {
                text = JSON.stringify(data)
            }

            return { text, provider: 'http' }
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
