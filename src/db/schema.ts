import type { Schema } from './database.js'

export const MOXY_SCHEMA: Schema = {
  version: 1,
  statements: [
    `CREATE TABLE workers (
      id TEXT PRIMARY KEY,
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
    `CREATE INDEX worker_turns_running ON worker_turns (status) WHERE status = 'running'`,
    `CREATE TABLE leader (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      engine TEXT NOT NULL,
      model TEXT,
      effort TEXT,
      native_session_id TEXT
    ) STRICT`,
    `INSERT INTO leader (id, engine) VALUES (1, 'claude')`,
    `CREATE TABLE leader_turns (
      id INTEGER PRIMARY KEY,
      engine TEXT NOT NULL,
      model TEXT,
      effort TEXT,
      status TEXT NOT NULL CHECK (status IN ('running', 'finished', 'failed', 'interrupted')),
      output TEXT,
      error TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT
    ) STRICT`,
    `CREATE TABLE inbox (
      id INTEGER PRIMARY KEY,
      source TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK (kind IN ('user_message', 'worker_turn_ended')),
      body TEXT NOT NULL,
      received_at TEXT NOT NULL,
      leader_turn_id INTEGER REFERENCES leader_turns (id),
      interrupted_deliveries INTEGER NOT NULL DEFAULT 0
    ) STRICT`,
    `CREATE INDEX inbox_pending ON inbox (id) WHERE leader_turn_id IS NULL`,
  ],
}
