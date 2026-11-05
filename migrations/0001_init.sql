-- SustainIQ initial schema (PROJECT_PLAN §5.4). Every user-owned row carries owner_id (SECURITY §3.2).
-- owner_id = 'public' for curated papers. Timestamps are Unix epoch milliseconds.

CREATE TABLE papers (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL,
  title       TEXT NOT NULL,
  authors     TEXT,                       -- JSON array of names
  year        INTEGER,
  journal     TEXT,
  doi         TEXT,
  license     TEXT,
  source_url  TEXT,
  topic       TEXT,                       -- biopolymers | green-chemistry | packaging | biomaterials
  verified    INTEGER NOT NULL DEFAULT 0, -- 1 = curated and checked by a human
  pages       INTEGER,
  status      TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('processing', 'ready', 'failed')),
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER                     -- uploads only (7 days)
);
CREATE INDEX idx_papers_owner ON papers (owner_id);
CREATE UNIQUE INDEX idx_papers_owner_doi ON papers (owner_id, doi) WHERE doi IS NOT NULL; -- idempotent ingest
CREATE INDEX idx_papers_expires ON papers (expires_at) WHERE expires_at IS NOT NULL;

-- Parents (RAG §4.3): whole sections, stored but not embedded.
CREATE TABLE sections (
  id          TEXT PRIMARY KEY,
  paper_id    TEXT NOT NULL REFERENCES papers (id) ON DELETE CASCADE,
  idx         INTEGER NOT NULL,
  name        TEXT NOT NULL,
  text        TEXT NOT NULL,
  page_start  INTEGER NOT NULL,
  page_end    INTEGER NOT NULL
);
CREATE INDEX idx_sections_paper ON sections (paper_id, idx);

-- Children (RAG §4.3): embedded in Vectorize (vector id = chunks.id) and keyword-indexed in chunks_fts.
CREATE TABLE chunks (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT, -- integer rowid for FTS5 external content
  id          TEXT NOT NULL UNIQUE,
  paper_id    TEXT NOT NULL REFERENCES papers (id) ON DELETE CASCADE,
  section_id  TEXT NOT NULL REFERENCES sections (id) ON DELETE CASCADE,
  owner_id    TEXT NOT NULL,
  idx         INTEGER NOT NULL,
  text        TEXT NOT NULL,                     -- includes the contextual header (RAG §4.4)
  page_start  INTEGER NOT NULL,
  page_end    INTEGER NOT NULL
);
CREATE INDEX idx_chunks_paper ON chunks (paper_id, idx);
CREATE INDEX idx_chunks_owner ON chunks (owner_id);

-- BM25 keyword index. owner_id is deliberately NOT indexed here, so FTS column filters can't cross owners
-- (SECURITY §4.2); owner scoping happens on the joined chunks row.
CREATE VIRTUAL TABLE chunks_fts USING fts5 (text, content = 'chunks', content_rowid = 'seq', tokenize = 'porter unicode61');

CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts (rowid, text) VALUES (new.seq, new.text);
END;
CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts (chunks_fts, rowid, text) VALUES ('delete', old.seq, old.text);
END;
CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts (chunks_fts, rowid, text) VALUES ('delete', old.seq, old.text);
  INSERT INTO chunks_fts (rowid, text) VALUES (new.seq, new.text);
END;

CREATE TABLE chats (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL,
  title       TEXT NOT NULL DEFAULT 'New chat',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_chats_owner ON chats (owner_id, updated_at DESC);

CREATE TABLE messages (
  id              TEXT PRIMARY KEY,
  chat_id         TEXT NOT NULL REFERENCES chats (id) ON DELETE CASCADE,
  owner_id        TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content         TEXT NOT NULL,
  citations_json  TEXT,               -- [{ n, chunkId }] for assistant messages
  status          TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'unverified', 'declined', 'error')),
  model           TEXT,               -- which model wrote it (fallback chain)
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_messages_chat ON messages (chat_id, created_at);

-- Per-owner daily counters for quotas (SECURITY §8). Exact rate limits use the Rate Limiting binding / DOs (P8).
CREATE TABLE usage (
  owner_id    TEXT NOT NULL,
  day         TEXT NOT NULL,          -- YYYY-MM-DD (UTC)
  questions   INTEGER NOT NULL DEFAULT 0,
  uploads     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (owner_id, day)
);
