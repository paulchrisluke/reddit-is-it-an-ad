/**
 * Text Processing Utilities
 * Deterministic text normalization, hashing, and metric extraction
 */

import type { ChunkMetrics, RawItem } from './types';

// ============================================================================
// TEXT NORMALIZATION
// ============================================================================

/**
 * Normalize text for consistent hashing and embedding
 * - Lowercase
 * - Collapse whitespace
 * - Remove Reddit markdown artifacts
 * - Trim
 */
export function normalizeText(text: string | null | undefined): string {
  if (!text) return '';
  
  return text
    .toLowerCase()
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\[deleted\]/gi, '')
    .replace(/\[removed\]/gi, '')
    .replace(/https?:\/\/\S+/gi, '[URL]')  // Normalize URLs
    .replace(/u\/\w+/gi, '[USER]')          // Normalize user mentions
    .replace(/r\/\w+/gi, '[SUBREDDIT]')     // Normalize subreddit mentions
    .trim();
}

/**
 * Aggregate text from multiple items in deterministic order
 * Orders by created_utc ASC, then by item_id ASC for tie-breaking
 */
export function aggregateItemTexts(items: RawItem[]): string {
  // Sort deterministically
  const sorted = [...items].sort((a, b) => {
    if (a.created_utc !== b.created_utc) {
      return a.created_utc - b.created_utc;
    }
    return a.id.localeCompare(b.id);
  });
  
  // Combine text content
  const texts: string[] = [];
  for (const item of sorted) {
    const content = item.item_type === 'post'
      ? [item.title, item.body].filter(Boolean).join(' ')
      : item.body || '';
    
    const normalized = normalizeText(content);
    if (normalized) {
      texts.push(normalized);
    }
  }
  
  return texts.join(' [SEP] ');
}

// ============================================================================
// HASHING
// ============================================================================

/**
 * Compute SHA-256 hash of text
 * Uses Web Crypto API (available in Workers)
 */
export async function sha256(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Generate deterministic chunk ID
 */
export async function generateChunkId(
  chunkType: string,
  accountId: string | null,
  threadId: string | null,
  startTs: number,
  endTs: number
): Promise<string> {
  const components = [
    chunkType,
    accountId || 'null',
    threadId || 'null',
    startTs.toString(),
    endTs.toString()
  ].join('|');
  
  const hash = await sha256(components);
  return `chunk_${hash.substring(0, 16)}`;
}

/**
 * Generate embedding cache ID
 */
export async function generateEmbeddingCacheId(
  textHash: string,
  model: string,
  version: string,
  provider: string
): Promise<string> {
  const components = [textHash, model, version, provider].join('|');
  const hash = await sha256(components);
  return `emb_${hash.substring(0, 24)}`;
}

// ============================================================================
// METRIC EXTRACTION
// ============================================================================

// Hedging words/phrases
const HEDGING_PATTERNS = [
  /\bmaybe\b/gi,
  /\bperhaps\b/gi,
  /\bseems?\b/gi,
  /\bmight\b/gi,
  /\bcould be\b/gi,
  /\bpossibly\b/gi,
  /\bprobably\b/gi,
  /\bi think\b/gi,
  /\bi guess\b/gi,
  /\bi believe\b/gi,
  /\bappears? to\b/gi,
  /\bsomewhat\b/gi,
  /\bsort of\b/gi,
  /\bkind of\b/gi,
];

// Certainty/assertiveness markers
const CERTAINTY_PATTERNS = [
  /\bobviously\b/gi,
  /\bclearly\b/gi,
  /\bdefinitely\b/gi,
  /\babsolutely\b/gi,
  /\bwithout a doubt\b/gi,
  /\beveryone knows\b/gi,
  /\bit'?s? obvious\b/gi,
  /\bno question\b/gi,
  /\bundoubtedly\b/gi,
  /\bcertainly\b/gi,
  /\bof course\b/gi,
  /\bneedless to say\b/gi,
  /\bfact is\b/gi,
  /\bthe truth is\b/gi,
];

// Imperative patterns
const IMPERATIVE_PATTERNS = [
  /\byou should\b/gi,
  /\byou must\b/gi,
  /\byou need to\b/gi,
  /\byou have to\b/gi,
  /\bstop \w+ing\b/gi,
  /\bwake up\b/gi,
  /\bopen your eyes\b/gi,
  /\bdo your research\b/gi,
  /\bthink about\b/gi,
  /\bconsider\b/gi,
  /\bjust look at\b/gi,
  /\bdon'?t be\b/gi,
];

/**
 * Count pattern matches in text
 */
function countPatternMatches(text: string, patterns: RegExp[]): number {
  let count = 0;
  for (const pattern of patterns) {
    const matches = text.match(pattern);
    if (matches) {
      count += matches.length;
    }
  }
  return count;
}

/**
 * Simple tokenization for metric computation
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 0);
}

/**
 * Extract chunk metrics from aggregated text
 */
export function extractChunkMetrics(text: string): ChunkMetrics {
  if (!text) {
    return {
      unique_tokens: 0,
      total_tokens: 0,
      lexical_entropy: 0,
      hedging_count: 0,
      certainty_count: 0,
      imperative_count: 0,
      question_count: 0,
      char_count: 0,
      sentence_count: 0,
      avg_word_length: 0,
    };
  }

  const tokens = tokenize(text);
  const uniqueTokens = new Set(tokens);
  
  // Count sentences (rough approximation)
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
  
  // Count questions
  const questionCount = (text.match(/\?/g) || []).length;
  
  // Calculate average word length
  const totalWordLength = tokens.reduce((sum, t) => sum + t.length, 0);
  const avgWordLength = tokens.length > 0 ? totalWordLength / tokens.length : 0;
  
  // Lexical entropy proxy (simple unique/total ratio)
  const lexicalEntropy = tokens.length > 0 
    ? uniqueTokens.size / tokens.length 
    : 0;

  return {
    unique_tokens: uniqueTokens.size,
    total_tokens: tokens.length,
    lexical_entropy: Math.round(lexicalEntropy * 1000) / 1000,
    hedging_count: countPatternMatches(text, HEDGING_PATTERNS),
    certainty_count: countPatternMatches(text, CERTAINTY_PATTERNS),
    imperative_count: countPatternMatches(text, IMPERATIVE_PATTERNS),
    question_count: questionCount,
    char_count: text.length,
    sentence_count: sentences.length,
    avg_word_length: Math.round(avgWordLength * 100) / 100,
  };
}
