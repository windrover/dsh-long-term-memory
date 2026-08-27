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
import z from '@deepseek-ai/schemastery'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { MemoryStore, DEFAULT_CHAR_LIMIT, exportBundle, parseExportBundle } from './store.js'
import { scanThreats } from './threats.js'
import { askLlm } from './llm.js'
import { newUserText, parseFacts, compressRules, buildInjectionBlock, filterByTags } from './automation.js'

export const name = 'long-term-memory'
export const inject = ['tools', 'systemPrompt', 'commands', 'settings', 'agents']
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
     * maxInjectedChars, snapshot-style), or 'off'. Legacy booleans are
     * accepted: true → 'recent', false → 'off'.
     */
    injectContext: 'recent',
    /**
     * In 'recent' mode, only inject entries carrying at least one of these
     * tags (e.g. ["decision", "constraint"]). Empty (default) = inject every
     * recent entry. 'full' mode ignores this filter (snapshot semantics).
     */
    injectTags: [],
    /** Whether to refuse memory_write content that matches a threat pattern. Default on. */
    scanThreatsOnWrite: true,
    /**
     * Automatically distill durable facts from each finished conversation
     * turn (agent/status idle → runMaintenance → LLM extraction). Default off:
     * each run is an auxiliary model call, so it is opt-in.
     */
    autoSummarize: false,
    /** Minimum elapsed time between auto-summarize runs per agent (ms). */
    summarizeIntervalMs: 30_000,
    /** Only summarize a turn that produced at least this many new user messages. */
    summarizeMinMessages: 1,
    /**
     * Compress with the LLM when a write would exceed the char budget; when
     * off, deterministic rule-based compression (merge similar + drop cold
     * entries) is used instead. Default off (rule-based).
     */
    compressWithLLM: false,
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
    /** Per-store character budget; a write exceeding it is refused (after compression attempts). */
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
  const stale = record.superseded === true ? ' [SUPERSEDED]' : ''
  return `- ${record.id} [${record.scope}]${tags}${stale}: ${record.content}${scoreText}`
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
  *
  * `injectTags`, when non-empty, restricts 'recent' mode to entries carrying
  * at least one of those tags (roadmap: 标签过滤注入). 'full' mode ignores
  * it (snapshot semantics).
  */
