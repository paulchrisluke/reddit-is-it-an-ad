/**
 * Embedding Providers
 * Interface implementations for generating text embeddings
 */

import type { EmbeddingProvider, EmbeddingResult } from './types';
import { sha256 } from './text-processing';

// ============================================================================
// STUB EMBEDDING PROVIDER (Deterministic, no API required)
// ============================================================================

/**
 * Deterministic stub embedding provider
 * Generates consistent embeddings from text hashes - useful for:
 * 1. Testing without API keys
 * 2. Development/local runs
 * 3. Ensuring pipeline works before adding real embeddings
 * 
 * NOT suitable for production semantic analysis - use a real provider
 */
export class StubEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'stub';
  readonly model = 'hash-based';
  readonly version = '1.0.0';
  readonly dimensions = 384; // Common embedding dimension

  async embed(text: string): Promise<EmbeddingResult> {
    const vector = await this.generateDeterministicVector(text);
    return {
      vector,
      model: this.model,
      version: this.version,
      provider: this.name,
      dimensions: this.dimensions,
    };
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    return Promise.all(texts.map(t => this.embed(t)));
  }

  /**
   * Generate a deterministic vector from text hash
   * Uses hash bytes to seed a simple pseudo-random sequence
   */
  private async generateDeterministicVector(text: string): Promise<number[]> {
    const hash = await sha256(text);
    const vector: number[] = [];
    
    // Use hash to generate enough values
    // Each hex pair gives us one seed value
    for (let i = 0; i < this.dimensions; i++) {
      // Cycle through hash and combine bytes
      const idx1 = (i * 2) % hash.length;
      const idx2 = (i * 2 + 1) % hash.length;
      const hexPair = hash.substring(idx1, idx1 + 2);
      
      // Convert to float in [-1, 1] range
      const value = (parseInt(hexPair, 16) / 255) * 2 - 1;
      vector.push(Math.round(value * 10000) / 10000);
    }
    
    // Normalize to unit vector
    const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    if (magnitude > 0) {
      for (let i = 0; i < vector.length; i++) {
        vector[i] = Math.round((vector[i] / magnitude) * 10000) / 10000;
      }
    }
    
    return vector;
  }
}

// ============================================================================
// OPENAI EMBEDDING PROVIDER
// ============================================================================

interface OpenAIEmbeddingResponse {
  data: Array<{
    embedding: number[];
    index: number;
  }>;
  model: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

/**
 * OpenAI text-embedding-3-small provider
 * Requires OPENAI_API_KEY environment variable
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'openai';
  readonly model = 'text-embedding-3-small';
  readonly version = '2024-01';
  readonly dimensions = 1536;
  
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string, baseUrl = 'https://api.openai.com/v1') {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  async embed(text: string): Promise<EmbeddingResult> {
    const results = await this.embedBatch([text]);
    return results[0];
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${error}`);
    }

    const data = await response.json() as OpenAIEmbeddingResponse;
    
    // Sort by index to maintain order
    const sorted = [...data.data].sort((a, b) => a.index - b.index);
    
    return sorted.map(item => ({
      vector: item.embedding,
      model: this.model,
      version: this.version,
      provider: this.name,
      dimensions: item.embedding.length,
    }));
  }
}

// ============================================================================
// CLOUDFLARE WORKERS AI EMBEDDING PROVIDER
// ============================================================================

export class CloudflareAiEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'cloudflare-ai';
  // BAAI/bge-base-en-v1.5 is a strong, efficient model available in Workers AI
  readonly model = '@cf/baai/bge-base-en-v1.5';
  readonly version = 'v1.5';
  readonly dimensions = 768;
  
  private ai: any;

  constructor(ai: any) {
    this.ai = ai;
  }

  async embed(text: string): Promise<EmbeddingResult> {
    const results = await this.embedBatch([text]);
    return results[0];
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    // Workers AI run syntax
    const response = await this.ai.run(this.model, {
      text: texts
    });

    // Response shape: { data: [ [vector...], ... ], shape: [n, d] }?
    // Actually typically: { data: [ [0.1, ...], [0.2, ...] ] }
    
    // Safety check for response format
    const vectors = response.data || response;
    
    if (!Array.isArray(vectors)) {
        throw new Error(`Unexpected AI response format: ${JSON.stringify(response)}`);
    }

    return vectors.map((vector: number[]) => ({
      vector,
      model: this.model,
      version: this.version,
      provider: this.name,
      dimensions: vector.length,
    }));
  }
}

// ============================================================================
// PROVIDER FACTORY
// ============================================================================

export interface EmbeddingProviderConfig {
  provider: 'stub' | 'openai' | 'cloudflare';
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  aiBinding?: any;
}

/**
 * Create embedding provider based on configuration
 * Prioritizes Cloudflare AI if binding is present
 */
export function createEmbeddingProvider(config: EmbeddingProviderConfig): EmbeddingProvider {
  // 1. Cloudflare Workers AI (Preferred if available)
  if (config.provider === 'cloudflare' && config.aiBinding) {
    return new CloudflareAiEmbeddingProvider(config.aiBinding);
  }

  // 2. OpenAI
  if (config.provider === 'openai' && config.openaiApiKey) {
    return new OpenAIEmbeddingProvider(config.openaiApiKey, config.openaiBaseUrl);
  }
  
  // 3. Fallback Stub
  console.log('Using stub embedding provider (no AI binding or API key configured)');
  return new StubEmbeddingProvider();
}
