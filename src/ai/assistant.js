// ─────────────────────────────────────────────────────────────
//  One assistant turn: prompt → provider → parse → validate.
//  Pure orchestration (no React, no engine writes). The UI decides
//  what to do with the validated action.
// ─────────────────────────────────────────────────────────────
import { buildSystemPrompt } from './prompt.js'
import { parseAction } from './validate.js'

const MAX_HISTORY_TURNS = 6

/**
 * @returns {Promise<{ action?: object, error?: { code, detail }, rawText: string, provider: string, ms: number }>}
 */
export async function askAssistant({ provider, prompt, context, history = [] }) {
    const started = performance.now()
    let response
    try {
        response = await provider.complete({
            system: buildSystemPrompt(context),
            user: prompt,
            history: history.slice(-MAX_HISTORY_TURNS),
        })
    } catch (e) {
        return {
            error: { code: 'PROVIDER_ERROR', detail: e?.message || String(e) },
            rawText: '',
            provider: provider.name,
            ms: performance.now() - started,
        }
    }
    const rawText = response?.text ?? ''
    const parsed = parseAction(rawText)
    return { ...parsed, rawText, provider: response?.provider ?? provider.name, ms: performance.now() - started }
}