function recentDigestSync(store, maxChars, split, mode = 'recent', injectTags) {
  const records = store.records
  if (records === null || records.size === 0) return ''
  const base = [...records.values()].filter((r) => r.superseded !== true) // corrected facts never re-inject
  const tagged = mode === 'full' ? base : filterByTags(base, injectTags)
  const sorted = tagged.sort((a, b) => b.updatedAt - a.updatedAt)
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

  // ── settings namespace（热重载开关，settings.yaml 可覆盖）──────────────
  // 注册 schema 后：settings.yaml 里 `long-term-memory:` 一节可覆盖默认值，
  // 外部编辑热发布；/memory settings 命令与未来 Web 界面走同一 scope。
  const settingsSchema = z.object({
    autoSummarize: z.boolean().default(cfg.autoSummarize),
    summarizeIntervalMs: z.number().min(0).default(cfg.summarizeIntervalMs),
    summarizeMinMessages: z.number().min(0).default(cfg.summarizeMinMessages),
    compressWithLLM: z.boolean().default(cfg.compressWithLLM),
    injectContext: z.union([z.const('recent'), z.const('full'), z.const('off')]).default(cfg.injectContext),
    injectTags: z.array(z.string()).default(cfg.injectTags),
    requireApprovalForWrite: z.boolean().default(cfg.requireApprovalForWrite),
    charLimit: z.number().min(1).default(cfg.charLimit),
  })
  let memorySettings
  try {
    memorySettings = ctx.settings.register('long-term-memory', settingsSchema)
  } catch {
    memorySettings = undefined // settings 服务未挂载时降级为纯配置
  }
  /** 读取当前生效的自动化开关（settings 优先，回退 config）。 */
  function eff(scope, key, fallback) {
    if (memorySettings !== undefined) {
      try {
        const v = memorySettings.get()
        if (v && v[key] !== undefined) return v[key]
      } catch { /* schema 校验失败时用 fallback */ }
    }
    return fallback
  }

  // ── 自动总结：回合结束蒸馏 ──────────────────────────────────────────────
  // agent/status → idle 表示一轮结束；在 runMaintenance 空闲期提取本轮新增
  // 用户文本，调 LLM 蒸馏成事实写入记忆。开关默认关（每次都是辅助模型调用）。
  const lastSummarized = new Map() // agent id → { seq, at }
  const summarizePrompt =
    'You are the memory-distillation step of a long-term memory system. ' +
    'From the conversation excerpt below, extract the durable, cross-session facts worth remembering: ' +
    'user preferences, corrections, personal details, project constraints, decisions, stable environment facts, ' +
    'URLs and IDs. Skip trivia, task progress, and re-discoverable details. ' +
    'Reply with ONLY a JSON array, e.g. [{"scope":"user","content":"...","tags":["preference"]}], ' +
    'where scope is one of "user" (who the user is), "global" (true across all projects), or "workspace" (project-specific). ' +
    'Return [] when nothing is worth remembering.'
  ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'idle') return
    if (!eff(null, 'autoSummarize', cfg.autoSummarize)) return
    // runMaintenance 是空闲期维护任务，不阻塞对话；失败仅记录。
    agent.runMaintenance(async (signal) => {
      const minMessages = eff(null, 'summarizeMinMessages', cfg.summarizeMinMessages)
      const intervalMs = eff(null, 'summarizeIntervalMs', cfg.summarizeIntervalMs)
      const last = lastSummarized.get(agent.id)
      const sinceSeq = last?.seq ?? -1
      const now = Date.now()
      if (last !== undefined && now - last.at < intervalMs) return // 防抖
      const text = newUserText(agent.session.events, sinceSeq)
      if (text.length === 0) return
      const msgCount = agent.session.events.filter((e) => e.type === 'user/message' && e.seq > sinceSeq).length
      if (msgCount < minMessages) return
      try {
        const reply = await askLlm(ctx, agent, { system: summarizePrompt, userText: text, signal })
        const facts = parseFacts(reply)
        for (const fact of facts) {
          if (scanThreats(fact.content).length > 0) continue // 威胁内容跳过
          const { store } = storeFor(fact.scope, agent.session, ctx)
          const existing = await store.list()
          if (existing.some((r) => r.content === fact.content)) continue
          const outcome = await store.put({ ...fact, source: { sessionId: agent.session.id, origin: 'auto_summarize' } })
          if (!outcome.ok && outcome.reason === 'limit') {
            // 超限：规则压缩（为新事实预留字符）后重试一次
            const { kept, dropped } = compressRules(existing, cfg.charLimit - fact.content.length)
            const keptUsage = MemoryStore.usageOf(kept)
            if (keptUsage < cfg.charLimit - fact.content.length && kept.length < existing.length) {
              for (const d of dropped) await store.delete(d.id)
              await store.put({ ...fact, source: { sessionId: agent.session.id, origin: 'auto_summarize' } })
            }
          }
        }
      } catch {
        // 总结失败不影响会话；下次 idle 会再试（seq 未推进则跳过重复文本）
      } finally {
        // 记录已处理到的 seq，避免重复蒸馏同一段
        const events = agent.session.events
        const lastSeq = events.length > 0 ? events[events.length - 1].seq : sinceSeq
        lastSummarized.set(agent.id, { seq: lastSeq, at: Date.now() })
      }
    }).catch(() => {})
  })

  // ── 写入超限自动压缩（memory_write 内部复用）────────────────────────────
  /**
   * 尝试把 `store` 压缩到 charLimit 以内，为新写入腾空间。
   * compressWithLLM 开：仅当能用 LLM 精炼（有 agent）时调用；否则规则压缩。
   * @returns {Promise<boolean>} 是否腾出空间（压缩后 usage < limit）。
   */
  async function tryCompress(store, session, agent, reserveChars = 0) {
    const current = await store.list()
    const usage = MemoryStore.usageOf(current)
    const target = cfg.charLimit - reserveChars
    if (usage < target) return true
    const useLLM = eff(null, 'compressWithLLM', cfg.compressWithLLM) && agent !== undefined
    if (useLLM) {
      try {
        const reply = await askLlm(ctx, agent, {
          system:
            'You are the compression step of a long-term memory system. ' +
            'The memory store is over its character budget. Merge overlapping entries and drop stale ones, ' +
            'preserving the most important durable facts. Reply with ONLY a JSON array of ' +
            '[{"scope":"user|global|workspace","content":"...","tags":["..."]}] — the complete compressed store.',
          userText: `Current store (${usage}/${cfg.charLimit} chars):\n` +
            current.map((r) => `- [${r.scope}] ${r.content}${r.tags.length ? ` [${r.tags.join(', ')}]` : ''}`).join('\n'),
          signal: undefined,
        })
        const facts = parseFacts(reply)
        if (facts.length > 0 && facts.length < current.length) {
          const kept = facts.filter((f) => scanThreats(f.content).length === 0)
          for (const r of current) await store.delete(r.id)
          for (const f of kept) {
            const out = await store.put({ ...f, source: { sessionId: session?.id, origin: 'auto_compress' } })
            if (!out.ok) break // 预算仍超则停止
          }
          return MemoryStore.usageOf(await store.list()) < target
        }
      } catch {
        // LLM 压缩失败回退规则压缩
      }
    }
    const target2 = cfg.charLimit - (reserveChars ?? 0)
    const { kept, dropped } = compressRules(current, target2)
    const keptUsage = MemoryStore.usageOf(kept)
    if (keptUsage < target2) {
      // 只有真正腾出空间才删除——避免"删除已落盘但写入仍失败"的破坏性副作用
      for (const d of dropped) await store.delete(d.id)
      return true
    }
    return false
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
      'no longer true, or memory_correct to record a correction that supersedes the stale ' +
      'records automatically. Several relevant memories are already injected below.',
  })

  // ── per-assembly dynamic context ──────────────────────────────────────────
  // Read LIVE settings (settings.yaml hot-reloads): injectContext and
  // injectTags apply on the next assembly, no restart needed.
  if (eff(null, 'injectContext', cfg.injectContext) !== 'off') {
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
        const mode = normalizeInjectMode(eff(null, 'injectContext', cfg.injectContext))
        const injectTags = eff(null, 'injectTags', cfg.injectTags)
        const parts = []
        for (const scope of SCOPE_PRIORITY) {
          const store = storeFor(scope, session, ctx).store
          if (store.records === null) void store.list().catch(() => {})
          const digest = recentDigestSync(store, cfg.maxInjectedChars, DEFAULT_TIMELINE_INJECTED_SPLIT, mode, injectTags)
          if (digest) parts.push(`${scopeLabel(scope)}:\n${digest}`)
        }
        if (parts.length === 0) return ''
        return buildInjectionBlock(parts.join('\n\n'))
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
      if (!outcome.ok && outcome.reason === 'limit') {
        // 超限：先尝试自动压缩腾空间（为新内容预留字符），再重试一次；仍失败才报错。
        const freed = await tryCompress(store, session, exec.agent, content.length)
        if (freed) {
          const retry = await store.put({
            scope,
            content,
            tags: Array.isArray(args.tags) ? args.tags.filter((t) => typeof t === 'string' && t.length > 0) : [],
            source,
          })
          if (retry.ok) {
            return {
              id: retry.record.id,
              scope: retry.record.scope,
              content: retry.record.content,
              createdAt: retry.record.updatedAt,
            }
          }
          throw new Error(`memory_write: ${retry.error}`)
        }
        throw new Error(`memory_write: ${outcome.error}${outcome.currentEntries?.length ? `\nCurrent entries:\n${outcome.currentEntries.join('\n')}` : ''}`)
      }
      if (!outcome.ok) {
        throw new Error(`memory_write: ${outcome.error}`)
      }
      return {
        id: outcome.record.id,
        scope: outcome.record.scope,
        content: outcome.record.content,
        createdAt: outcome.record.updatedAt,
      }
    },
  }))

  // memory_correct — record a correction and supersede the stale records it matches.
  ctx.tools.register(defineTool({
    name: 'memory_correct',
    description:
      'Record that a previously stored memory is wrong or outdated: writes the corrected fact as a new ' +
      'memory and marks the existing records it matches as superseded. Superseded records are excluded ' +
      'from memory_recall and the injected digest (they stay visible in memory_list with a [SUPERSEDED] ' +
      'marker for cleanup with memory_forget). Use when you verify a memory no longer holds: state what ' +
      'it claimed, what is actually true now, and your evidence.',
    parameters: {
      claim: {
        type: 'string',
        required: true,
        description: 'What the stale memory claimed — matched against stored records to find what this correction supersedes.',
      },
      truth: {
        type: 'string',
        required: true,
        description: 'What is actually true now; stored as the new memory record.',
      },
      evidence: {
        type: 'string',
        description: 'Optional evidence for the correction (source, verification result, observed counterexample).',
      },
      scope: {
        type: 'string',
        enum: ['user', 'global', 'workspace'],
        description: 'Scope to correct in. Defaults like memory_write (workspace when the session has a working directory, else global).',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string', required: true, description: 'The new correction record id.' },
          scope: { type: 'string', required: true, enum: ['user', 'global', 'workspace'] },
          content: { type: 'string', required: true },
          superseded: { type: 'array', items: { type: 'string' }, required: true, description: 'Ids of the stale records marked superseded.' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Corrected a ${value.scope} memory (${value.id}): ${value.content}` +
          (value.superseded.length > 0
            ? `\nMarked superseded: ${value.superseded.join(', ')}`
            : '\n(no existing records matched the claim)'),
      }],
    },
    async execute(args, exec) {
      const session = exec.agent?.session
      const claim = String(args.claim ?? '').trim()
      const truth = String(args.truth ?? '').trim()
      if (claim.length === 0) {
        throw new Error('memory_correct: claim must describe what the stale memory said')
      }
      if (truth.length === 0) {
        throw new Error('memory_correct: truth must state what is actually true now')
      }
      if (cfg.scanThreatsOnWrite) {
        const threats = scanThreats(truth)
        if (threats.length > 0) {
          throw new Error(`memory_correct: content rejected — matches threat pattern(s): ${threats.join(', ')}`)
        }
      }
      const scope = assertScope(args.scope) ?? (session?.header?.cwd ? 'workspace' : 'global')
      const { store } = storeFor(scope, session, ctx)
      const source = session === undefined ? undefined : {
        sessionId: session.id,
        ...(exec.agent !== undefined ? { origin: 'memory_correct' } : {}),
      }
      const content = args.evidence ? `${truth} (evidence: ${String(args.evidence).trim()})` : truth
      // Find the stale records this correction supersedes: top claim matches,
      // excluding a record identical to the new truth (nothing to correct).
      const hits = await store.search(claim, { limit: 5 })
      const candidates = hits.filter((h) => h.record.content !== truth).map((h) => h.record.id)
      const finish = async (record) => {
        const { marked } = await store.supersede(candidates, record.id)
        return { id: record.id, scope: record.scope, content: record.content, superseded: marked }
      }
      // Write the correction first so supersede() can point at its id.
      const outcome = await store.put({ scope, content, tags: ['correction'], source })
      if (!outcome.ok && outcome.reason === 'limit') {
        const freed = await tryCompress(store, session, exec.agent, content.length)
        if (freed) {
          const retry = await store.put({ scope, content, tags: ['correction'], source })
          if (retry.ok) return finish(retry.record)
          throw new Error(`memory_correct: ${retry.error}`)
        }
        throw new Error(`memory_correct: ${outcome.error}${outcome.currentEntries?.length ? `\nCurrent entries:\n${outcome.currentEntries.join('\n')}` : ''}`)
      }
      if (!outcome.ok) {
        throw new Error(`memory_correct: ${outcome.error}`)
      }
      return finish(outcome.record)
    },
  }))

  // memory_recall — deterministic BM25 retrieval across user + global + workspace.
  ctx.tools.register(defineTool({
    name: 'memory_recall',
    description:
      'Retrieve stored long-term memory by relevance (CJK-aware keyword / BM25 — no embeddings, no extra model calls). ' +
      'Search "user" (who the user is), "global" (all projects), and/or "workspace" (this working directory) by default. ' +
      'Superseded records (facts corrected with memory_correct) are excluded. ' +
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

  // memory_diagnose — inspect the memory system's live state (observability).
  ctx.tools.register(defineTool({
    name: 'memory_diagnose',
    description:
      'Report safe diagnostics for the long-term memory plugin: the settings actually in effect ' +
      '(injectContext / injectTags / autoSummarize / compressWithLLM / charLimit), whether the ' +
      'per-assembly injection is active, and per-scope store stats (live vs total records, char ' +
      'usage vs limit, superseded count, backing file). Never returns secrets. Use when memory ' +
      'seems to be missing or misbehaving (e.g. injection not appearing, writes failing).',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          report: { type: 'string', required: true, description: 'Multi-line diagnostics report.' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    async execute(args, exec) {
      const session = exec.agent?.session
      const lines = []
      const mode = normalizeInjectMode(eff(null, 'injectContext', cfg.injectContext))
      lines.push('long-term-memory diagnose')
      lines.push(`- injectContext: ${mode}${mode === 'off' ? ' (injection DISABLED — nothing is injected per assembly)' : ''}`)
      lines.push(`- injectTags: ${JSON.stringify(eff(null, 'injectTags', cfg.injectTags) ?? [])}${mode !== 'recent' ? ' (recent-only filter)' : ''}`)
      lines.push(`- maxInjectedChars: ${cfg.maxInjectedChars}`)
      lines.push(`- autoSummarize: ${eff(null, 'autoSummarize', cfg.autoSummarize)}`)
      lines.push(`- compressWithLLM: ${eff(null, 'compressWithLLM', cfg.compressWithLLM)}`)
      lines.push(`- requireApprovalForWrite: ${eff(null, 'requireApprovalForWrite', cfg.requireApprovalForWrite)}`)
      lines.push(`- charLimit: ${eff(null, 'charLimit', cfg.charLimit)}`)
      for (const scope of SCOPE_PRIORITY) {
        try {
          const { store, file } = storeFor(scope, session, ctx)
          if (store.records === null) await store.list().catch(() => {})
          const records = [...store.records.values()]
          const live = records.filter((r) => r.superseded !== true)
          lines.push(`- ${scope}: ${live.length} live / ${records.length} total (${records.length - live.length} superseded), ${MemoryStore.usageOf(records)}/${store.charLimit} chars, file: ${file}`)
        } catch (error) {
          lines.push(`- ${scope}: unavailable (${String(error?.message ?? error)})`)
        }
      }
      return { report: lines.join('\n') }
    },
  }))

  // ── /memory user command ───────────────────────────────────────────────────
  // Human-facing surface (no model involved): browse, search, inspect, forget,
  // and export memories directly. Usage:
  //   /memory                 — help
  //   /memory list [scope]    — recent records, newest first
  //   /memory search <query>  — BM25 recall
  //   /memory get <id>        — one record
  //   /memory forget <id>     — delete one record
  //   /memory export [format] — portable bundle (json | markdown)
  ctx.commands.register({
    name: 'memory',
    description: 'Browse, search, inspect, forget, or export long-term memory (user-facing, no model call).',
    input: { hint: 'list | search <query> | get <id> | forget <id> | export [json|markdown]' },
    async handler(invocation) {
      const session = invocation.agent?.session
      const raw = invocation.rawInput.trim()
      const [sub, ...rest] = raw.split(/\s+/)
      try {
        if (sub === '' || sub === 'help' || sub === '-h' || sub === '--help') {
          return { kind: 'success', text: memoryHelp() }
        }
        if (sub === 'list') {
          const scopeArg = rest[0]
          const scope = scopeArg === undefined || scopeArg === 'all' ? 'all' : assertScope(scopeArg)
          const scopes = scope === 'all' ? SCOPE_PRIORITY : [scope]
          const lines = []
          for (const s of scopes) {
            const { store } = storeFor(s, session, ctx)
            const records = await store.list()
            if (records.length === 0) continue
            lines.push(`## ${scopeLabel(s)} (${records.length})`)
            for (const r of records.slice(0, maxResults)) {
              const tags = r.tags.length > 0 ? ` [${r.tags.join(', ')}]` : ''
              const stale = r.superseded === true ? ' [SUPERSEDED]' : ''
              lines.push(`- \`${r.id}\`${tags}${stale}: ${r.content}`)
            }
          }
          return { kind: 'success', text: lines.length > 0 ? lines.join('\n') : 'No memories stored yet.' }
        }
        if (sub === 'search') {
          const query = rest.join(' ')
          if (query.length === 0) return { kind: 'error', text: 'usage: /memory search <query>' }
          const scopes = SCOPE_PRIORITY
          const results = []
          for (const s of scopes) {
            const { store } = storeFor(s, session, ctx)
            const hits = await store.search(query, { limit: maxResults })
            for (const hit of hits) results.push({ ...hit, scope: s })
          }
          results.sort((a, b) => b.score - a.score)
          if (results.length === 0) return { kind: 'success', text: `No memories matched "${query}".` }
          const lines = results.slice(0, maxResults).map((h) => {
            const tags = h.record.tags.length > 0 ? ` [${h.record.tags.join(', ')}]` : ''
            return `- \`${h.record.id}\` [${h.scope}]${tags} (score ${h.score.toFixed(2)}): ${h.record.content}`
          })
          return { kind: 'success', text: `Matched ${results.length} for "${query}":\n${lines.join('\n')}` }
        }
        if (sub === 'get') {
          const id = rest[0]
          if (!id) return { kind: 'error', text: 'usage: /memory get <id>' }
          for (const s of SCOPE_PRIORITY) {
            const { store } = storeFor(s, session, ctx)
            const record = await store.get(id)
            if (record !== undefined) {
              const tags = record.tags.length > 0 ? ` [${record.tags.join(', ')}]` : ''
              const source = record.source ? ` (from session ${record.source.sessionId})` : ''
              return { kind: 'success', text: `\`${record.id}\` [${record.scope}]${tags}${source}\n${record.content}` }
            }
          }
          return { kind: 'error', text: `No memory with id ${id}.` }
        }
        if (sub === 'forget') {
          const id = rest[0]
          if (!id) return { kind: 'error', text: 'usage: /memory forget <id>' }
          for (const s of SCOPE_PRIORITY) {
            const { store } = storeFor(s, session, ctx)
            const outcome = await store.delete(id)
            if (outcome.ok && outcome.existed) {
              return { kind: 'success', text: `Forgot ${s} memory ${id}.` }
            }
          }
          return { kind: 'error', text: `No memory with id ${id}.` }
        }
        if (sub === 'export') {
          const format = rest[0] === 'markdown' ? 'markdown' : 'json'
          const records = []
          for (const s of SCOPE_PRIORITY) {
            const { store } = storeFor(s, session, ctx)
            records.push(...await store.list())
          }
          return { kind: 'success', text: exportBundle(records, format) }
        }
        return { kind: 'error', text: `Unknown /memory subcommand "${sub}".\n\n${memoryHelp()}` }
      } catch (error) {
        return { kind: 'error', text: `memory command failed: ${error.message}` }
      }
    },
  })

  // ── 宿主 API（供未来 Web 记忆管理界面调用）─────────────────────────────
  // webServer 只在 web profile 存在；其它 profile 无界面需求，惰性跳过。
  // 路由：GET /api/memory/list?scope=   GET /api/memory/search?q=&scope=
  //        GET /api/memory/get?id=     DELETE /api/memory/delete?id=
  //        POST /api/memory/import     GET /api/memory/settings
  const webServer = ctx.get('webServer')
  if (webServer !== undefined) {
    const sendJson = (res, status, value) => {
      const body = JSON.stringify(value)
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body),
      })
      res.end(body)
    }
    const readJsonBody = async (req) => {
      let body = ''
      for await (const chunk of req) {
        body += chunk
        if (body.length > 1_048_576) throw new Error('request body too large')
      }
      return body === '' ? {} : JSON.parse(body)
    }
    const routes = {
      '/api/memory/list': async (req, res) => {
        const scope = new URL(req.url, 'http://localhost').searchParams.get('scope') ?? 'all'
        const session = ctx.agents?.currentInitiator?.()?.session
        const scopes = scope === 'all' ? SCOPE_PRIORITY : [assertScope(scope)]
        const results = []
        for (const s of scopes) {
          const { store } = storeFor(s, session, ctx)
          results.push(...(await store.list()).map((r) => ({ ...r, scope: s })))
        }
        results.sort((a, b) => b.updatedAt - a.updatedAt)
        sendJson(res, 200, { results })
      },
      '/api/memory/search': async (req, res) => {
        const params = new URL(req.url, 'http://localhost').searchParams
        const query = params.get('q') ?? ''
        const scope = params.get('scope') ?? 'all'
        const session = ctx.agents?.currentInitiator?.()?.session
        const scopes = scope === 'all' ? SCOPE_PRIORITY : [assertScope(scope)]
        const results = []
        for (const s of scopes) {
          const { store } = storeFor(s, session, ctx)
          const hits = await store.search(query, { limit: maxResults })
          results.push(...hits.map((h) => ({ ...h.record, scope: s, score: h.score })))
        }
        results.sort((a, b) => b.score - a.score)
        sendJson(res, 200, { query, results })
      },
      '/api/memory/get': async (req, res) => {
        const id = new URL(req.url, 'http://localhost').searchParams.get('id') ?? ''
        for (const s of SCOPE_PRIORITY) {
          const { store } = storeFor(s, undefined, ctx)
          const record = await store.get(id)
          if (record !== undefined) return sendJson(res, 200, { record: { ...record, scope: s } })
        }
        sendJson(res, 404, { error: 'not found' })
      },
      '/api/memory/delete': async (req, res) => {
        const id = new URL(req.url, 'http://localhost').searchParams.get('id') ?? ''
        for (const s of SCOPE_PRIORITY) {
          const { store } = storeFor(s, undefined, ctx)
          const outcome = await store.delete(id)
          if (outcome.ok && outcome.existed) return sendJson(res, 200, { deleted: true, scope: s })
        }
        sendJson(res, 404, { error: 'not found' })
      },
      '/api/memory/settings': async (req, res) => {
        if (req.method === 'POST') {
          let payload
          try {
            payload = await readJsonBody(req)
          } catch (error) {
            return sendJson(res, 400, { error: `bad request: ${String(error?.message ?? error)}` })
          }
          if (memorySettings === undefined) {
            return sendJson(res, 409, { error: 'settings service is not mounted in this profile' })
          }
          const patch = {}
          for (const key of ['autoSummarize', 'compressWithLLM', 'injectContext', 'injectTags', 'requireApprovalForWrite', 'charLimit']) {
            if (payload[key] !== undefined) patch[key] = payload[key]
          }
          if (Object.keys(patch).length === 0) return sendJson(res, 400, { error: 'no supported settings fields' })
          try {
            await memorySettings.update(patch)
          } catch (error) {
            return sendJson(res, 422, { error: `invalid settings: ${String(error?.message ?? error)}` })
          }
        }
        sendJson(res, 200, {
          autoSummarize: eff(null, 'autoSummarize', cfg.autoSummarize),
          compressWithLLM: eff(null, 'compressWithLLM', cfg.compressWithLLM),
          injectContext: eff(null, 'injectContext', cfg.injectContext),
          injectTags: eff(null, 'injectTags', cfg.injectTags),
          requireApprovalForWrite: eff(null, 'requireApprovalForWrite', cfg.requireApprovalForWrite),
          charLimit: eff(null, 'charLimit', cfg.charLimit),
        })
      },
      '/api/memory/put': async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
        let payload
        try {
          payload = await readJsonBody(req)
        } catch (error) {
          return sendJson(res, 400, { error: `bad request: ${String(error?.message ?? error)}` })
        }
        const scope = assertScope(payload.scope) ?? 'global'
        const content = typeof payload.content === 'string' ? payload.content.trim() : ''
        if (content.length === 0) return sendJson(res, 400, { error: 'content is required' })
        if (cfg.scanThreatsOnWrite) {
          const threats = scanThreats(content)
          if (threats.length > 0) return sendJson(res, 422, { error: `content matches threat pattern(s): ${threats.join(', ')}` })
        }
        const { store } = storeFor(scope, undefined, ctx)
        const record = {
          scope,
          content,
          tags: Array.isArray(payload.tags) ? payload.tags.filter((t) => typeof t === 'string' && t.length > 0) : [],
        }
        if (typeof payload.id === 'string' && payload.id.length > 0) record.id = payload.id // 编辑：按 id 更新
        const outcome = await store.put(record)
        if (outcome.ok) return sendJson(res, 200, { ok: true, record: outcome.record })
        if (outcome.reason === 'limit') {
          const freed = await tryCompress(store, undefined, undefined, content.length)
          if (freed) {
            const retry = await store.put(record)
            if (retry.ok) return sendJson(res, 200, { ok: true, record: retry.record })
            return sendJson(res, 409, { error: retry.error })
          }
        }
        sendJson(res, 409, { error: outcome.error })
      },
      '/api/memory/import': async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
        let payload
        try {
          payload = await readJsonBody(req)
        } catch (error) {
          return sendJson(res, 400, { error: `bad request: ${String(error?.message ?? error)}` })
        }
        try {
          const forcedScope = payload.scope ? assertScope(payload.scope) : undefined
          const parsed = parseExportBundle(payload.bundle ?? '')
          let imported = 0
          let skipped = 0
          const perScope = {}
          for (const record of parsed) {
            const scope = forcedScope ?? record.scope
            const { store } = storeFor(scope, undefined, ctx)
            const existing = await store.list()
            if (existing.some((r) => r.content === record.content)) { skipped += 1; continue }
            const outcome = await store.put({ ...record, scope })
            if (outcome.ok) { imported += 1; perScope[scope] = (perScope[scope] ?? 0) + 1 }
            else if (outcome.reason !== 'limit') { skipped += 1 }
          }
          sendJson(res, 200, { imported, skipped, perScope })
        } catch (error) {
          sendJson(res, 400, { error: String(error?.message ?? error) })
        }
      },
    }
    for (const [path, handler] of Object.entries(routes)) {
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path,
        handler: async (req, res) => {
          try {
            await handler(req, res)
          } catch (error) {
            sendJson(res, Number(error?.status) > 0 ? error.status : 500, { error: String(error?.message ?? error) })
          }
        },
      }), `long-term-memory: ${path}`)
    }
  }
}
function memoryHelp() {
  return [
    'Usage:',
    '  /memory list [user|global|workspace|all]   — recent records, newest first',
    '  /memory search <query>                     — BM25 recall across all scopes',
    '  /memory get <id>                           — inspect one record',
    '  /memory forget <id>                        — delete one record',
    '  /memory export [json|markdown]             — portable bundle',
  ].join('\n')
}
