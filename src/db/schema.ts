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
    `CREATE TABLE turns (
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
    `CREATE INDEX turns_running ON turns (status) WHERE status = 'running'`,
  ],
}
