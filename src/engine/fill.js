// Fill-handle series detection. Given the seed values along one line (a
// column for vertical fills, a row for horizontal ones) it returns a function
// `at(k)` producing the value for position k, where 0..n-1 are the seeds,
// k >= n continues forward and k < 0 continues backward.

import { dayNumber, formatDay, parseDate } from './values.js'

const NAME_LISTS = [
  ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'],
  ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
  ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'],
  ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'],
]
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/
const TEXT_NUMBER = /^(.*?)(\d+)(\D*)$/

const mod = (k, n) => ((k % n) + n) % n

/** Step between the last two seeds (1 for a single seed). */
const lastStep = values => (values.length > 1 ? values.at(-1) - values.at(-2) : 1)

/** Value k steps along a series anchored at the seeds' ends. */
function extend(values, k, step) {
  return k >= values.length ? values.at(-1) + (k - values.length + 1) * step : values[0] + k * step
}

function caseLike(word, sample) {
  if (sample === sample.toUpperCase()) return word.toUpperCase()
  if (sample === sample.toLowerCase()) return word
  return word[0].toUpperCase() + word.slice(1)
}

function decimals(texts) {
  return Math.max(...texts.map(t => (t.split('.')[1] ?? '').length))
}

/**
 * @param {Array<string|object|null>} seeds literal text, a formula template or null (empty)
 * @returns {(k: number) => string|object|null}
 */
export function seriesFor(seeds) {
  const n = seeds.length, copy = k => seeds[mod(k, n)]
  if (seeds.some(s => typeof s !== 'string' || s.trim() === '')) return copy
  const texts = seeds.map(s => s.trim())

  if (texts.every(t => PLAIN_NUMBER.test(t))) {
    if (n === 1) return copy
    const nums = texts.map(Number), step = (nums[n - 1] - nums[0]) / (n - 1), places = decimals(texts)
    return k => String(Number((nums[0] + k * step).toFixed(places)))
  }

  const dates = texts.map(parseDate)
  if (dates.every(Boolean)) {
    const days = dates.map(dayNumber), step = lastStep(days)
    return k => (k >= 0 && k < n ? seeds[k] : formatDay(extend(days, k, step), dates[mod(k, n)].format))
  }

  for (const list of NAME_LISTS) {
    const idx = texts.map(t => list.indexOf(t.toLowerCase()))
    if (idx.every(i => i >= 0)) {
      const step = n > 1 ? mod(idx[n - 1] - idx[n - 2], list.length) : 1
      return k => (k >= 0 && k < n ? seeds[k] : caseLike(list[mod(extend(idx, k, step), list.length)], texts[mod(k, n)]))
    }
  }

  const parts = texts.map(t => TEXT_NUMBER.exec(t))
  if (parts.every(p => p && p[1] === parts[0][1] && p[3] === parts[0][3])) {
    const nums = parts.map(p => Number(p[2])), step = lastStep(nums)
    return k => {
      if (k >= 0 && k < n) return seeds[k]
      const value = extend(nums, k, step), width = parts[mod(k, n)][2].length
      return `${parts[0][1]}${value < 0 ? value : String(value).padStart(width, '0')}${parts[0][3]}`
    }
  }
  return copy
}
