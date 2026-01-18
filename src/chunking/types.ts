/**
 * Chunking Types and Interfaces
 * For segmentation-ready analysis of Reddit activity patterns
 */

// ============================================================================
// CHUNK TYPES
// ============================================================================

export type ChunkType = 
  | 'ACCOUNT_TEMPORAL_WINDOW'  // Per-account fixed time windows (default 24h)
  | 'THREAD_SESSION'           // Per-account per-thread, sessionized by inactivity
  | 'COPRESENCE_WINDOW';       // Per-thread sliding window of co-active accounts

export interface ChunkConfig {
  // ACCOUNT_TEMPORAL_WINDOW settings
  temporalWindowMs: number;     // Default: 24 hours

  // THREAD_SESSION settings
  sessionGapMs: number;         // Default: 2 hours inactivity splits sessions

  // COPRESENCE_WINDOW settings
  copresenceWindowMs: number;   // Default: 30 minutes
  copresenceSlideMs: number;    // How much to slide (default: 15 minutes)

  // Embedding throttles
  maxEmbeddingsPerRun?: number; // Default: 20 (set 0 to disable)

}

export const DEFAULT_CHUNK_CONFIG: ChunkConfig = {
  temporalWindowMs: 24 * 60 * 60 * 1000,    // 24 hours
  sessionGapMs: 2 * 60 * 60 * 1000,          // 2 hours
  copresenceWindowMs: 30 * 60 * 1000,        // 30 minutes
  copresenceSlideMs: 15 * 60 * 1000,         // 15 minutes
  maxEmbeddingsPerRun: 20
};

// ============================================================================
// DATA MODELS
// ============================================================================

export interface RawItem {
  id: string;                   // Reddit ID
  item_type: 'post' | 'comment';
  account_id: string;           // Lowercased username
  thread_id: string;            // Post ID (thread root)
  parent_id: string | null;     // For comments: parent comment ID
  subreddit: string;
  created_utc: number;          // Unix timestamp
  title: string | null;
  body: string | null;
  score: number;
  permalink: string | null;
  ingested_at: number;
  raw_json: string | null;
}

export interface Chunk {
  chunk_id: string;             // Deterministic ID
  chunk_type: ChunkType;
  start_ts: number;
  end_ts: number;
  account_id: string | null;
  thread_id: string | null;
  item_count: number;
  aggregated_text: string;
  text_hash: string;
  embedding_id: string | null;
  chunk_metrics: ChunkMetrics;
  created_at: number;
  updated_at: number;
}

export interface ChunkMetrics {
  // Lexical diversity proxy
  unique_tokens: number;
  total_tokens: number;
  lexical_entropy: number;      // unique/total ratio as simple proxy
  
  // Linguistic markers for regime detection
  hedging_count: number;        // maybe, perhaps, seems, might, could be
  certainty_count: number;      // obviously, clearly, definitely, everyone knows
  imperative_count: number;     // you should, must, need to, have to
  question_count: number;       // sentences ending in ?
  
  // Basic stats
  char_count: number;
  sentence_count: number;
  avg_word_length: number;
}

export interface ChunkItem {
  chunk_id: string;
  item_id: string;
  position: number;
}

export interface CopresenceMember {
  chunk_id: string;
  account_id: string;
  first_seen_ts: number;
  item_count: number;
}

export interface EmbeddingCacheEntry {
  id: string;                   // Hash of (text_hash, model, version, provider)
  text_hash: string;
  embed_model: string;
  embed_version: string;
  provider_name: string;
  embedding_vector: number[];
  dimensions: number;
  created_at: number;
}

export interface Watermark {
  watermark_name: string;
  last_processed_ts: number;
  last_processed_id: string | null;
  updated_at: number;
}

export interface ReplyEdge {
  parent_item_id: string;
  child_item_id: string;
  parent_account_id: string;
  child_account_id: string;
  thread_id: string;
  created_at: number;
}

// ============================================================================
// EMBEDDING PROVIDER INTERFACE
// ============================================================================

export interface EmbeddingResult {
  vector: number[];
  model: string;
  version: string;
  provider: string;
  dimensions: number;
}

export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  readonly version: string;
  readonly dimensions: number;
  
  embed(text: string): Promise<EmbeddingResult>;
  embedBatch(texts: string[]): Promise<EmbeddingResult[]>;
}

// ============================================================================
// HELPER TYPES
// ============================================================================

export interface ProcessingResult {
  chunks_created: number;
  chunks_updated: number;
  embeddings_computed: number;
  embeddings_cached: number;
  items_processed: number;
  errors: string[];
}

export interface ChunkingStats {
  total_chunks: number;
  by_type: Record<ChunkType, number>;
  total_items: number;
  total_embeddings: number;
  last_watermark_ts: number | null;
}
