// dsh-long-term-memory — deterministic memory store.
//
// Pure, dependency-light backend used by the plugin body. It owns:
//   - persistence: one JSONL file per store (scope), written atomically via
//     write-temp-then-rename so a crash never leaves a torn record.
//   - a CJK-aware tokenizer + BM25 index for deterministic recall (no
//     embeddings, no external service, no extra model calls).
//   - write-time guards modeled on Hermes's MemoryStore: a cross-process file
//     lock, refusal to overwrite an unreadable file, external-drift detection
//     (back up + refuse rather than silently discard hand-edited content), and
//     a per-store character budget so a store cannot grow without bound.
//
// It deliberately knows nothing about DSH/Cordis: it takes a `file` path and
// the caller wires it into the plugin. This keeps recall logic unit-testable.

import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** A single memory record. */
export function emptyRecord(scope) {
  const now = Date.now()
  return {
    id: randomUUID(),
    scope,
    content: '',
    tags: [],
    source: undefined, // { sessionId, seq, origin } — provenance, when known.
    createdAt: now,
    updatedAt: now,
    hits: 0,
  }
}

/**
 * Normalize an incoming record: keep only known keys, default the rest. This
 * is what makes re-reading a written file always produce a stable shape even
 * after a schema edit.
 */
export function normalizeRecord(raw, scope) {
  const record = emptyRecord(scope)
  if (raw === null || typeof raw !== 'object') return record
  if (typeof raw.id === 'string' && raw.id.length > 0) record.id = raw.id
  if (typeof raw.content === 'string') record.content = raw.content
  if (Array.isArray(raw.tags)) {
    record.tags = raw.tags.filter((t) => typeof t === 'string' && t.length > 0)
  }
  if (raw.source !== undefined && raw.source !== null && typeof raw.source === 'object') {
    const src = raw.source
    if (typeof src.sessionId === 'string') record.source = { sessionId: src.sessionId }
    if (typeof src.seq === 'number') record.source = { ...(record.source ?? {}), seq: src.seq }
    if (typeof src.origin === 'string') record.source = { ...(record.source ?? {}), origin: src.origin }
    if (record.source === undefined) delete record.source
  }
  if (typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt)) record.createdAt = raw.createdAt
  if (typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt)) record.updatedAt = raw.updatedAt
  if (typeof raw.hits === 'number' && Number.isFinite(raw.hits) && raw.hits >= 0) record.hits = raw.hits
  // The in-memory record must match its serialized form (JSON drops undefined
  // object values), so an absent source is deleted rather than left `undefined`.
  if (record.source === undefined) delete record.source
  return record
}

export function serialize(records) {
  return records.map((r) => JSON.stringify(r)).join('\n') + '\n'
}

/**
 * Parse JSONL and report malformed lines. A malformed line (hand-edited or
 * external writer) is counted but skipped on the read path, and the write path
 * uses the count as the external-drift signal (back up + refuse).
 */
export function analyzeJsonl(text) {
  const records = []
  let malformed = 0
  for (const line of String(text ?? '').split('\n')) {
    const s = line.trim()
    if (s.length === 0) continue
    try {
      records.push(JSON.parse(s))
    } catch {
      malformed += 1
    }
  }
  return { records, malformed }
}

/**
 * Parse JSONL, skipping malformed lines (never throws). Kept for callers that
 * only read; {@link analyzeJsonl} is the write-path variant.
 */
export function deserialize(text) {
  return analyzeJsonl(text).records
}

// ─────────────────────────────────────────────────────────────────────────────
// Export / import (portable memory bundles)
// ─────────────────────────────────────────────────────────────────────────────

/** The current export bundle schema version. */
export const EXPORT_VERSION = 1

/**
 * Build a portable export bundle for a set of records.
 *
 * Only durable content travels: scope, content, and tags. Provenance
 * (`source`/`hits`/`createdAt`) is intentionally dropped — it is session-local
 * and would misrepresent the imported copy.
 *
 * @param records - the records to export (each with scope/content/tags).
 * @param format - `'json'` (default; a v1 bundle object) or `'markdown'`
 *   (human-readable, one section per scope, one bullet per record).
 * @returns the serialized export string.
 */
