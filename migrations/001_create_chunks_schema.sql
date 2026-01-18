-- Reddit Tracker Chunking Schema
-- Migration: 001_create_chunks_schema.sql
-- Purpose: Add tables for segmentation-ready chunking for coordination research

-- Raw items table (posts/comments with full metadata for chunking)
CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,                        -- Reddit ID (e.g., t3_abc123)
    item_type TEXT NOT NULL,                    -- 'post' or 'comment'
    account_id TEXT NOT NULL,                   -- Reddit username (lowercased)
    thread_id TEXT NOT NULL,                    -- For posts: same as id. For comments: parent post id
    parent_id TEXT,                             -- For comments: parent comment id (nullable)
    subreddit TEXT NOT NULL,
    created_utc INTEGER NOT NULL,               -- Unix timestamp
    title TEXT,                                 -- For posts only
    body TEXT,                                  -- selftext for posts, body for comments
    score INTEGER DEFAULT 0,
    permalink TEXT,
    ingested_at INTEGER NOT NULL,               -- When we ingested this item
    raw_json TEXT                               -- Full JSON for future analysis
);

CREATE INDEX IF NOT EXISTS idx_items_account_created ON items(account_id, created_utc);
CREATE INDEX IF NOT EXISTS idx_items_thread_created ON items(thread_id, created_utc);
CREATE INDEX IF NOT EXISTS idx_items_created ON items(created_utc);
CREATE INDEX IF NOT EXISTS idx_items_ingested ON items(ingested_at);

-- Chunks table (3 chunk types)
CREATE TABLE IF NOT EXISTS chunks (
    chunk_id TEXT PRIMARY KEY,                  -- Deterministic ID based on chunk params
    chunk_type TEXT NOT NULL,                   -- 'ACCOUNT_TEMPORAL_WINDOW', 'THREAD_SESSION', 'COPRESENCE_WINDOW'
    start_ts INTEGER NOT NULL,                  -- Window start (unix timestamp)
    end_ts INTEGER NOT NULL,                    -- Window end (unix timestamp)
    account_id TEXT,                            -- Nullable for COPRESENCE_WINDOW
    thread_id TEXT,                             -- Nullable for ACCOUNT_TEMPORAL_WINDOW
    item_count INTEGER NOT NULL DEFAULT 0,
    aggregated_text TEXT,                       -- Deterministically ordered concatenation
    text_hash TEXT,                             -- SHA-256 of normalized aggregated text
    embedding_id TEXT,                          -- Reference to embeddings_cache
    chunk_metrics TEXT,                         -- JSON: lexical entropy, hedging, certainty, etc.
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chunks_type_start ON chunks(chunk_type, start_ts);
CREATE INDEX IF NOT EXISTS idx_chunks_account_start ON chunks(account_id, start_ts);
CREATE INDEX IF NOT EXISTS idx_chunks_thread_start ON chunks(thread_id, start_ts);
CREATE INDEX IF NOT EXISTS idx_chunks_text_hash ON chunks(text_hash);

-- Chunk items mapping (which items belong to which chunk)
CREATE TABLE IF NOT EXISTS chunk_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chunk_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    position INTEGER NOT NULL,                  -- Order within chunk
    UNIQUE(chunk_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_chunk_items_chunk ON chunk_items(chunk_id);
CREATE INDEX IF NOT EXISTS idx_chunk_items_item ON chunk_items(item_id);

-- Copresence members (for COPRESENCE_WINDOW chunks)
CREATE TABLE IF NOT EXISTS copresence_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chunk_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    first_seen_ts INTEGER NOT NULL,             -- First activity in this window
    item_count INTEGER NOT NULL DEFAULT 1,
    UNIQUE(chunk_id, account_id)
);

CREATE INDEX IF NOT EXISTS idx_copresence_chunk_account ON copresence_members(chunk_id, account_id);
CREATE INDEX IF NOT EXISTS idx_copresence_account ON copresence_members(account_id);

-- Embeddings cache (deduplicated by text_hash + model)
CREATE TABLE IF NOT EXISTS embeddings_cache (
    id TEXT PRIMARY KEY,                        -- hash of (text_hash, model, version, provider)
    text_hash TEXT NOT NULL,
    embed_model TEXT NOT NULL,
    embed_version TEXT NOT NULL,
    provider_name TEXT NOT NULL,
    embedding_vector TEXT NOT NULL,             -- JSON array of floats
    dimensions INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(text_hash, embed_model, embed_version, provider_name)
);

CREATE INDEX IF NOT EXISTS idx_embeddings_cache_lookup ON embeddings_cache(text_hash, embed_model, embed_version, provider_name);

-- Watermarks for incremental processing
CREATE TABLE IF NOT EXISTS watermarks (
    watermark_name TEXT PRIMARY KEY,            -- e.g., 'chunking_items', 'embedding_chunks'
    last_processed_ts INTEGER NOT NULL,         -- Unix timestamp of last processed item
    last_processed_id TEXT,                     -- ID of last processed item (for tie-breaking)
    updated_at INTEGER NOT NULL
);

-- Reply edges for graph reconstruction
CREATE TABLE IF NOT EXISTS reply_edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_item_id TEXT NOT NULL,
    child_item_id TEXT NOT NULL,
    parent_account_id TEXT NOT NULL,
    child_account_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,                -- When the reply was made
    UNIQUE(parent_item_id, child_item_id)
);

CREATE INDEX IF NOT EXISTS idx_reply_edges_parent ON reply_edges(parent_item_id);
CREATE INDEX IF NOT EXISTS idx_reply_edges_child ON reply_edges(child_item_id);
CREATE INDEX IF NOT EXISTS idx_reply_edges_thread ON reply_edges(thread_id);
CREATE INDEX IF NOT EXISTS idx_reply_edges_accounts ON reply_edges(parent_account_id, child_account_id);
