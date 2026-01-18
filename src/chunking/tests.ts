/**
 * In-Worker Tests for Chunking Logic
 * Verifies deterministic ID generation, windowing logic, and copresence detection.
 */

import {
  buildAccountTemporalChunks,
  buildThreadSessionChunks,
  buildCopresenceChunks,
} from './chunk-builders';
import { generateChunkId, sha256 } from './text-processing';
import type { RawItem } from './types';

// Simple assertion helper
function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion Failed: ${message}`);
  }
}

// Fixture generator
function createItem(
  id: string,
  account: string,
  thread: string,
  hoursOffset: number,
  baseTime = 1700006400000 // 2023-11-15 00:00:00 UTC (Aligned to day)
): RawItem {
  return {
    id,
    item_type: 'post',
    account_id: account,
    thread_id: thread,
    parent_id: null,
    subreddit: 'test_sub',
    created_utc: (baseTime / 1000) + (hoursOffset * 3600), // Base time + offset
    title: 'Test',
    body: 'test content',
    score: 1,
    permalink: '/r/test',
    ingested_at: Date.now(),
    raw_json: '{}'
  };
}

export async function runChunkingTests() {
  const results = [];
  console.log('🧪 Starting Chunking Logic Tests...');

  try {
    // TEST 1: Deterministic ID Generation
    // ---------------------------------------------------------
    const id1 = await generateChunkId('TEST', 'acc1', null, 100, 200);
    const id2 = await generateChunkId('TEST', 'acc1', null, 100, 200);
    assert(id1 === id2, 'Chunk IDs must be deterministic');
    results.push('✅ Deterministic ID generation passed');


    // TEST 2: Account Temporal Windows (24h)
    // ---------------------------------------------------------
    // User posts at hour 0, hour 23, hour 25
    // Should result in 2 chunks (Window 1: 0-24, Window 2: 24-48)
    const itemsTemporal = [
      createItem('1', 'user1', 't1', 0),
      createItem('2', 'user1', 't1', 23),
      createItem('3', 'user1', 't1', 25)
    ];

    const tempResult = await buildAccountTemporalChunks(itemsTemporal, { windowMs: 24 * 3600 * 1000 });
    assert(tempResult.chunks.length === 2, `Expected 2 temporal chunks, got ${tempResult.chunks.length}`);
    assert(tempResult.chunks[0].item_count === 2, 'First chunk should have 2 items');
    assert(tempResult.chunks[1].item_count === 1, 'Second chunk should have 1 item');
    results.push('✅ Account Temporal Windows passed');


    // TEST 3: Thread Sessions (Inactivity Split)
    // ---------------------------------------------------------
    // User posts at hour 0, hour 1 (gap < 2h), hour 4 (gap = 3h)
    // Should result in 2 sessions
    const itemsSession = [
      createItem('4', 'user1', 't1', 0),
      createItem('5', 'user1', 't1', 1),
      createItem('6', 'user1', 't1', 4)
    ];

    const sessionResult = await buildThreadSessionChunks(itemsSession, { sessionGapMs: 2 * 3600 * 1000 });
    assert(sessionResult.chunks.length === 2, `Expected 2 session chunks, got ${sessionResult.chunks.length}`);
    assert(sessionResult.chunks[0].item_count === 2, 'First session should have 2 items');
    assert(sessionResult.chunks[1].item_count === 1, 'Second session should have 1 item');
    results.push('✅ Thread Session Splitting passed');


    // TEST 4: Copresence Windows
    // ---------------------------------------------------------
    // userA and userB post in same thread within 30 min window
    // userC posts 2 hours later (should not be in copresence chunk with A&B)
    const itemsCopresence = [
      createItem('7', 'userA', 'threadZ', 0),
      createItem('8', 'userB', 'threadZ', 0.2), // +12 mins
      createItem('9', 'userC', 'threadZ', 2)     // +2 hours
    ];

    const copResult = await buildCopresenceChunks(itemsCopresence, { windowMs: 30 * 60 * 1000, slideMs: 15 * 60 * 1000 });
    // Expect at least one chunk containing A & B. C shouldn't trigger a copresence chunk with them.
    // userC is alone in its window -> Copresence requires >=2 users, so C might generate 0 chunks if alone.
    
    // We expect 1 or 2 chunks covering the A+B overlap.
    const hasAB = copResult.members.some(m => m.account_id === 'userA') && copResult.members.some(m => m.account_id === 'userB');
    assert(hasAB, 'Should detect copresence of UserA and UserB');
    
    const hasC_with_others = copResult.chunks.some(c => {
        // Find chunk
        const members = copResult.members.filter(m => m.chunk_id === c.chunk_id);
        const hasC = members.some(m => m.account_id === 'userC');
        const count = members.length;
        return hasC && count > 1;
    });
    assert(!hasC_with_others, 'UserC should not be co-present with A or B');

    results.push('✅ Copresence Detection passed');

    console.log('🎉 All Chunking Tests Passed!');
    return { success: true, results };

  } catch (error) {
    console.error('💥 Test Failed:', error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
