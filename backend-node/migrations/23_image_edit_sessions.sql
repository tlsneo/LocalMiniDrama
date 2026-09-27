CREATE TABLE IF NOT EXISTS image_edit_sessions (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS image_edit_sessions_updated ON image_edit_sessions(updated_at);
