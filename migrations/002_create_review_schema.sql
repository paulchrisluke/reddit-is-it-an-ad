-- Review & Labeling Schema
-- Migration: 002_create_review_schema.sql
-- Purpose: Add tables for review queue, labels, predictions, and feature snapshots

CREATE TABLE IF NOT EXISTS review_tasks (
    task_id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL,
    post_id TEXT,
    reason TEXT,
    priority REAL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    assigned_to TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_review_tasks_status_priority ON review_tasks(status, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_review_tasks_account ON review_tasks(account_id);
CREATE INDEX IF NOT EXISTS idx_review_tasks_post ON review_tasks(post_id);

CREATE TABLE IF NOT EXISTS review_labels (
    label_id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER,
    account_id TEXT NOT NULL,
    post_id TEXT,
    label TEXT NOT NULL,
    confidence REAL,
    notes TEXT,
    reviewer_id TEXT,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_review_labels_task ON review_labels(task_id);
CREATE INDEX IF NOT EXISTS idx_review_labels_account ON review_labels(account_id);
CREATE INDEX IF NOT EXISTS idx_review_labels_post ON review_labels(post_id);

CREATE TABLE IF NOT EXISTS review_predictions (
    prediction_id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL,
    post_id TEXT,
    model_version TEXT NOT NULL,
    score REAL NOT NULL,
    features_hash TEXT,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_review_predictions_account ON review_predictions(account_id);
CREATE INDEX IF NOT EXISTS idx_review_predictions_post ON review_predictions(post_id);

CREATE TABLE IF NOT EXISTS review_feature_snapshots (
    snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL,
    post_id TEXT,
    task_id INTEGER,
    features_hash TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_review_feature_account ON review_feature_snapshots(account_id);
CREATE INDEX IF NOT EXISTS idx_review_feature_task ON review_feature_snapshots(task_id);
