// dsh-long-term-memory — layered deterministic long-term memory for DSH.
//
// A static Host plugin that composes existing DSH seams (no core changes):
//   - four model-facing tools: memory_write / memory_recall / memory_list /
//     memory_forget
//   - one per-assembly dynamic-context contribution that injects a bounded
//     "recent memory" digest into each request
//   - an optional write-approval gate via `tools/pre-execute` returning
//     `{ kind: 'ask' }`, which the tool registry resolves through the approval
//     seam (fail-closed when no approval service is mounted)
//   - deterministic CJK-aware BM25 recall (no embeddings, no extra model calls)
//
// Storage is plain JSONL. `global` scope lives under $DSH_HOME/dsh-memory;
// `workspace` scope lives in the session's working directory at
// `.dsh/memory.jsonl`, so it is human-editable and can be committed with the
// project. The plugin never mutates a DSH core package.

import { dirname, isAbsolute, resolve } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { MemoryStore, DEFAULT_CHAR_LIMIT, exportBundle, parseExportBundle } from './store.js'
import { scanThreats } from './threats.js'

export const name = 'long-term-memory'
export const inject = ['tools', 'systemPrompt']

/** Default number of results returned when the caller omits `limit`. */
const DEFAULT_RECALL_LIMIT = 5
/** Hard cap on a single tool's recall/list result count. */
const MAX_RESULTS = 25
/** Bounds the per-assembly injected digest so it never dominates a request. */
const DEFAULT_MAX_INJECTED_CHARS = 2400
/** How many recent memories each scope may contribute to the injected digest. */
const DEFAULT_TIMELINE_INJECTED_SPLIT = 4
/** Prompt-section order; tool guidance lives in the 100–199 band. */
const TOOL_GUIDANCE_ORDER = 118
/** Dynamic-context order; after other runtime-context rows (100–119). */
const CONTEXT_ORDER = 130

/** Scope precedence for injection and "all" scans: user profile first. */
const SCOPE_PRIORITY = ['user', 'global', 'workspace']
const SCOPES = new Set(SCOPE_PRIORITY)

/** How the plugin injects memory each assembly. */
const INJECT_MODES = new Set(['recent', 'full', 'off'])

/** Coerce legacy boolean config (`injectContext: true/false`) into a mode. */
function normalizeInjectMode(value) {
  if (value === undefined || value === true) return 'recent'
  if (value === false) return 'off'
  if (INJECT_MODES.has(value)) return value
  throw new Error(`invalid injectContext mode "${value}" (expected "recent", "full", or "off")`)
}

function assertScope(scope) {
  if (scope === undefined) return undefined
  if (!SCOPES.has(scope)) {
    throw new Error(`invalid memory scope "${scope}" (expected "user", "global", or "workspace")`)
  }
  return scope
}

/**
 * Resolve the workspace root for a session. `ctx.session.header.cwd` is the
 * immutable workspace-write boundary; the configured root is the fallback for
 * agentless calls or sessions without a cwd.
 */
function resolveWorkspaceRoot(session, config) {
  const cwd = session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return resolve(cwd)
  return resolve(config.workspaceRoot ?? process.cwd())
}

/**
 * Absolute backing-file path for one scope. `user` and `global` are shared
 * files under the harness home (user profile first-class, global for
 * cross-project facts); `workspace` is one file per workspace root.
 */
function storePathFor(scope, workspaceRoot, config) {
  if (scope === 'user') return config.userFile ?? dshHomePath('dsh-memory', 'user.jsonl')
  if (scope === 'global') return config.globalFile ?? dshHomePath('dsh-memory', 'global.jsonl')
  if (scope === 'workspace') {
    const base = config.workspaceFile ?? `.dsh/memory.jsonl`
    return isAbsolute(base) ? base : resolve(workspaceRoot, base)
  }
  throw new Error(`unsupported memory scope ${scope}`)
}

/**
 * Plugin config. All optional.
 */
