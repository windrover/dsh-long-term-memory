/**
 * Type declarations for the `dsh-long-term-memory` host plugin.
 *
 * @module dsh-long-term-memory
 */

/** Where a memory lives. */
export type MemoryScope = 'user' | 'global' | 'workspace'

/** How the plugin injects memory into each request assembly. */
export type InjectContextMode = 'recent' | 'full' | 'off'

/** Provenance attached to a memory record, when known. */
export interface MemorySource {
  /** The session that created the record. */
  readonly sessionId: string
  /** Optional session-log sequence for the provenance boundary. */
  readonly seq?: number
  /** Optional coarse origin label. */
  readonly origin?: 'memory_write'
}

/** One durable memory record. */
export interface MemoryRecord {
  /** Unique id; deletion targets it. */
  readonly id: string
  /** The scope this record lives under. */
  readonly scope: MemoryScope
  /** The stored fact, as a single concise statement. */
  readonly content: string
  /** Optional short tags used for recall. */
  readonly tags: string[]
  /** Provenance, when known. */
  readonly source?: MemorySource
  /** Creation epoch millis. */
  readonly createdAt: number
  /** Last write epoch millis. */
  readonly updatedAt: number
  /** Number of times recall touched it. */
  readonly hits: number
}

/** Plugin configuration. All optional. */
export interface LongTermMemoryConfig {
  /** Whether memory_write / memory_forget must first be approved (default false). */
  readonly requireApprovalForWrite?: boolean
  /**
   * How memory is injected into each request: 'recent' (default; bounded
   * digest of the newest entries per scope), 'full' (all entries, capped by
   * maxInjectedChars, Hermes-style snapshot), or 'off'. Legacy booleans are
   * accepted: true → 'recent', false → 'off'.
   */
  readonly injectContext?: InjectContextMode | boolean
  /** Whether to refuse memory_write content that matches a threat pattern (default true). */
  readonly scanThreatsOnWrite?: boolean
  /** Absolute file for the user-profile scope (default $DSH_HOME/dsh-memory/user.jsonl). */
  readonly userFile?: string
  /** Absolute file for the global scope (default $DSH_HOME/dsh-memory/global.jsonl). */
  readonly globalFile?: string
  /** Workspace-backed file, absolute or relative to each workspace root. */
  readonly workspaceFile?: string
  /** Workspace-root fallback for sessions without a cwd (default process.cwd()). */
  readonly workspaceRoot?: string
  /** Cap on the injected per-assembly digest (characters). */
  readonly maxInjectedChars?: number
  /** Enforce tool `limit` values ≤ this cap. */
  readonly maxResults?: number
  /** Per-store character budget; a write exceeding it is refused with usage/limit. */
  readonly charLimit?: number
}

/** The plugin entry point, applied by the Cordis loader. */
export function apply(ctx: unknown, config?: LongTermMemoryConfig): void
