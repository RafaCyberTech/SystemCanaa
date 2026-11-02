DROP TABLE IF EXISTS attendance;
DROP TABLE IF EXISTS members;
DROP TABLE IF EXISTS classes;
DROP TABLE IF EXISTS materials;
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS app_state;

CREATE TABLE app_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('secretary', 'member')),
  member_id TEXT,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT
);

CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  sender_user_id TEXT NOT NULL,
  from_role TEXT NOT NULL,
  from_name TEXT NOT NULL,
  target TEXT NOT NULL,
  recipient_member_id TEXT,
  recipient_name TEXT,
  subject TEXT,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE materials (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  quarter TEXT,
  type TEXT NOT NULL,
  url TEXT,
  has_file INTEGER NOT NULL DEFAULT 0,
  file_key TEXT,
  file_name TEXT,
  mime_type TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_sessions_expires ON sessions(expires_at);
CREATE INDEX idx_messages_created ON messages(created_at);
CREATE INDEX idx_materials_created ON materials(created_at);