export function defineConfig() {
  return {
    /** Whether memory_write / memory_forget must first be approved. Default off. */
    requireApprovalForWrite: false,
    /**
     * How memory is injected into each request: 'recent' (default; a bounded
     * digest of the newest entries per scope), 'full' (all entries, capped by
     * maxInjectedChars, Hermes-style snapshot), or 'off'. Legacy booleans are
     * accepted: true → 'recent', false → 'off'.
     */
    injectContext: 'recent',
    /** Whether to refuse memory_write content that matches a threat pattern. Default on. */
    scanThreatsOnWrite: true,
    /** Absolute file for the user-profile scope (default $DSH_HOME/dsh-memory/user.jsonl). */
    userFile: undefined,
    /** Absolute file for the global scope (default $DSH_HOME/dsh-memory/global.jsonl). */
    globalFile: undefined,
    /** Workspace-backed file, absolute or relative to each workspace root. */
    workspaceFile: undefined,
    /** Workspace root fallback for sessions without a cwd (default process.cwd()). */
    workspaceRoot: undefined,
    /** Cap on the injected per-assembly digest (characters). */
    maxInjectedChars: DEFAULT_MAX_INJECTED_CHARS,
    /** Enforce `limit` values ≤ MAX_RESULTS. */
    maxResults: MAX_RESULTS,
    /** Per-store character budget; a write exceeding it is refused with usage/limit. */
    charLimit: DEFAULT_CHAR_LIMIT,
  }
}

/** Bound a caller-specified result limit into [1, maxResults]. */
function clampLimit(limit, maxResults) {
  if (!Number.isInteger(limit) || limit < 1) return DEFAULT_RECALL_LIMIT
  return Math.min(limit, maxResults)
}

/**
 * Describe one memory record compactly for the model: id, scope, tags, and the
 * content (which is left as-is, not quoted).
 */
function describeRecord(record, score) {
  const tags = Array.isArray(record.tags) && record.tags.length > 0 ? ` [${record.tags.join(', ')}]` : ''
  const scoreText = typeof score === 'number' && score > 0 ? ` (score ${score.toFixed(2)})` : ''
  return `- ${record.id} [${record.scope}]${tags}: ${record.content}${scoreText}`
}

/** A stable, bounded render of a set of ranked records. */
function renderRecords(records, heading) {
  if (records.length === 0) return `${heading}: none.`
  return `${heading}:\n${records.map(({ record, score }) => describeRecord(record, score)).join('\n')}`
}

/** Human-readable heading for a scope in the injected digest. */
function scopeLabel(scope) {
  switch (scope) {
    case 'user': return 'User profile memory'
    case 'global': return 'Global memory'
    case 'workspace': return 'Workspace memory'
    default: return `${scope} memory`
  }
}

/**
 * Build the per-assembly recent-memory digest for one scope, bounded by a
 * character budget. Recency is `updatedAt`; no retrieval is performed, so this
 * is deterministic and cheap.
 */
async function recentDigest(store, maxChars, split) {
  const all = await store.list()
  const recent = all.slice(0, split)
  if (recent.length === 0) return ''
  const lines = recent.map((r) => describeRecord(r))
  // Greedily drop the oldest lines until under budget, always keeping ≥1.
  let budget = String(lines.length).length + 2
  const kept = []
  for (const line of lines) {
    if (kept.length > 0 && budget + line.length > maxChars) break
    kept.push(line)
    budget += line.length + 1
  }
  return kept.join('\n')
}

/**
 * Synchronous sibling of {@link recentDigest} for the per-assembly context
 * contribution. DSH's prompt assembler evaluates `text` functions
 * synchronously (no await — an async function would land a Promise in the
 * assembly and crash interpolation with "text.indexOf is not a function"),
 * so this reads the store's already-loaded in-memory records instead of the
 * async `list()`. Callers must warm the store first (fire `store.list()`
 * once) and tolerate an empty digest for the very first assembly in a
 * process.
 *
 * `mode` selects how much is injected per scope:
 *   - 'recent' — the newest `split` entries (bounded, cheap);
 *   - 'full'   — every entry, still capped by `maxChars` (Hermes-style
 *                frozen-snapshot feel; falls back to newest-first under the
 *                budget).
 * Entries matching a threat pattern are replaced by a `[BLOCKED: …]`
 * placeholder so a poisoned-on-disk entry cannot reach the system prompt,
 * while the live store keeps the original for the user to inspect and
 * remove (mirrors Hermes's snapshot sanitization).
 */
