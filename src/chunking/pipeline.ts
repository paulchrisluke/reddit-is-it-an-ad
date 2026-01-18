/**
 * Chunking Pipeline
 * Orchestrates incremental chunking and embedding with watermarking
 */

import type {
  RawItem,
  Chunk,
  ChunkItem,
  CopresenceMember,
  EmbeddingCacheEntry,
  Watermark,
  ReplyEdge,
  ProcessingResult,
  ChunkConfig,
  EmbeddingProvider,
  DEFAULT_CHUNK_CONFIG,
} from './types';
import { buildAllChunks } from './chunk-builders';
import { generateEmbeddingCacheId } from './text-processing';

// ============================================================================
// DATABASE INTERFACE (D1-compatible)
// ============================================================================

export interface ChunkingDatabase {
  // Items
  getItemsSinceWatermark(watermarkTs: number, limit: number): Promise<RawItem[]>;
  insertItem(item: RawItem): Promise<void>;
  insertItems(items: RawItem[]): Promise<void>;
  
  // Chunks
  getChunkByTextHash(textHash: string, chunkType: string): Promise<Chunk | null>;
  upsertChunk(chunk: Chunk): Promise<void>;
  upsertChunks(chunks: Chunk[]): Promise<void>;
  
  // Chunk Items
  insertChunkItems(items: ChunkItem[]): Promise<void>;
  deleteChunkItems(chunkId: string): Promise<void>;
  
  // Copresence Members
  insertCopresenceMembers(members: CopresenceMember[]): Promise<void>;
  deleteCopresenceMembers(chunkId: string): Promise<void>;
  
  // Embeddings Cache
  getEmbedding(textHash: string, model: string, version: string, provider: string): Promise<EmbeddingCacheEntry | null>;
  insertEmbedding(entry: EmbeddingCacheEntry): Promise<void>;
  
  // Watermarks
  getWatermark(name: string): Promise<Watermark | null>;
  setWatermark(watermark: Watermark): Promise<void>;
  
  // Reply Edges
  insertReplyEdge(edge: ReplyEdge): Promise<void>;
  insertReplyEdges(edges: ReplyEdge[]): Promise<void>;
  
  // Stats
  getChunkingStats(): Promise<{
    total_chunks: number;
    total_items: number;
    total_embeddings: number;
  }>;
}

// ============================================================================
// D1 & VECTORIZE IMPLEMENTATION
// ============================================================================

export class D1ChunkingDatabase implements ChunkingDatabase {
  constructor(private db: D1Database, private vectorize?: VectorizeIndex) {}

  async getItemsSinceWatermark(watermarkTs: number, limit: number): Promise<RawItem[]> {
    const result = await this.db.prepare(`
      SELECT * FROM items 
      WHERE ingested_at > ?
      ORDER BY ingested_at ASC
      LIMIT ?
    `).bind(watermarkTs, limit).all();
    
    return (result.results || []) as unknown as RawItem[];
  }

  // ... (insertItem, insertItems, getChunkByTextHash, upsertChunk, upsertChunks, insertChunkItems, deleteChunkItems, insertCopresenceMembers, deleteCopresenceMembers methods remain unchanged - implicit reuse or I can explicitly include them if I want to be safe, but usually replace_file_content needs context. I will assume the previous method bodies are preserved if I don't target them. Wait, simple replacement of class needs all methods.) 
  
  // I'll target just the embedding methods to override them with Vectorize logic

