import type { Schema } from './database.js'

export const MOXY_SCHEMA: Schema = {
  version: 3,
  statements: [
    `CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      repo_root TEXT,
      plan TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      testing TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('working', 'done')),
      revision TEXT,
      how_to_try TEXT,
      superseded_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT`,
    `CREATE TABLE workers (
      id TEXT PRIMARY KEY,
      task_id TEXT REFERENCES tasks (id),
      title TEXT NOT NULL,
      engine TEXT NOT NULL,
      model TEXT,
      effort TEXT,
      folder TEXT NOT NULL,
      cwd TEXT NOT NULL,
      repo_root TEXT,
      branch TEXT,
      base TEXT,
      base_commit TEXT,
      native_session_id TEXT,
      created_at TEXT NOT NULL
    ) STRICT`,
    `CREATE TABLE worker_turns (
      worker_id TEXT NOT NULL REFERENCES workers (id),
      number INTEGER NOT NULL,
      model TEXT,
      effort TEXT,
      input TEXT NOT NULL,
      output TEXT,
      status TEXT NOT NULL CHECK (status IN ('running', 'finished', 'failed', 'stopped', 'interrupted')),
      error TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      PRIMARY KEY (worker_id, number)
    ) STRICT`,
    `CREATE TABLE integrations (
      id INTEGER PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks (id),
      worker_id TEXT NOT NULL REFERENCES workers (id),
      repo_root TEXT NOT NULL,
      branch TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running', 'merged', 'refused', 'interrupted')),
      revision TEXT,
      error TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT
    ) STRICT`,
    `CREATE INDEX worker_turns_running ON worker_turns (status) WHERE status = 'running'`,
    `CREATE TABLE leader (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      engine TEXT NOT NULL,
      model TEXT,
      effort TEXT,
      native_session_id TEXT,
      session_epoch INTEGER NOT NULL DEFAULT 0,
      session_chars INTEGER NOT NULL DEFAULT 0,
      session_turns INTEGER NOT NULL DEFAULT 0,
      context_used INTEGER,
      context_limit INTEGER
    ) STRICT`,
    `INSERT INTO leader (id, engine) VALUES (1, 'claude')`,
    `CREATE TABLE leader_turns (
      id INTEGER PRIMARY KEY,
      engine TEXT NOT NULL,
      model TEXT,
      effort TEXT,
      status TEXT NOT NULL CHECK (status IN ('running', 'finished', 'failed', 'stopped', 'interrupted')),
      output TEXT,
      error TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      retried_at TEXT,
      session_epoch INTEGER NOT NULL DEFAULT 0,
      recovery TEXT
    ) STRICT`,
    `CREATE TABLE inbox (
      id INTEGER PRIMARY KEY,
      source TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK (kind IN ('user_message', 'worker_turn_ended', 'follow_up')),
      body TEXT NOT NULL,
      received_at TEXT NOT NULL,
      leader_turn_id INTEGER REFERENCES leader_turns (id),
      interrupted_deliveries INTEGER NOT NULL DEFAULT 0
    ) STRICT`,
    `CREATE INDEX inbox_pending ON inbox (id) WHERE leader_turn_id IS NULL`,
    `CREATE TABLE follow_ups (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL UNIQUE,
      prompt TEXT NOT NULL,
      due_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'done', 'cancelled')),
      created_at TEXT NOT NULL,
      ended_at TEXT
    ) STRICT`,
    `CREATE INDEX follow_ups_due ON follow_ups (due_at) WHERE status = 'pending'`,
    `CREATE TABLE memory (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      instructions TEXT NOT NULL DEFAULT '',
      preferences TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    ) STRICT`,
    `INSERT INTO memory (id, updated_at) VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    `CREATE TABLE project_notes (
      repo_root TEXT PRIMARY KEY,
      body TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT`,
  ],
}
