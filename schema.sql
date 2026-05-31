-- ============================================================
-- schema.sql  —  MarkdownOffice Daily Mailer (D1)
--
-- Apply locally:  wrangler d1 execute markdownoffice-mailer-db --file=schema.sql
-- Apply remotely: wrangler d1 execute markdownoffice-mailer-db --file=schema.sql --remote
-- ============================================================

-- ── Recipients ───────────────────────────────────────────────
-- Manage your mailing list here.
-- Soft-delete by setting active = 0 (preserves history).
CREATE TABLE IF NOT EXISTS recipients (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  name       TEXT,                            -- display name (optional)
  active     INTEGER NOT NULL DEFAULT 1,      -- 1 = subscribed, 0 = unsubscribed
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Seed default recipients — update these to real addresses
INSERT OR IGNORE INTO recipients (email, name) VALUES
  ('user1@gmail.com', 'User One'),
  ('user2@gmail.com', 'User Two');

-- ── Daily Content Rotation ───────────────────────────────────
-- 7-day cycle keyed by JavaScript's getUTCDay():
--   0 = Sunday, 1 = Monday, …, 6 = Saturday
--
-- When a row is missing, the Worker falls back to built-in defaults.
-- Edit rows here to customise each day's subject + message.
CREATE TABLE IF NOT EXISTS email_content (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  day_index  INTEGER NOT NULL UNIQUE CHECK (day_index BETWEEN 0 AND 6),
  subject    TEXT    NOT NULL,
  message    TEXT    NOT NULL,
  updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO email_content (day_index, subject, message) VALUES
  (0, 'Sunday Preview — MarkdownOffice',
      '☀️ A new week starts tomorrow. Review your upcoming tasks and set yourself up for a strong start!'),
  (1, 'Monday Update — MarkdownOffice',
      '🌅 Rise and shine! Check your pending documents, set your weekly goals, and hit the ground running.'),
  (2, 'Tuesday Update — MarkdownOffice',
      '📋 Tuesday check-in. Keep the momentum going — your documents are ready for your attention.'),
  (3, 'Wednesday Update — MarkdownOffice',
      '🚀 Mid-week momentum! You''re halfway there. Tackle those drafts and keep pushing forward.'),
  (4, 'Thursday Update — MarkdownOffice',
      '⚡ Thursday power-up. Wrap up your drafts, review pending feedback, and prep for the finish line.'),
  (5, 'Friday Wrap-up — MarkdownOffice',
      '🎉 Happy Friday! Tie up loose ends, ship what''s ready, and celebrate this week''s progress.'),
  (6, 'Weekend Edition — MarkdownOffice',
      '🌿 Weekend mode. A calm moment to reflect on the week''s wins and recharge for what''s next.');

-- ── Send Audit Log ────────────────────────────────────────────
-- Every send attempt (success or failure) is recorded here.
-- Query recent logs:
--   wrangler d1 execute markdownoffice-mailer-db --remote \
--     --command "SELECT * FROM send_log ORDER BY sent_at DESC LIMIT 20;"
CREATE TABLE IF NOT EXISTS send_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  sent_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  recipient_count INTEGER NOT NULL DEFAULT 0,
  status          TEXT    NOT NULL CHECK (status IN ('success', 'failure')),
  error_message   TEXT                            -- NULL on success
);

CREATE INDEX IF NOT EXISTS idx_send_log_sent_at
  ON send_log (sent_at DESC);

-- ── Useful queries ────────────────────────────────────────────

-- List all active recipients:
-- SELECT id, email, name FROM recipients WHERE active = 1;

-- Add a recipient:
-- INSERT INTO recipients (email, name) VALUES ('new@example.com', 'New User');

-- Unsubscribe a recipient (soft delete):
-- UPDATE recipients SET active = 0 WHERE email = 'old@example.com';

-- View last 10 send logs:
-- SELECT sent_at, status, recipient_count, error_message
--   FROM send_log ORDER BY sent_at DESC LIMIT 10;

-- Update Wednesday's message:
-- UPDATE email_content
--    SET message = 'Your updated Wednesday message!', updated_at = datetime('now')
--  WHERE day_index = 3;
