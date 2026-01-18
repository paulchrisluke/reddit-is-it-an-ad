-- Add composite index for item_type + created_utc lookup
-- Migration: 004_add_items_type_created_index.sql

CREATE INDEX IF NOT EXISTS idx_items_type_created ON items(item_type, created_utc);
