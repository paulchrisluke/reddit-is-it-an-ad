/**
 * Chunk Builders
 * Implements the three chunk types for segmentation-ready analysis
 */

import type {
  RawItem,
  Chunk,
  ChunkItem,
  CopresenceMember,
  ChunkConfig,
  ChunkMetrics,
  DEFAULT_CHUNK_CONFIG,
} from './types';
import {
  aggregateItemTexts,
  sha256,
  generateChunkId,
  extractChunkMetrics,
} from './text-processing';

// ============================================================================
// ACCOUNT TEMPORAL WINDOW CHUNKS
// ============================================================================

/**
 * Build ACCOUNT_TEMPORAL_WINDOW chunks
 * Groups all activity by a single account into fixed time windows (default 24h)
 * 
 * This captures:
 * - Daily behavioral patterns per account
 * - Longitudinal changes in an account's output
 * - Volume/intensity variations over time
 */
export async function buildAccountTemporalChunks(
  items: RawItem[],
  config: { windowMs: number } = { windowMs: 24 * 60 * 60 * 1000 }
): Promise<{ chunks: Chunk[]; chunkItems: ChunkItem[] }> {
  const chunks: Chunk[] = [];
  const chunkItems: ChunkItem[] = [];
  
  // Group items by account
  const byAccount = new Map<string, RawItem[]>();
  for (const item of items) {
    const existing = byAccount.get(item.account_id) || [];
    existing.push(item);
    byAccount.set(item.account_id, existing);
  }
  
  const now = Date.now();
  
  for (const [accountId, accountItems] of byAccount) {
    // Sort by time
    accountItems.sort((a, b) => a.created_utc - b.created_utc);
    
    if (accountItems.length === 0) continue;
    
    // Find time range
    const minTs = accountItems[0].created_utc * 1000;
    const maxTs = accountItems[accountItems.length - 1].created_utc * 1000;
    
    // Create windows
    const windowStartBase = Math.floor(minTs / config.windowMs) * config.windowMs;
    
    for (let windowStart = windowStartBase; windowStart <= maxTs; windowStart += config.windowMs) {
      const windowEnd = windowStart + config.windowMs;
      
      // Get items in this window
      const windowItems = accountItems.filter(item => {
        const ts = item.created_utc * 1000;
        return ts >= windowStart && ts < windowEnd;
      });
      
      if (windowItems.length === 0) continue;
      
      // Build chunk
      const chunkId = await generateChunkId(
        'ACCOUNT_TEMPORAL_WINDOW',
        accountId,
        null,
        windowStart,
        windowEnd
      );
      
      const aggregatedText = aggregateItemTexts(windowItems);
      const textHash = await sha256(aggregatedText);
      const metrics = extractChunkMetrics(aggregatedText);
      
      chunks.push({
        chunk_id: chunkId,
        chunk_type: 'ACCOUNT_TEMPORAL_WINDOW',
        start_ts: windowStart,
        end_ts: windowEnd,
        account_id: accountId,
        thread_id: null,
        item_count: windowItems.length,
        aggregated_text: aggregatedText,
        text_hash: textHash,
        embedding_id: null,
        chunk_metrics: metrics,
        created_at: now,
        updated_at: now,
      });
      
      // Record item mappings
      windowItems.forEach((item, idx) => {
        chunkItems.push({
          chunk_id: chunkId,
          item_id: item.id,
          position: idx,
        });
      });
    }
  }
  
  return { chunks, chunkItems };
}

// ============================================================================
// THREAD SESSION CHUNKS
// ============================================================================

/**
 * Build THREAD_SESSION chunks
 * Groups activity by account within a thread, split by inactivity gaps
 * 
 * This captures:
 * - Engagement patterns within conversations
 * - Topic-specific behavioral modes
 * - Persistence and engagement depth per thread
 */
export async function buildThreadSessionChunks(
  items: RawItem[],
  config: { sessionGapMs: number } = { sessionGapMs: 2 * 60 * 60 * 1000 }
): Promise<{ chunks: Chunk[]; chunkItems: ChunkItem[] }> {
  const chunks: Chunk[] = [];
  const chunkItems: ChunkItem[] = [];
  
  // Group by (account, thread)
  const byAccountThread = new Map<string, RawItem[]>();
  for (const item of items) {
    const key = `${item.account_id}|${item.thread_id}`;
    const existing = byAccountThread.get(key) || [];
    existing.push(item);
    byAccountThread.set(key, existing);
  }
  
  const now = Date.now();
  
  for (const [key, accountThreadItems] of byAccountThread) {
    const [accountId, threadId] = key.split('|');
    
    // Sort by time
    accountThreadItems.sort((a, b) => a.created_utc - b.created_utc);
    
    // Split into sessions based on inactivity gap
    const sessions: RawItem[][] = [];
    let currentSession: RawItem[] = [];
    let lastTs = 0;
    
    for (const item of accountThreadItems) {
      const itemTs = item.created_utc * 1000;
      
      if (currentSession.length > 0 && (itemTs - lastTs) > config.sessionGapMs) {
        // Gap detected, start new session
        sessions.push(currentSession);
        currentSession = [];
      }
      
      currentSession.push(item);
      lastTs = itemTs;
    }
    
    if (currentSession.length > 0) {
      sessions.push(currentSession);
    }
    
    // Create chunks for each session
    for (const sessionItems of sessions) {
      if (sessionItems.length === 0) continue;
      
      const startTs = sessionItems[0].created_utc * 1000;
      const endTs = sessionItems[sessionItems.length - 1].created_utc * 1000;
      
      const chunkId = await generateChunkId(
        'THREAD_SESSION',
        accountId,
        threadId,
        startTs,
        endTs
      );
      
      const aggregatedText = aggregateItemTexts(sessionItems);
      const textHash = await sha256(aggregatedText);
      const metrics = extractChunkMetrics(aggregatedText);
      
      chunks.push({
        chunk_id: chunkId,
        chunk_type: 'THREAD_SESSION',
        start_ts: startTs,
        end_ts: endTs,
        account_id: accountId,
        thread_id: threadId,
        item_count: sessionItems.length,
        aggregated_text: aggregatedText,
        text_hash: textHash,
        embedding_id: null,
        chunk_metrics: metrics,
        created_at: now,
        updated_at: now,
      });
      
      sessionItems.forEach((item, idx) => {
        chunkItems.push({
          chunk_id: chunkId,
          item_id: item.id,
          position: idx,
        });
      });
    }
  }
  
  return { chunks, chunkItems };
}