  async insertItem(item: RawItem): Promise<void> {
     await this.db.prepare(`
      INSERT OR REPLACE INTO items 
      (id, item_type, account_id, thread_id, parent_id, subreddit, created_utc, title, body, score, permalink, ingested_at, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      item.id, item.item_type, item.account_id, item.thread_id, item.parent_id,
      item.subreddit, item.created_utc, item.title, item.body, item.score,
      item.permalink, item.ingested_at, item.raw_json
    ).run();
  }

  async insertItems(items: RawItem[]): Promise<void> {
    if (items.length === 0) return;
    
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO items 
      (id, item_type, account_id, thread_id, parent_id, subreddit, created_utc, title, body, score, permalink, ingested_at, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    const batch = items.map(item => stmt.bind(
      item.id, item.item_type, item.account_id, item.thread_id, item.parent_id,
      item.subreddit, item.created_utc, item.title, item.body, item.score,
      item.permalink, item.ingested_at, item.raw_json
    ));
    
    await this.db.batch(batch);
  }

  async getChunkByTextHash(textHash: string, chunkType: string): Promise<Chunk | null> {
    const result = await this.db.prepare(`
      SELECT * FROM chunks WHERE text_hash = ? AND chunk_type = ? LIMIT 1
    `).bind(textHash, chunkType).first();
    
    if (!result) return null;
    
    return {
      ...result,
      chunk_metrics: JSON.parse(result.chunk_metrics as string || '{}'),
    } as Chunk;
  }

  async upsertChunk(chunk: Chunk): Promise<void> {
    await this.db.prepare(`
      INSERT OR REPLACE INTO chunks 
      (chunk_id, chunk_type, start_ts, end_ts, account_id, thread_id, item_count, aggregated_text, text_hash, embedding_id, chunk_metrics, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      chunk.chunk_id, chunk.chunk_type, chunk.start_ts, chunk.end_ts,
      chunk.account_id, chunk.thread_id, chunk.item_count, chunk.aggregated_text,
      chunk.text_hash, chunk.embedding_id, JSON.stringify(chunk.chunk_metrics),
      chunk.created_at, chunk.updated_at
    ).run();
  }

  async upsertChunks(chunks: Chunk[]): Promise<void> {
    if (chunks.length === 0) return;
    
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO chunks 
      (chunk_id, chunk_type, start_ts, end_ts, account_id, thread_id, item_count, aggregated_text, text_hash, embedding_id, chunk_metrics, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    const batch = chunks.map(chunk => stmt.bind(
      chunk.chunk_id, chunk.chunk_type, chunk.start_ts, chunk.end_ts,
      chunk.account_id, chunk.thread_id, chunk.item_count, chunk.aggregated_text,
      chunk.text_hash, chunk.embedding_id, JSON.stringify(chunk.chunk_metrics),
      chunk.created_at, chunk.updated_at
    ));
    
    await this.db.batch(batch);
  }

  async insertChunkItems(items: ChunkItem[]): Promise<void> {
    if (items.length === 0) return;
    
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO chunk_items (chunk_id, item_id, position)
      VALUES (?, ?, ?)
    `);
    
    const batch = items.map(item => stmt.bind(item.chunk_id, item.item_id, item.position));
    await this.db.batch(batch);
  }

  async deleteChunkItems(chunkId: string): Promise<void> {
    await this.db.prepare(`DELETE FROM chunk_items WHERE chunk_id = ?`).bind(chunkId).run();
  }

  async insertCopresenceMembers(members: CopresenceMember[]): Promise<void> {
    if (members.length === 0) return;
    
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO copresence_members (chunk_id, account_id, first_seen_ts, item_count)
      VALUES (?, ?, ?, ?)
    `);
    
    const batch = members.map(m => stmt.bind(m.chunk_id, m.account_id, m.first_seen_ts, m.item_count));
    await this.db.batch(batch);
  }

  async deleteCopresenceMembers(chunkId: string): Promise<void> {
    await this.db.prepare(`DELETE FROM copresence_members WHERE chunk_id = ?`).bind(chunkId).run();
  }

  // --- Vectorize Implementation for Embeddings ---

  async getEmbedding(textHash: string, model: string, version: string, provider: string): Promise<EmbeddingCacheEntry | null> {
    // If Vectorize binding is available, use it for cache lookup
    if (this.vectorize) {
        // Construct cache key same as D1
        // ID generation should ideally be imported, but for safety lets recreate logic or use existing ID if passed.
        // Wait, getEmbedding logic expects hash parameters lookup.
        // In Vectorize, we must use `getByIds` to find if it exists.
        // We need the deterministic ID *before* calling this.
        // Actually, pipeline calls `generateEmbeddingCacheId` before insert, but `getEmbedding` is called with params.
        // We need to generate the ID here to look it up.
        
        // Simple deterministic ID generation:
        const encoder = new TextEncoder();
        const data = encoder.encode([textHash, model, version, provider].join('|'));
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const id = `emb_${hashArray.map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 24)}`;

        try {
            const results = await this.vectorize.getByIds([id]);
            if (results && results.length > 0) {
                // We found it! Reconstruct Entry
                const v = results[0];
                return {
                    id: v.id,
                    text_hash: textHash,
                    embed_model: model,
                    embed_version: version,
                    provider_name: provider,
                    embedding_vector: Array.isArray(v.values) ? v.values : Array.from(v.values), // Convert Float32Array if needed
                    dimensions: v.values.length,
                    created_at: Date.now() // Approximate, or store in metadata
                };
            }
            return null;
        } catch (e) {
            console.warn('Vectorize lookup failed, falling back to D1 or null:', e);
            // Fallthrough to D1 if Vectorize fails or not found?
            // User requested "use cloudflare chunking/stack", implying Vectorize.
            return null;
        }
    }

    // Fallback to D1 (original logic)
    const result = await this.db.prepare(`
      SELECT * FROM embeddings_cache 
      WHERE text_hash = ? AND embed_model = ? AND embed_version = ? AND provider_name = ?
      LIMIT 1
    `).bind(textHash, model, version, provider).first();
    
    if (!result) return null;
    
    return {
      ...result,
      embedding_vector: JSON.parse(result.embedding_vector as string || '[]'),
    } as EmbeddingCacheEntry;
  }

  async insertEmbedding(entry: EmbeddingCacheEntry): Promise<void> {
    if (this.vectorize) {
        try {
            await this.vectorize.insert([{
                id: entry.id,
                values: entry.embedding_vector,
                metadata: {
                    text_hash: entry.text_hash,
                    model: entry.embed_model,
                    version: entry.embed_version,
                    provider: entry.provider_name
                }
            }]);
            return;
        } catch (e) {
            console.error('Vectorize insert failed:', e);
            // Fallback to D1? Or throw?
            // Let's attempt D1 also for redundancy or just throw.
            // Using pure Vectorize is cleaner.
            throw e;
        }
    }

    // D1 Fallback
    await this.db.prepare(`
      INSERT OR REPLACE INTO embeddings_cache 
      (id, text_hash, embed_model, embed_version, provider_name, embedding_vector, dimensions, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      entry.id, entry.text_hash, entry.embed_model, entry.embed_version,
      entry.provider_name, JSON.stringify(entry.embedding_vector), entry.dimensions, entry.created_at
    ).run();
  }
  
  // Back to other methods...

  async getWatermark(name: string): Promise<Watermark | null> {
    const result = await this.db.prepare(`
      SELECT * FROM watermarks WHERE watermark_name = ?
    `).bind(name).first();
    
    return result as Watermark | null;
  }

  async setWatermark(watermark: Watermark): Promise<void> {
    await this.db.prepare(`
      INSERT OR REPLACE INTO watermarks (watermark_name, last_processed_ts, last_processed_id, updated_at)
      VALUES (?, ?, ?, ?)
    `).bind(
      watermark.watermark_name, watermark.last_processed_ts,
      watermark.last_processed_id, watermark.updated_at
    ).run();
  }

  async insertReplyEdge(edge: ReplyEdge): Promise<void> {
    await this.db.prepare(`
      INSERT OR IGNORE INTO reply_edges 
      (parent_item_id, child_item_id, parent_account_id, child_account_id, thread_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      edge.parent_item_id, edge.child_item_id, edge.parent_account_id,
      edge.child_account_id, edge.thread_id, edge.created_at
    ).run();
  }

  async insertReplyEdges(edges: ReplyEdge[]): Promise<void> {
    if (edges.length === 0) return;
    
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO reply_edges 
      (parent_item_id, child_item_id, parent_account_id, child_account_id, thread_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    
    const batch = edges.map(e => stmt.bind(
      e.parent_item_id, e.child_item_id, e.parent_account_id,
      e.child_account_id, e.thread_id, e.created_at
    ));
    
    await this.db.batch(batch);
  }

  async getChunkingStats(): Promise<{ total_chunks: number; total_items: number; total_embeddings: number }> {
    const [chunksResult, itemsResult, embeddingsResult] = await Promise.all([
      this.db.prepare('SELECT COUNT(*) as count FROM chunks').first(),
      this.db.prepare('SELECT COUNT(*) as count FROM items').first(),
      // D1 embeddings count (might be 0 if using Vectorize)
      // We can't easily count Vectorize size via API here without listing.
      // Just return D1 count for now.
      this.db.prepare('SELECT COUNT(*) as count FROM embeddings_cache').first(),
    ]);
    
    return {
      total_chunks: (chunksResult?.count as number) || 0,
      total_items: (itemsResult?.count as number) || 0,
      total_embeddings: (embeddingsResult?.count as number) || 0,
    };
  }
}

// ============================================================================
// CHUNKING PIPELINE
// ============================================================================

const WATERMARK_CHUNKING = 'chunking_items';
const BATCH_SIZE = 100; // Process items in batches

export class ChunkingPipeline {
  constructor(
    private db: ChunkingDatabase,
    private embeddingProvider: EmbeddingProvider,
    private config: ChunkConfig
  ) {}

  /**
   * Run incremental chunking pipeline
   * - Fetches items since last watermark
   * - Builds all 3 chunk types
   * - Computes/caches embeddings
   * - Updates watermark atomically
   */
  async run(): Promise<ProcessingResult> {
    const result: ProcessingResult = {
      chunks_created: 0,
      chunks_updated: 0,
      embeddings_computed: 0,
      embeddings_cached: 0,
      items_processed: 0,
      errors: [],
    };

    try {
      // Get watermark
      const watermark = await this.db.getWatermark(WATERMARK_CHUNKING);
      const lastProcessedTs = watermark?.last_processed_ts || 0;
      
      console.log(`[Chunking] Starting from watermark: ${lastProcessedTs}`);

      // Fetch items since watermark
      const items = await this.db.getItemsSinceWatermark(lastProcessedTs, BATCH_SIZE);
      
      if (items.length === 0) {
        console.log('[Chunking] No new items to process');
        return result;
      }

      console.log(`[Chunking] Processing ${items.length} items`);
      result.items_processed = items.length;

      // Build all chunks
      const allChunks = await buildAllChunks(items, this.config);
      
      const allChunksList = [
        ...allChunks.accountTemporalChunks,
        ...allChunks.threadSessionChunks,
        ...allChunks.copresenceChunks,
      ];

      console.log(`[Chunking] Built ${allChunksList.length} chunks`);

      // Process embeddings and upsert chunks
      const skipLookups = this.config.skipChunkLookups === true;
      if (skipLookups) {
        result.chunks_created += allChunksList.length;
      } else {
        const maxEmbeddings = Number.isFinite(this.config.maxEmbeddingsPerRun)
          ? Math.max(0, this.config.maxEmbeddingsPerRun as number)
          : Infinity;
        let remainingEmbeddings = maxEmbeddings;
        let embeddingBudgetLogged = false;

        for (const chunk of allChunksList) {
          try {
            // Check if embedding already cached
            const cachedEmbedding = await this.db.getEmbedding(
              chunk.text_hash,
              this.embeddingProvider.model,
              this.embeddingProvider.version,
              this.embeddingProvider.name
            );

            if (cachedEmbedding) {
              chunk.embedding_id = cachedEmbedding.id;
              result.embeddings_cached++;
            } else if (chunk.aggregated_text) {
              if (remainingEmbeddings <= 0) {
                if (!embeddingBudgetLogged) {
                  console.log('[Chunking] Embedding budget reached, skipping remaining embeddings');
                  embeddingBudgetLogged = true;
                }
              } else {
                remainingEmbeddings -= 1;
                // Compute new embedding
                const embResult = await this.embeddingProvider.embed(chunk.aggregated_text);
                const embeddingId = await generateEmbeddingCacheId(
                  chunk.text_hash,
                  embResult.model,
                  embResult.version,
                  embResult.provider
                );

                const embeddingEntry: EmbeddingCacheEntry = {
                  id: embeddingId,
                  text_hash: chunk.text_hash,
                  embed_model: embResult.model,
                  embed_version: embResult.version,
                  provider_name: embResult.provider,
                  embedding_vector: embResult.vector,
                  dimensions: embResult.dimensions,
                  created_at: Date.now(),
                };

                await this.db.insertEmbedding(embeddingEntry);
                chunk.embedding_id = embeddingId;
                result.embeddings_computed++;
              }
            }

            // Check if chunk exists
            const existing = await this.db.getChunkByTextHash(chunk.text_hash, chunk.chunk_type);
            if (existing) {
              result.chunks_updated++;
            } else {
              result.chunks_created++;
            }

          } catch (err) {
            const message = String(err);
            if (message.includes('Too many API requests')) {
              remainingEmbeddings = 0;
              if (!embeddingBudgetLogged) {
                console.log('[Chunking] Embedding budget reached, skipping remaining embeddings');
                embeddingBudgetLogged = true;
              }
            }
            result.errors.push(`Chunk ${chunk.chunk_id}: ${err}`);
          }
        }
      }

      // Batch upsert chunks
      await this.db.upsertChunks(allChunksList);

      // Insert chunk items
      await this.db.insertChunkItems(allChunks.allChunkItems);

      // Insert copresence members
      await this.db.insertCopresenceMembers(allChunks.copresenceMembers);

      // Update watermark - use the max ingested_at from processed items
      const maxIngestedAt = Math.max(...items.map(i => i.ingested_at));
      const maxItem = items.find(i => i.ingested_at === maxIngestedAt);

      await this.db.setWatermark({
        watermark_name: WATERMARK_CHUNKING,
        last_processed_ts: maxIngestedAt,
        last_processed_id: maxItem?.id || null,
        updated_at: Date.now(),
      });

      console.log(`[Chunking] Complete. Created: ${result.chunks_created}, Updated: ${result.chunks_updated}, Embeddings: ${result.embeddings_computed} new, ${result.embeddings_cached} cached`);

    } catch (err) {
      result.errors.push(`Pipeline error: ${err}`);
      console.error('[Chunking] Pipeline error:', err);
    }

    return result;
  }
}