export function exportBundle(records, format = 'json') {
  const clean = (records ?? [])
    .filter((r) => r !== null && typeof r === 'object' && typeof r.content === 'string' && r.content.length > 0)
    .map((r) => ({
      scope: SCOPES_INTERNAL.has(r.scope) ? r.scope : 'global',
      content: r.content,
      tags: Array.isArray(r.tags) ? r.tags.filter((t) => typeof t === 'string' && t.length > 0) : [],
    }))
  if (format === 'markdown') {
    const byScope = new Map()
    for (const r of clean) {
      const list = byScope.get(r.scope) ?? []
      list.push(r)
      byScope.set(r.scope, list)
    }
    const lines = ['# Long-term memory export']
    for (const scope of SCOPES_INTERNAL) {
      const list = byScope.get(scope)
      if (!list || list.length === 0) continue
      lines.push('', `## ${scope}`, '')
      for (const r of list) {
        const tags = r.tags.length > 0 ? ` [${r.tags.join(', ')}]` : ''
        lines.push(`- ${r.content}${tags}`)
      }
    }
    return lines.join('\n') + '\n'
  }
  return JSON.stringify({ version: EXPORT_VERSION, records: clean }, null, 2) + '\n'
}

/**
 * Parse a v1 JSON export bundle into normalized records ready for import.
 * Throws a readable error on a malformed or foreign-version bundle so the
 * tool can surface it to the model instead of silently importing nothing.
 */
export function parseExportBundle(text) {
  let data
  try {
    data = JSON.parse(String(text ?? ''))
  } catch {
    throw new Error('memory export import: not valid JSON')
  }
  if (data === null || typeof data !== 'object' || !Array.isArray(data.records)) {
    throw new Error('memory export import: expected a v1 bundle object with a "records" array')
  }
  if (data.version !== EXPORT_VERSION) {
    throw new Error(`memory export import: unsupported bundle version ${JSON.stringify(data.version)} (expected ${EXPORT_VERSION})`)
  }
  return data.records
    .filter((r) => r !== null && typeof r === 'object')
    .map((r) => normalizeRecord({ ...r, scope: SCOPES_INTERNAL.has(r.scope) ? r.scope : 'global' }, r.scope))
    .filter((r) => r.content.length > 0)
}

/** Scope set shared by export/import; defined near SCOPES in index.js normally. */
const SCOPES_INTERNAL = new Set(['user', 'global', 'workspace'])

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Whether a pid belongs to a live process (ESRCH means gone; EPERM means alive). */
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CJK-aware tokenizer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Iterable over the CJK codepoint ranges used by the tokenizer. We treat CJK
 * as character-sequenced (no spaces), so recall needs bigram tokens rather
 * than ASCII word boundaries to catch Chinese/Japanese/Korean text.
 */
function isCjk(code) {
  return (
    (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
    (code >= 0x3400 && code <= 0x4dbf) || // CJK Extension A
    (code >= 0x3040 && code <= 0x30ff) || // Hiragana + Katakana
    (code >= 0xac00 && code <= 0xd7af) // Hangul
  )
}

/** Whether a character is a Latin alphanumeric (word-former) codepoint. */
function isWordChar(code) {
  return (code >= 0x30 && code <= 0x39) || // 0-9
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x61 && code <= 0x7a) // a-z
}

/**
 * Tokenize text for indexing/querying.
 *
 * - Non-CJK runs (Latin words, digits) are split on non-alphanumerics and
 *   lowercased, so "FooBar" and "foobar" differ but "Price" folds to "price".
 * - CJK runs are emitted as unigrams AND adjacent bigrams, so querying any
 *   two-character slice of a Chinese phrase still matches.
 */
