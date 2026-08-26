// dsh-long-term-memory — automation helpers (auto-summarize + compression).
//
// Pure, testable logic that the plugin wires into DSH seams (agent/status,
// runMaintenance, ctx.llm). Kept free of DSH imports so the tricky parts
// (turn-diff extraction, LLM JSON parsing, rule-based compression) can be
// unit-tested standalone.

import { uniqueTokens } from './store.js'

/**
 * Extract the user-message text added since a boundary sequence.
 *
 * `events` is the session log; `sinceSeq` is the last sequence already
 * distilled. Returns the concatenated user text of messages with
 * `seq > sinceSeq`. Non-user messages are ignored.
 *
 * @param events - session events (each with `type`, `seq`, `data`).
 * @param sinceSeq - distill only messages after this sequence.
 * @returns the joined user text (empty when nothing new).
 */
export function newUserText(events, sinceSeq) {
  const parts = []
  for (const event of events ?? []) {
    if (event.type !== 'user/message') continue
    if (typeof event.seq === 'number' && event.seq <= sinceSeq) continue
    const message = event.data?.message
    const text = extractMessageText(message)
    if (text) parts.push(text)
  }
  return parts.join('\n').trim()
}

/** Pull the text out of a message's content blocks. */
function extractMessageText(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
    .trim()
}

/**
 * Parse the LLM extractor's reply into a list of memory facts.
 *
 * The extractor is asked to reply with a JSON array of
 * `{ scope, content, tags? }` objects. We tolerate prose around the JSON
 * (a code fence, a leading sentence) by slicing the first `[...]` block.
 *
 * @param reply - the model's raw reply.
 * @returns parsed facts (each content non-empty), or an empty array when the
 *   reply contains no parseable array.
 */
export function parseFacts(reply) {
  const text = String(reply ?? '')
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  let data
  try {
    data = JSON.parse(text.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(data)) return []
  const facts = []
  for (const item of data) {
    if (item === null || typeof item !== 'object') continue
    const content = typeof item.content === 'string' ? item.content.trim() : ''
    if (content.length === 0) continue
    const scope = typeof item.scope === 'string' && ['user', 'global', 'workspace'].includes(item.scope) ? item.scope : 'global'
    const tags = Array.isArray(item.tags) ? item.tags.filter((t) => typeof t === 'string' && t.length > 0) : []
    facts.push({ scope, content, tags })
  }
  return facts
}

/**
 * Rule-based compression: reduce a record list until it fits `budgetChars`
 * (or cannot shrink further).
 *
 * Strategy (deterministic, no model call):
 *   1. drop the coldest records first — lowest `hits`, then oldest
 *      `updatedAt` — while above budget;
 *   2. then, if still over, merge duplicate-ish content by dropping shorter
 *      records whose text is a substring of a longer one.
 *
 * The dropped records are returned separately so the caller can back them up.
 *
 * @param records - live records (content/tags/hits/updatedAt).
 * @param budgetChars - the per-store char budget.
 * @returns `{ kept, dropped }` where `kept` fits the budget if possible.
 */
export function compressRules(records, budgetChars) {
  const kept = records.slice()
  const dropped = []
  const usage = () => kept.reduce((sum, r) => sum + (r.content?.length ?? 0), 0)

  // Phase 1: drop coldest (hits asc, then updatedAt asc).
  kept.sort((a, b) => (a.hits ?? 0) - (b.hits ?? 0) || (a.updatedAt ?? 0) - (b.updatedAt ?? 0))
  while (usage() > budgetChars && kept.length > 1) {
    dropped.push(kept.shift())
  }

  // Phase 2: drop records whose content is a substring of another kept record.
  if (usage() > budgetChars) {
    const byLenDesc = kept.slice().sort((a, b) => (b.content?.length ?? 0) - (a.content?.length ?? 0))
    const removable = new Set()
    for (let i = 0; i < byLenDesc.length; i++) {
      const long = byLenDesc[i].content ?? ''
      for (let j = i + 1; j < byLenDesc.length; j++) {
        const short = byLenDesc[j].content ?? ''
        if (short.length > 0 && long !== short && long.includes(short)) removable.add(byLenDesc[j].id)
      }
    }
    const after = kept.filter((r) => !removable.has(r.id))
    for (const r of kept) if (removable.has(r.id)) dropped.push(r)
    kept.splice(0, kept.length, ...after)
  }

  return { kept, dropped }
}

/**
 * Similarity score between two records (0..1): Jaccard over unique tokens,
 * biased toward content length. Used by the LLM compressor prompt to know
 * which entries are worth merging.
 */
export function similarity(a, b) {
  const ta = new Set(uniqueTokens(a.content ?? ''))
  const tb = new Set(uniqueTokens(b.content ?? ''))
  if (ta.size === 0 || tb.size === 0) return 0
  let inter = 0
  for (const t of ta) if (tb.has(t)) inter += 1
  const union = ta.size + tb.size - inter
  return union === 0 ? 0 : inter / union
}

export { extractMessageText }
