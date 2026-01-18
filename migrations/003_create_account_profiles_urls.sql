-- Account profile snapshots and URL tracking
-- Migration: 003_create_account_profiles_urls.sql

CREATE TABLE IF NOT EXISTS account_profile_snapshots (
    snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL,
    snapshot_ts INTEGER NOT NULL,
    created_utc INTEGER,
    link_karma INTEGER,
    comment_karma INTEGER,
    is_mod INTEGER,
    is_gold INTEGER,
    has_verified_email INTEGER
);

CREATE INDEX IF NOT EXISTS idx_profile_snapshots_account ON account_profile_snapshots(account_id);
CREATE INDEX IF NOT EXISTS idx_profile_snapshots_time ON account_profile_snapshots(snapshot_ts);

CREATE TABLE IF NOT EXISTS account_urls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL,
    post_id TEXT NOT NULL,
    url TEXT NOT NULL,
    domain TEXT,
    created_utc INTEGER,
    ingested_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_account_urls_unique ON account_urls(account_id, post_id, url);
CREATE INDEX IF NOT EXISTS idx_account_urls_account ON account_urls(account_id);
CREATE INDEX IF NOT EXISTS idx_account_urls_domain ON account_urls(domain);
CREATE INDEX IF NOT EXISTS idx_account_urls_created ON account_urls(created_utc);
