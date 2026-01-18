/**
 * Chunking Module Index
 * Re-exports all chunking functionality
 */

// Types
export * from './types';

// Text processing utilities
export {
  normalizeText,
  aggregateItemTexts,
  sha256,
  generateChunkId,
  generateEmbeddingCacheId,
  extractChunkMetrics,
} from './text-processing';

// Chunk builders
export {
  buildAccountTemporalChunks,
  buildThreadSessionChunks,
  buildCopresenceChunks,
  buildAllChunks,
} from './chunk-builders';

// Embedding providers
export {
  StubEmbeddingProvider,
  OpenAIEmbeddingProvider,
  CloudflareAiEmbeddingProvider,
  createEmbeddingProvider,
} from './embedding-providers';

// Pipeline
export type { ChunkingDatabase } from './pipeline';
export { D1ChunkingDatabase, ChunkingPipeline } from './pipeline';
