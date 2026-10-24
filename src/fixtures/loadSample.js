// Sample fixtures, fetched on demand so they never weigh on first paint.

export function parseTsv(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines.map(line => line.split('\t'))
}

/** 'small' → fixtures/sales.tsv (33 lines); 'large' → fixtures/sales-large.tsv (~3,000 lines). */
export async function loadSample(which) {
  const { default: text } = which === 'large'
    ? await import('../../fixtures/sales-large.tsv?raw')
    : await import('../../fixtures/sales.tsv?raw')
  return parseTsv(text)
}