export function tokenize(text) {
  const tokens = []
  const run = []
  let i = 0
  const addWord = (s) => {
    if (s.length === 0) return
    tokens.push(s.toLowerCase())
  }
  for (const ch of String(text ?? '')) {
    const code = ch.codePointAt(0)
    if (isCjk(code)) {
      if (run.length) {
        addWord(run.join(''))
        run.length = 0
      }
      tokens.push(ch) // unigram
      const prev = tokens.at(-2) // bigram with the previous CJK char, if any
      if (prev !== undefined && isCjk(prev.codePointAt(0)) && prev !== ch) {
        tokens.push(prev + ch)
      }
    } else if (isWordChar(code)) {
      run.push(ch)
    } else {
      if (run.length) {
        addWord(run.join(''))
        run.length = 0
      }
    }
  }
  if (run.length) addWord(run.join(''))
  return tokens
}

/** Unique tokens of a text, preserving first-seen order. */
export function uniqueTokens(text) {
  const seen = new Set()
  const out = []
  for (const t of tokenize(text)) {
    if (seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// BM25 index
// ─────────────────────────────────────────────────────────────────────────────

const BM25_K1 = 1.2
const BM25_B = 0.75

/**
 * Build a BM25 index over a list of records. The indexable text of a record is
 * its content plus its tags. Returns the index object consumed by
 * {@link rank}. Nothing is mutated.
 */
export function buildIndex(records) {
  const docs = []
  const termFreqs = []
  const docLens = []
  const df = new Map()
  for (const record of records) {
    const text = [record.content, ...record.tags].filter(Boolean).join(' ')
    const freq = new Map()
    for (const t of tokenize(text)) freq.set(t, (freq.get(t) ?? 0) + 1)
    for (const t of freq.keys()) df.set(t, (df.get(t) ?? 0) + 1)
    termFreqs.push(freq)
    docLens.push(text.length)
    docs.push(record)
  }
  const total = docLens.reduce((a, b) => a + b, 0) || 1
  const avgDocLen = total / (docs.length || 1)
  return { docs, termFreqs, docLens, df, avgDocLen }
}

/**
 * BM25 relevance of every document in `index` against `queryTokens`, in match
 * order (ties broken by insertion order, then hits descending). Documents with
 * zero matched terms score 0 and are omitted from the result.
 */
export function rank(index, queryTokens) {
  const { docs, termFreqs, docLens, df, avgDocLen } = index
  const N = docs.length
  const scores = []
  for (let d = 0; d < N; d++) {
    const freq = termFreqs[d]
    let score = 0
    for (const q of queryTokens) {
      const tf = freq.get(q)
      if (tf === undefined) continue
      const idf = Math.log(1 + (N - (df.get(q) ?? 0) + 0.5) / ((df.get(q) ?? 0) + 0.5))
      const dl = docLens[d]
      const denom = tf + BM25_K1 * (1 - BM25_B + BM25_B * (dl / avgDocLen))
      score += idf * ((tf * (BM25_K1 + 1)) / denom)
    }
    if (score > 0) scores.push({ record: docs[d], score, hits: docs[d].hits })
  }
  return scores.sort((a, b) => b.score - a.score || b.hits - a.hits)
}

// ─────────────────────────────────────────────────────────────────────────────
// Store
// ─────────────────────────────────────────────────────────────────────────────

/** Default character budget for one store when the caller omits it. */
export const DEFAULT_CHAR_LIMIT = 20000
/** How long a lock may be held by a dead/unknown owner before we break it. */
const LOCK_STALE_MS = 10_000
/** Overall timeout for acquiring the lock before failing. */
const LOCK_TIMEOUT_MS = 15_000

/**
 * A single scope's durable memory (one underlying JSONL file).
 *
 * Reads load the whole file into memory on first access; writes re-serialize
 * the full file atomically under a cross-process lock. For the small,
 * human-editable corpora this is the simplest correct shape — no SQLite, no
 * external server.
 *
 * Write guards (all under the file lock, mirroring Hermes's MemoryStore):
 *   - unreadable file  → refuse the write (treating it as empty would wipe it);
 *   - external drift   → back up the file to `<file>.bak.<ts>` and refuse, so
 *     hand-edited / sister-session content is never silently discarded;
 *   - char budget      → a put that would exceed `charLimit` is refused with
 *     usage/limit/current-entries so the caller can consolidate first.
 */
export class MemoryStore {
  /** @param file - absolute path to the JSONL backing file. */
  constructor(file, { charLimit = DEFAULT_CHAR_LIMIT } = {}) {
    this.file = file
    this.charLimit = charLimit
    /** @type {Map<string, object>|null} live records keyed by id. */
    this.records = null
    this.loading = null
  }

  async #ensureLoaded() {
    if (this.records !== null) return
    this.loading ??= this.#load()
    await this.loading
  }

  async #load() {
    const state = await this.#readState()
    // Read path tolerates malformed lines and unreadable files (degrades to
    // the parsable subset / empty). The WRITE path is what refuses them.
    this.records = new Map(state.ok ? state.records.map((r) => [r.id, r]) : [])
    this.loading = null
  }

  /** Read the file, distinguishing "empty/absent" from "exists but unreadable". */
  async #readState() {
    try {
      const text = await readFile(this.file, 'utf8')
      return { ok: true, text, ...analyzeJsonl(text) }
    } catch (error) {
      if (error?.code === 'ENOENT') return { ok: true, text: '', records: [], malformed: 0 }
      return { ok: false, error }
    }
  }

  /**
   * Acquire an exclusive cross-process lock on `<file>.lock` and run `fn`.
   * Lock files carry `{pid, ts}`; a lock whose owner is dead or older than
   * {@link LOCK_STALE_MS} is broken so a crashed writer cannot deadlock the
   * store forever.
   */
  async #withLock(fn) {
    const lockPath = this.file + '.lock'
    const deadline = Date.now() + LOCK_TIMEOUT_MS
    for (;;) {
      let acquired = false
      try {
        const fh = await open(lockPath, 'wx')
        acquired = true
        try {
          await fh.writeFile(JSON.stringify({ pid: process.pid, ts: Date.now() }), 'utf8')
        } catch {
          // lock contents are advisory; a failed write still holds the lock
        }
        await fh.close()
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
        // A lock exists — break it only if stale.
        let stale = false
        try {
          const info = JSON.parse(await readFile(lockPath, 'utf8'))
          stale = !isAlive(info.pid) || Date.now() - info.ts > LOCK_STALE_MS
        } catch {
          stale = Date.now() > deadline // malformed lock: give it the deadline
        }
        if (stale) {
          await rm(lockPath, { force: true })
          continue
        }
        if (Date.now() > deadline) throw new Error(`memory store lock timeout: ${lockPath}`)
        await sleep(25)
        continue
      }
      try {
        return await fn()
      } finally {
        if (acquired) await rm(lockPath, { force: true }).catch(() => {})
      }
    }
  }

  /**
   * Run a read-modify-write under the lock. `mutate(state)` returns
   * `{ persist, value }`; when `persist` is true the in-memory map is written
   * back atomically before `value` resolves.
   */
  async #mutate(mutate) {
    return this.#withLock(async () => {
      const state = await this.#readState()
      if (!state.ok) {
        return {
          ok: false,
          reason: 'unreadable',
          error: `refusing to write ${this.file}: file exists but could not be read (${state.error?.message ?? state.error})`,
        }
      }
      if (state.malformed > 0) {
        // External drift: back the file up, then refuse so the write cannot
        // silently discard the hand-edited / sister-session content.
        const bak = `${this.file}.bak.${Date.now()}`
        await writeFile(bak, state.text, 'utf8').catch(() => {})
        return {
          ok: false,
          reason: 'drift',
          error: `refusing to write ${this.file}: the file contains ${state.malformed} malformed JSONL line(s) — likely a hand edit or an external writer. A snapshot was saved to ${bak}. Move the extra content into a clean JSONL shape (or re-add entries through the tool) before retrying.`,
          backup: bak,
        }
      }
      // Rebuild the live map from disk, but carry over the in-memory hit
      // counters (touch() is memory-only, so its increments must survive
      // until the next real persist instead of being reset by this reload).
      const memoryHits = this.records === null
        ? new Map()
        : new Map([...this.records].map(([id, r]) => [id, r.hits ?? 0]))
      this.records = new Map(state.records.map((r) => [r.id, {
        ...r,
        hits: Math.max(r.hits ?? 0, memoryHits.get(r.id) ?? 0),
      }]))
      // Snapshot before mutating so a refused write (persist:false) can roll
      // the in-memory map back — atomicity applies to the live state too, not
      // just the file.
      const snapshot = new Map([...this.records].map(([id, r]) => [id, { ...r }]))
      const outcome = mutate(state)
      if (outcome.persist) {
        await mkdir(dirname(this.file), { recursive: true })
        const tmp = join(dirname(this.file), `.${process.pid}.${randomUUID()}.tmp`)
        await writeFile(tmp, serialize([...this.records.values()]), 'utf8')
        await rename(tmp, this.file)
      } else {
        this.records = snapshot
      }
      return outcome.value
    })
  }

  /** Total content characters across `records` (the store's budget unit). */
  static usageOf(records) {
    return records.reduce((sum, r) => sum + (r.content?.length ?? 0), 0)
  }

  /** All live records, most recently updated first. */
  async list() {
    await this.#ensureLoaded()
    return [...this.records.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** Look up one record by id. */
  async get(id) {
    await this.#ensureLoaded()
    return this.records.get(id)
  }

  /**
   * Insert or update a record (by `id`).
   * @returns `{ ok: true, record }` on success, or `{ ok: false, reason, ... }`
   *   for `reason: 'limit'` (budget exceeded), `'drift'` (external content in
   *   the file), or `'unreadable'`.
   */
  async put(record) {
    return this.#mutate(() => {
      const stored = normalizeRecord(record, record.scope)
      stored.updatedAt = Date.now()
      const candidate = [...this.records.values(), stored]
      const usage = MemoryStore.usageOf(candidate)
      if (usage > this.charLimit) {
        return {
          persist: false,
          value: {
            ok: false,
            reason: 'limit',
            error: `memory at ${usage}/${this.charLimit} chars; adding this entry would exceed the limit. Remove or shorten existing entries first (memory_forget / memory_list), then retry.`,
            usage,
            limit: this.charLimit,
            currentEntries: [...this.records.values()].map((r) => r.content),
          },
        }
      }
      this.records.set(stored.id, stored)
      return { persist: true, value: { ok: true, record: stored } }
    })
  }

  /**
   * Increment the hit counter for `id` (called on recall). Memory-only: no
   * file read, lock, or rewrite — recall stays O(1) instead of rewriting the
   * whole store per hit. The increment is folded into the next real persist
   * (put/delete) via `#mutate`'s memory-hits carry-over, so it survives until
   * then; a process that exits without any later write loses only the unsaved
   * hit deltas, which is acceptable for a recency signal.
   * @returns `{ ok, touched }`; `touched: false` when the id is unknown.
   */
  async touch(id) {
    await this.#ensureLoaded()
    const record = this.records.get(id)
    if (record === undefined) return { ok: true, touched: false }
    record.hits += 1
    return { ok: true, touched: true }
  }

  /**
   * Remove one record by id.
   * @returns `{ ok, existed }`; `ok: false` when the write was refused.
   */
  async delete(id) {
    return this.#mutate(() => {
      const existed = this.records.delete(id)
      return { persist: existed, value: { ok: true, existed } }
    })
  }

  /** Run a BM25 query against the store; returns ranked records with scores. */
  async search(query, { limit = 5 } = {}) {
    await this.#ensureLoaded()
    const records = [...this.records.values()]
    if (query === undefined || String(query).trim().length === 0) {
      return records
        .slice()
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, limit)
        .map((record) => ({ record, score: 0 }))
    }
    const index = buildIndex(records)
    return rank(index, uniqueTokens(query)).slice(0, limit)
  }

  /**
   * Apply a batch of record mutations atomically under one lock and one
   * persist. The character budget is checked against the FINAL state, so a
   * batch may remove/shorten entries and add new ones in a single call even
   * when a lone add would overflow — the Hermes `operations` semantics.
   *
   * Each operation: `{ action: 'add'|'replace'|'remove', content?, id?, oldText?, tags? }`.
   *   - add:     insert a new record with `content` (+ optional tags). A record
   *              whose content already exists is skipped (dedupe).
   *   - replace: find by `id` (exact) or `oldText` (unique content substring),
   *              replace its content/tags. Ambiguous (multi-match) or missing
   *              matches are counted, not thrown.
   *   - remove:  find by `id` or unique `oldText`, delete.
   *
   * @param ops - the batch operations in order.
   * @returns the outcome with per-action tallies and final budget usage.
   */
  async applyBatch(ops) {
    return this.#mutate(() => {
      const tally = { added: 0, replaced: 0, removed: 0, skippedDuplicate: 0, skippedMissing: 0, skippedAmbiguous: 0 }
      let changed = false
      for (const op of ops ?? []) {
        if (op.action === 'add') {
          const stored = normalizeRecord({ content: op.content, tags: op.tags }, op.scope ?? 'global')
          if (stored.content.length === 0) { tally.skippedMissing += 1; continue }
          const dup = [...this.records.values()].some((r) => r.content === stored.content)
          if (dup) { tally.skippedDuplicate += 1; continue }
          stored.updatedAt = Date.now()
          this.records.set(stored.id, stored)
          tally.added += 1
          changed = true
        } else if (op.action === 'replace') {
          const match = findRecord(this.records, op)
          if (match.kind === 'missing') { tally.skippedMissing += 1; continue }
          if (match.kind === 'ambiguous') { tally.skippedAmbiguous += 1; continue }
          match.record.content = String(op.content ?? '').trim()
          match.record.tags = Array.isArray(op.tags) ? op.tags.filter((t) => typeof t === 'string' && t.length > 0) : []
          match.record.updatedAt = Date.now()
          if (match.record.content.length === 0) this.records.delete(match.record.id)
          tally.replaced += 1
          changed = true
        } else if (op.action === 'remove') {
          const match = findRecord(this.records, op)
          if (match.kind === 'missing') { tally.skippedMissing += 1; continue }
          if (match.kind === 'ambiguous') { tally.skippedAmbiguous += 1; continue }
          this.records.delete(match.record.id)
          tally.removed += 1
          changed = true
        }
        // unknown actions are ignored by the store; the tool validates them
      }
      // Budget against the FINAL state.
      const usage = MemoryStore.usageOf([...this.records.values()])
      if (usage > this.charLimit) {
        return {
          persist: false,
          value: {
            ok: false,
            reason: 'limit',
            error: `memory would be at ${usage}/${this.charLimit} chars after this batch. Remove or shorten more entries and retry.`,
            usage,
            limit: this.charLimit,
            currentEntries: [...this.records.values()].map((r) => r.content),
            tally,
          },
        }
      }
      return { persist: changed, value: { ok: true, tally, usage, limit: this.charLimit } }
    })
  }
}

/**
 * Find a record by exact `id` or unique content substring (`oldText`).
 * @returns `{ kind: 'exact'|'missing'|'ambiguous', record? }`.
 */
function findRecord(records, op) {
  if (typeof op.id === 'string' && op.id.length > 0) {
    const record = records.get(op.id)
    return record === undefined ? { kind: 'missing' } : { kind: 'exact', record }
  }
  const needle = typeof op.oldText === 'string' ? op.oldText.trim() : ''
  if (needle.length === 0) return { kind: 'missing' }
  const matches = [...records.values()].filter((r) => r.content.includes(needle))
  if (matches.length === 0) return { kind: 'missing' }
  if (matches.length > 1) return { kind: 'ambiguous' }
  return { kind: 'exact', record: matches[0] }
}

export default MemoryStore