function recentDigestSync(store, maxChars, split, mode = 'recent') {
  const records = store.records
  if (records === null || records.size === 0) return ''
  const sorted = [...records.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  const recent = mode === 'full' ? sorted : sorted.slice(0, split)
  const lines = recent.map((r) => {
    const threats = scanThreats(r.content)
    if (threats.length > 0) {
      return describeRecord({ ...r, content: `[BLOCKED: entry matches threat pattern(s): ${threats.join(', ')}. Use memory_list/memory_forget to inspect and remove the original.]` })
    }
    return describeRecord(r)
  })
  // Greedily drop the oldest lines until under budget, always keeping ≥1.
  let budget = String(lines.length).length + 2
  const kept = []
  for (const line of lines) {
    if (kept.length > 0 && budget + line.length > maxChars) break
    kept.push(line)
    budget += line.length + 1
  }
  return kept.join('\n')
}

export function apply(ctx, config = {}) {
  const initializedConfig = defineConfig()
  const cfg = { ...initializedConfig, ...config }
  // Never let a caller exceed the hard result cap.
  const maxResults = Math.min(cfg.maxResults, MAX_RESULTS)

  // Cache one store instance per backing-file path so reads reuse the
  // in-memory index across turns instead of re-reading the file each time.
  const stores = new Map()

  /**
   * Resolve (and cache) the store for a scope. `workspace` needs the session to
   * know which workspace; `user` and `global` are single-root and shared.
   */
  function storeFor(scope, session, owner) {
    const workspaceRoot = resolveWorkspaceRoot(session, cfg)
    const file = storePathFor(scope, workspaceRoot, cfg)
    let store = stores.get(file)
    if (store === undefined) {
      store = new MemoryStore(file, { charLimit: cfg.charLimit })
      stores.set(file, store)
    }
    return { store, workspaceRoot, file }
  }

  // ── system guidance ───────────────────────────────────────────────────────
  ctx.systemPrompt.section({
    name: 'tool:long-term-memory',
    order: TOOL_GUIDANCE_ORDER,
    text:
      'Long-term memory is available. Persist durable, cross-session facts with memory_write ' +
      '(e.g. user preferences, project constraints, decisions, URLs, IDs) rather than relying on ' +
      'the conversation that will be compacted. Fetch them with memory_recall when a relevant ' +
      'task begins or a previously stated constraint matters. Use memory_forget when a fact is ' +
      'no longer true. Several relevant memories are already injected below.',
  })

  // ── per-assembly dynamic context ──────────────────────────────────────────
  const injectMode = normalizeInjectMode(cfg.injectContext)
  if (injectMode !== 'off') {
    // Warm the shared stores at apply time so the very first assembly in a
    // process already renders the digest (workspace stores depend on the
    // session's cwd and are warmed on first assembly).
    for (const scope of SCOPE_PRIORITY) {
      if (scope !== 'workspace') void storeFor(scope, undefined, ctx).store.list().catch(() => {})
    }
    ctx.systemPrompt.context({
      name: 'long-term-memory:inject',
      order: CONTEXT_ORDER,
      // Must be SYNCHRONOUS: DSH's assembler evaluates `text` functions with a
      // plain call, never awaiting them, and interpolation then runs
      // `text.indexOf(...)` on the result. An async function returns a Promise
      // and crashes every turn with "text.indexOf is not a function". Stores
      // keep their records in memory after the first load, so a sync render is
      // possible once warmed; until then the digest is simply empty.
      text: (context) => {
        const session = context.agent?.session
        const parts = []
        for (const scope of SCOPE_PRIORITY) {
          const store = storeFor(scope, session, ctx).store
          if (store.records === null) void store.list().catch(() => {})
          const digest = recentDigestSync(store, cfg.maxInjectedChars, DEFAULT_TIMELINE_INJECTED_SPLIT, injectMode)
          if (digest) parts.push(`${scopeLabel(scope)}:\n${digest}`)
        }
        if (parts.length === 0) return ''
        return `Long-term memory (recall the rest with memory_recall):\n${parts.join('\n\n')}`
      },
    })
  }

  // ── write-approval gate (opt-in) ──────────────────────────────────────────
  if (cfg.requireApprovalForWrite) {
    ctx.on('tools/pre-execute', (exec, next) => {
      if (exec.name !== 'memory_write' && exec.name !== 'memory_forget') return next()
      return {
        kind: 'ask',
        reason: exec.name === 'memory_write'
          ? 'Store a new long-term memory'
          : 'Delete a long-term memory',
      }
    })
  }

  // ── tools ─────────────────────────────────────────────────────────────────

  // memory_write — store one durable memory record.
  ctx.tools.register(defineTool({
    name: 'memory_write',
    description:
      'Persist one durable memory record (a fact, decision, preference, constraint, URL, or ID) that should ' +
      'survive context compaction and persist across sessions. ' +
      'Use scope "user" for who the user is (name, role, preferences, style); "workspace" (default) for ' +
      'project-specific facts that belong with this working directory; "global" for facts true across all projects. ' +
      'Returns the stored record id and the resolved scope, which later memory_forget targets. ' +
      'Writes are capped by a per-store character budget: when the budget is full the tool reports usage and ' +
      'current entries so you can forget or shorten older entries first.',
    parameters: {
      content: {
        type: 'string',
        required: true,
        description: 'The durable fact to remember, written as a single concise statement.',
      },
      scope: {
        type: 'string',
        enum: ['user', 'global', 'workspace'],
        description: 'Where the memory lives. Defaults to "workspace" when the session has a working directory, else "global". Use "user" for personal profile facts.',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional short tags (e.g. "preference", "decision", "constraint") used for recall.',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string', required: true, description: 'Stored record id for later memory_forget.' },
          scope: { type: 'string', required: true, enum: ['user', 'global', 'workspace'] },
          content: { type: 'string', required: true },
          createdAt: { type: 'number', required: true },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Stored a ${value.scope} memory (${value.id}): ${value.content}`,
      }],
    },
    async execute(args, exec) {
      const session = exec.agent?.session
      const content = String(args.content ?? '').trim()
      if (content.length === 0) {
        throw new Error('memory_write: content must be a non-empty statement')
      }
      if (cfg.scanThreatsOnWrite) {
        const threats = scanThreats(content)
        if (threats.length > 0) {
          throw new Error(`memory_write: content rejected — matches threat pattern(s): ${threats.join(', ')}`)
        }
      }
      const scope = assertScope(args.scope) ?? (session?.header?.cwd ? 'workspace' : 'global')
      const { store } = storeFor(scope, session, ctx)
      const source = session === undefined ? undefined : {
        sessionId: session.id,
        ...(exec.agent !== undefined ? { origin: 'memory_write' } : {}),
      }
      const outcome = await store.put({
        scope,
        content,
        tags: Array.isArray(args.tags) ? args.tags.filter((t) => typeof t === 'string' && t.length > 0) : [],
        source,
      })
      if (!outcome.ok) {
        throw new Error(`memory_write: ${outcome.error}${outcome.reason === 'limit' && outcome.currentEntries?.length ? `\nCurrent entries:\n${outcome.currentEntries.join('\n')}` : ''}`)
      }
      return {
        id: outcome.record.id,
        scope: outcome.record.scope,
        content: outcome.record.content,
        createdAt: outcome.record.updatedAt,
      }
    },
  }))

  // memory_recall — deterministic BM25 retrieval across user + global + workspace.
  ctx.tools.register(defineTool({
    name: 'memory_recall',
    description:
      'Retrieve stored long-term memory by relevance (CJK-aware keyword / BM25 — no embeddings, no extra model calls). ' +
      'Search "user" (who the user is), "global" (all projects), and/or "workspace" (this working directory) by default. ' +
      'Returns up to `limit` records with their ids, scopes, and relevance scores, so the model can confirm a fact or ' +
      'target one with memory_forget. Use before a task that depends on a previously stated constraint.',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'The keyword or phrase to match; CJK text is matched by character bigrams.',
      },
      scope: {
        type: 'string',
        enum: ['user', 'global', 'workspace', 'all'],
        description: 'Scope to search. Defaults to "all" (user, global, and workspace).',
      },
      limit: {
        type: 'number',
        description: 'Max results (default 5; capped ' + MAX_RESULTS + ').',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          query: { type: 'string', required: true },
          results: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', required: true },
                scope: { type: 'string', required: true, enum: ['user', 'global', 'workspace'] },
                content: { type: 'string', required: true },
                tags: { type: 'array', items: { type: 'string' } },
                score: { type: 'number', required: true },
              },
              additionalProperties: false,
            },
            required: true,
          },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: renderRecords(value.results, `Recalled memory for "${value.query}"`),
      }],
    },
    async execute(args, exec) {
      const session = exec.agent?.session
      const scope = args.scope === 'all' || args.scope === undefined ? 'all' : assertScope(args.scope)
      const limit = clampLimit(args.limit, maxResults)
      const scopes = scope === 'all' ? SCOPE_PRIORITY : [scope]
      const results = []
      for (const s of scopes) {
        const { store } = storeFor(s, session, ctx)
        const hits = await store.search(String(args.query ?? ''), { limit })
        for (const hit of hits) {
          await store.touch(hit.record.id) // best-effort hit counter; failures ignored
          results.push({
            id: hit.record.id,
            scope: hit.record.scope,
            content: hit.record.content,
            tags: Array.isArray(hit.record.tags) ? hit.record.tags : [],
            score: hit.score,
          })
        }
      }
      results.sort((a, b) => b.score - a.score)
      return { query: String(args.query ?? ''), results: results.slice(0, limit) }
    },
  }))

  // memory_list — recent records for one scope, newest first.
  ctx.tools.register(defineTool({
    name: 'memory_list',
    description:
      'List the most recently stored memory records (newest first) for one scope, without retrieval scoring. ' +
      'Use it to survey what long-term memory already exists after a compact, or to find an id for memory_forget.',
    parameters: {
      scope: {
        type: 'string',
        enum: ['user', 'global', 'workspace', 'all'],
        description: 'Scope to list. Defaults to "all".',
      },
      limit: {
        type: 'number',
        description: 'Max records (default 5; capped ' + MAX_RESULTS + ').',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          results: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', required: true },
                scope: { type: 'string', required: true, enum: ['user', 'global', 'workspace'] },
                content: { type: 'string', required: true },
                tags: { type: 'array', items: { type: 'string' } },
                updatedAt: { type: 'number', required: true },
              },
              additionalProperties: false,
            },
            required: true,
          },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: renderRecords(value.results.map((r) => ({ record: r })), 'Recent memory'),
      }],
    },
    async execute(args, exec) {
      const session = exec.agent?.session
      const scope = args.scope === 'all' || args.scope === undefined ? 'all' : assertScope(args.scope)
      const limit = clampLimit(args.limit, maxResults)
      const scopes = scope === 'all' ? SCOPE_PRIORITY : [scope]
      const results = []
      for (const s of scopes) {
        const { store } = storeFor(s, session, ctx)
        const records = await store.list()
        for (const record of records.slice(0, limit)) {
          results.push({
            id: record.id,
            scope: record.scope,
            content: record.content,
            tags: Array.isArray(record.tags) ? record.tags : [],
            updatedAt: record.updatedAt,
          })
        }
      }
      results.sort((a, b) => b.updatedAt - a.updatedAt)
      return { results: results.slice(0, limit) }
    },
  }))

  // memory_forget — delete one record by id.
  ctx.tools.register(defineTool({
    name: 'memory_forget',
    description:
      'Delete one stored memory record by id (returned by memory_write, memory_recall, or memory_list). ' +
      'Use when a previously remembered fact is no longer true or was stored in error.',
    parameters: {
      id: { type: 'string', required: true, description: 'The memory record id to delete.' },
      scope: {
        type: 'string',
        enum: ['user', 'global', 'workspace'],
        description: 'The scope the record lives in. When omitted, all scopes are checked and only the first match is deleted.',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          deleted: { type: 'boolean', required: true },
          id: { type: 'string', required: true },
          scope: { type: 'string', required: true, enum: ['user', 'global', 'workspace'] },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.deleted
          ? `Forgot ${value.scope} memory ${value.id}.`
          : `No ${value.scope} memory ${value.id} existed to forget.`,
      }],
    },
    async execute(args, exec) {
      const session = exec.agent?.session
      const scope = assertScope(args.scope)
      const scopes = scope === undefined ? SCOPE_PRIORITY : [scope]
      for (const s of scopes) {
        const { store } = storeFor(s, session, ctx)
        const outcome = await store.delete(args.id)
        if (outcome.ok && outcome.existed) return { deleted: true, id: args.id, scope: s }
      }
      return { deleted: false, id: args.id, scope: scopes[0] }
    },
  }))

  // memory_export — produce a portable bundle of one or all scopes.
  ctx.tools.register(defineTool({
    name: 'memory_export',
    description:
      'Export long-term memory as a portable bundle (v1 JSON, or human-readable Markdown). ' +
      'Only content, scope, and tags travel — provenance and hit counters are intentionally dropped. ' +
      'Use it for backup, migration to another machine, or sharing a project memory. ' +
      'The returned bundle can be re-imported with memory_import.',
    parameters: {
      scope: {
        type: 'string',
        enum: ['user', 'global', 'workspace', 'all'],
        description: 'Scope to export. Defaults to "all".',
      },
      format: {
        type: 'string',
        enum: ['json', 'markdown'],
        description: 'Export format. Defaults to "json" (round-trip importable); "markdown" is human-readable only.',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          scope: { type: 'string', required: true },
          format: { type: 'string', required: true, enum: ['json', 'markdown'] },
          count: { type: 'number', required: true },
          bundle: { type: 'string', required: true, description: 'The serialized export bundle.' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Exported ${value.count} memory record(s) (${value.scope}, ${value.format}):\n${value.bundle}`,
      }],
    },
    async execute(args, exec) {
      const session = exec.agent?.session
      const scope = args.scope === 'all' || args.scope === undefined ? 'all' : assertScope(args.scope)
      const format = args.format === 'markdown' ? 'markdown' : 'json'
      const scopes = scope === 'all' ? SCOPE_PRIORITY : [scope]
      const records = []
      for (const s of scopes) {
        const { store } = storeFor(s, session, ctx)
        records.push(...await store.list())
      }
      return {
        scope,
        format,
        count: records.length,
        bundle: exportBundle(records, format),
      }
    },
  }))

  // memory_import — restore records from a v1 JSON export bundle.
  ctx.tools.register(defineTool({
    name: 'memory_import',
    description:
      'Import records from a v1 JSON export bundle (produced by memory_export). ' +
      'Each record keeps its scope unless a scope is forced. Duplicate content already present in the ' +
      'target scope is skipped. Use it to restore a backup or migrate memory from another machine.',
    parameters: {
      bundle: {
        type: 'string',
        required: true,
        description: 'The v1 JSON export bundle text to import.',
      },
      scope: {
        type: 'string',
        enum: ['user', 'global', 'workspace'],
        description: 'Force all imported records into this scope (default: keep each record\'s own scope).',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          imported: { type: 'number', required: true },
          skippedDuplicates: { type: 'number', required: true },
          perScope: {
            type: 'object',
            additionalProperties: true,
            description: 'Imported count per scope.',
          },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Imported ${value.imported} memory record(s) (${value.skippedDuplicates} duplicates skipped): ` +
          Object.entries(value.perScope).map(([s, n]) => `${s}=${n}`).join(', '),
      }],
    },
    async execute(args, exec) {
      const session = exec.agent?.session
      const forcedScope = assertScope(args.scope)
      const parsed = parseExportBundle(args.bundle)
      let imported = 0
      let skippedDuplicates = 0
      const perScope = {}
      for (const record of parsed) {
        const scope = forcedScope ?? record.scope
        const { store } = storeFor(scope, session, ctx)
        // Skip if an identical content already exists in the target scope.
        const existing = await store.list()
        const dup = existing.some((r) => r.content === record.content)
        if (dup) {
          skippedDuplicates += 1
          continue
        }
        const outcome = await store.put({ ...record, scope })
        if (outcome.ok) {
          imported += 1
          perScope[scope] = (perScope[scope] ?? 0) + 1
        } else if (outcome.reason === 'limit') {
          // Budget-exceeded records are skipped like duplicates.
          skippedDuplicates += 1
        } else {
          throw new Error(`memory_import: ${outcome.error}`)
        }
      }
      return { imported, skippedDuplicates, perScope }
    },
  }))

  // memory_batch — atomically apply multiple mutations to one scope.
  ctx.tools.register(defineTool({
    name: 'memory_batch',
    description:
      'Apply a batch of memory mutations to ONE scope atomically — all operations succeed or none are persisted, ' +
      'under a single file lock and a single write. The character budget is checked against the FINAL state, ' +
      'so a single call can remove or shorten stale entries AND add new ones even when a lone add would overflow. ' +
      'Operations run in order: add inserts (duplicates skipped), replace updates by id or unique content substring, ' +
      'remove deletes by id or unique content substring. Ambiguous or missing targets are counted in the result, not errors.',
    parameters: {
      scope: {
        type: 'string',
        enum: ['user', 'global', 'workspace'],
        required: true,
        description: 'The scope all operations apply to. Batch is single-scope by design (one atomic write).',
      },
      operations: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          properties: {
            action: { type: 'string', required: true, enum: ['add', 'replace', 'remove'] },
            content: { type: 'string', description: 'New content for add/replace.' },
            id: { type: 'string', description: 'Exact record id for replace/remove (takes precedence over oldText).' },
            oldText: { type: 'string', description: 'Unique content substring for replace/remove when no id is given.' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Tags for add, or the replacement tags for replace.' },
          },
          additionalProperties: false,
        },
        description: 'The operations to apply, in order.',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          scope: { type: 'string', required: true },
          ok: { type: 'boolean', required: true },
          added: { type: 'number', required: true },
          replaced: { type: 'number', required: true },
          removed: { type: 'number', required: true },
          skippedDuplicate: { type: 'number', required: true },
          skippedMissing: { type: 'number', required: true },
          skippedAmbiguous: { type: 'number', required: true },
          usage: { type: 'number', required: true },
          limit: { type: 'number', required: true },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? `Batch applied (${value.scope}): +${value.added} added, ~${value.replaced} replaced, -${value.removed} removed; ` +
            `skipped ${value.skippedDuplicate} duplicate, ${value.skippedMissing} missing, ${value.skippedAmbiguous} ambiguous. Usage ${value.usage}/${value.limit}.`
          : `Batch rejected (${value.scope}): memory would exceed ${value.limit} chars (usage ${value.usage}). ` +
            `Remove or shorten more entries and retry.`,
      }],
    },
    async execute(args, exec) {
      const session = exec.agent?.session
      const scope = assertScope(args.scope)
      const ops = Array.isArray(args.operations) ? args.operations : []
      for (const op of ops) {
        if (!['add', 'replace', 'remove'].includes(op.action)) {
          throw new Error(`memory_batch: unknown action "${op.action}"`)
        }
        if (op.action === 'add' && !(typeof op.content === 'string' && op.content.trim().length > 0)) {
          throw new Error('memory_batch: add requires non-empty content')
        }
        if ((op.action === 'replace' || op.action === 'remove') &&
            !(typeof op.id === 'string' && op.id.length > 0) &&
            !(typeof op.oldText === 'string' && op.oldText.trim().length > 0)) {
          throw new Error(`memory_batch: ${op.action} requires id or oldText`)
        }
        if (cfg.scanThreatsOnWrite && (op.action === 'add' || op.action === 'replace') && typeof op.content === 'string') {
          const threats = scanThreats(op.content)
          if (threats.length > 0) {
            throw new Error(`memory_batch: content rejected — matches threat pattern(s): ${threats.join(', ')}`)
          }
        }
      }
      const { store } = storeFor(scope, session, ctx)
      const outcome = await store.applyBatch(ops.map((op) => ({ ...op, scope })))
      if (!outcome.ok) {
        throw new Error(`memory_batch: ${outcome.error}`)
      }
      return {
        scope,
        ok: true,
        added: outcome.tally.added,
        replaced: outcome.tally.replaced,
        removed: outcome.tally.removed,
        skippedDuplicate: outcome.tally.skippedDuplicate,
        skippedMissing: outcome.tally.skippedMissing,
        skippedAmbiguous: outcome.tally.skippedAmbiguous,
        usage: outcome.usage,
        limit: outcome.limit,
      }
    },
  }))
}