// ============================================================================
// COPRESENCE WINDOW CHUNKS
// ============================================================================

/**
 * Build COPRESENCE_WINDOW chunks
 * Sliding windows over threads capturing which accounts are co-active
 * 
 * This captures:
 * - Coordination patterns (who appears together)
 * - Temporal alignment of activity
 * - Community structure within threads
 */
export async function buildCopresenceChunks(
  items: RawItem[],
  config: { windowMs: number; slideMs: number } = { windowMs: 30 * 60 * 1000, slideMs: 15 * 60 * 1000 }
): Promise<{ chunks: Chunk[]; chunkItems: ChunkItem[]; members: CopresenceMember[] }> {
  const chunks: Chunk[] = [];
  const chunkItems: ChunkItem[] = [];
  const members: CopresenceMember[] = [];
  
  // Group by thread
  const byThread = new Map<string, RawItem[]>();
  for (const item of items) {
    const existing = byThread.get(item.thread_id) || [];
    existing.push(item);
    byThread.set(item.thread_id, existing);
  }
  
  const now = Date.now();
  
  for (const [threadId, threadItems] of byThread) {
    if (threadItems.length < 2) continue; // Need at least 2 items for copresence
    
    // Sort by time
    threadItems.sort((a, b) => a.created_utc - b.created_utc);
    
    const minTs = threadItems[0].created_utc * 1000;
    const maxTs = threadItems[threadItems.length - 1].created_utc * 1000;
    
    // Sliding window
    for (let windowStart = minTs; windowStart <= maxTs; windowStart += config.slideMs) {
      const windowEnd = windowStart + config.windowMs;
      
      // Get items in window
      const windowItems = threadItems.filter(item => {
        const ts = item.created_utc * 1000;
        return ts >= windowStart && ts < windowEnd;
      });
      
      // Check if we have multiple accounts
      const accountsInWindow = new Set(windowItems.map(i => i.account_id));
      if (accountsInWindow.size < 2) continue; // Skip single-account windows
      
      const chunkId = await generateChunkId(
        'COPRESENCE_WINDOW',
        null,
        threadId,
        windowStart,
        windowEnd
      );
      
      const aggregatedText = aggregateItemTexts(windowItems);
      const textHash = await sha256(aggregatedText);
      const metrics = extractChunkMetrics(aggregatedText);
      
      chunks.push({
        chunk_id: chunkId,
        chunk_type: 'COPRESENCE_WINDOW',
        start_ts: windowStart,
        end_ts: windowEnd,
        account_id: null,
        thread_id: threadId,
        item_count: windowItems.length,
        aggregated_text: aggregatedText,
        text_hash: textHash,
        embedding_id: null,
        chunk_metrics: metrics,
        created_at: now,
        updated_at: now,
      });
      
      // Record item mappings
      windowItems.forEach((item, idx) => {
        chunkItems.push({
          chunk_id: chunkId,
          item_id: item.id,
          position: idx,
        });
      });
      
      // Record copresence members
      const accountStats = new Map<string, { firstSeen: number; count: number }>();
      for (const item of windowItems) {
        const existing = accountStats.get(item.account_id);
        if (existing) {
          existing.count++;
        } else {
          accountStats.set(item.account_id, {
            firstSeen: item.created_utc * 1000,
            count: 1,
          });
        }
      }
      
      for (const [accountId, stats] of accountStats) {
        members.push({
          chunk_id: chunkId,
          account_id: accountId,
          first_seen_ts: stats.firstSeen,
          item_count: stats.count,
        });
      }
    }
  }
  
  return { chunks, chunkItems, members };
}

// ============================================================================
// COMBINED CHUNK BUILDER
// ============================================================================

export interface AllChunksResult {
  accountTemporalChunks: Chunk[];
  threadSessionChunks: Chunk[];
  copresenceChunks: Chunk[];
  allChunkItems: ChunkItem[];
  copresenceMembers: CopresenceMember[];
}

/**
 * Build all three chunk types from a set of items
 */
export async function buildAllChunks(
  items: RawItem[],
  config: ChunkConfig
): Promise<AllChunksResult> {
  const [
    accountTemporal,
    threadSession,
    copresence,
  ] = await Promise.all([
    buildAccountTemporalChunks(items, { windowMs: config.temporalWindowMs }),
    buildThreadSessionChunks(items, { sessionGapMs: config.sessionGapMs }),
    buildCopresenceChunks(items, { windowMs: config.copresenceWindowMs, slideMs: config.copresenceSlideMs }),
  ]);
  
  return {
    accountTemporalChunks: accountTemporal.chunks,
    threadSessionChunks: threadSession.chunks,
    copresenceChunks: copresence.chunks,
    allChunkItems: [
      ...accountTemporal.chunkItems,
      ...threadSession.chunkItems,
      ...copresence.chunkItems,
    ],
    copresenceMembers: copresence.members,
  };
}
