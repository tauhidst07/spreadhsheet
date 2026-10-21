// Canvas text measurement for auto-fit (the engine stays DOM-free and
// receives this function as a parameter).
export const FONT_FAMILY = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"

let ctx = null

export function measureText(text, style) {
    if (!ctx) ctx = document.createElement('canvas').getContext('2d')
    ctx.font = `${style.italic ? 'italic ' : ''}${style.bold ? 'bold ' : ''}${style.fontSize || 13}px ${FONT_FAMILY}`
    return ctx.measureText(text).width
}
