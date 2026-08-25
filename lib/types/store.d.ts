/**
 * Type declarations for the `dsh-long-term-memory/store` module.
 *
 * @module dsh-long-term-memory/store
 */
import type { MemoryScope, MemoryRecord, MemorySource } from './index.ts'

/** A ranked recall hit. */
export interface RankedHit {
  readonly record: MemoryRecord
  /** BM25 relevance score (> 0). */
  readonly score: number
  /** Live hit counter, for stable tie-breaking. */
  readonly hits: number
}

/** Stable record shape after normalization. */
export interface StoredMemoryRecord extends MemoryRecord {}

/** Outcome of a store write (put/delete/touch). */
export type StoreWriteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'unreadable' | 'drift'; readonly error: string; readonly backup?: string }
  | { readonly ok: false; readonly reason: 'limit'; readonly error: string; readonly usage: number; readonly limit: number; readonly currentEntries: string[] }

/** Successful `put` outcome. */
export interface PutOkResult extends StoreWriteResult {
  readonly ok: true
  readonly record: StoredMemoryRecord
}

/** `delete` outcome. */
export type DeleteResult = StoreWriteResult & { readonly existed: boolean }

/** `touch` outcome. */
export type TouchResult = StoreWriteResult & { readonly touched: boolean }

/** Result of parsing JSONL text. */
export interface JsonlAnalysis {
  readonly records: MemoryRecord[]
  /** Number of lines that failed to parse. */
  readonly malformed: number
}

/** Default per-store character budget. */
export declare const DEFAULT_CHAR_LIMIT: number

/**
 * One scope's durable memory, backed by a single JSONL file. Writes run under
 * a cross-process lock and refuse to overwrite unreadable or drifted files;
 * `put` also enforces the per-store `charLimit` budget.
 */
export declare class MemoryStore {
  constructor(file: string, opts?: { charLimit?: number })
  readonly file: string
  readonly charLimit: number
  /** All live records, most recently updated first. */
  list(): Promise<MemoryRecord[]>
  /** Look up one record by id. */
  get(id: string): Promise<MemoryRecord | undefined>
  /** Insert or update a record (by id); resolves the write outcome. */
  put(record: Partial<MemoryRecord> & { scope: MemoryScope }): Promise<PutOkResult | Extract<StoreWriteResult, { ok: false }>>
  /** Increment the hit counter for `id`; resolves the write outcome. */
  touch(id: string): Promise<TouchResult>
  /** Remove one record by id; resolves the write outcome. */
  delete(id: string): Promise<DeleteResult>
  /** Run a BM25 query; returns ranked hits. */
  search(query: string, opts?: { limit?: number }): Promise<RankedHit[]>
}

/** Build a fresh empty record with defaults applied for `scope`. */
export declare function emptyRecord(scope: MemoryScope): StoredMemoryRecord
/** Normalize an incoming raw record to a stable shape. */
export declare function normalizeRecord(raw: unknown, scope: MemoryScope): StoredMemoryRecord
/** Serialize records to JSONL text. */
export declare function serialize(records: readonly MemoryRecord[]): string
/** Parse JSONL text, reporting malformed lines (write-path guard signal). */
export declare function analyzeJsonl(text: string): JsonlAnalysis
/** Parse JSONL text; skips malformed lines (read path). */
export declare function deserialize(text: string): MemoryRecord[]
/** CJK-aware tokenizer: unigrams + bigrams for CJK, lowercase words otherwise. */
export declare function tokenize(text: string): string[]
/** Unique tokens in first-seen order. */
export declare function uniqueTokens(text: string): string[]
/** Build a BM25 index over records. */
export declare function buildIndex(records: readonly MemoryRecord[]): unknown
/** BM25 relevance of every document in `index` against `queryTokens`. */
export declare function rank(index: unknown, queryTokens: string[]): RankedHit[]

export type { MemoryScope, MemoryRecord, MemorySource }
export default MemoryStore
