import { db } from './database';

async function migrate() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS newsletters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      received_at DATETIME NOT NULL
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      newsletter_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      url TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      status TEXT NOT NULL DEFAULT 'unread',
      rating INTEGER,
      notes TEXT NOT NULL DEFAULT '',
      updated_at DATETIME,
      note_updated_at DATETIME,
      FOREIGN KEY (newsletter_id) REFERENCES newsletters (id)
    )
  `);

  // Idempotent column additions for databases that pre-date the annotation columns.
  // SQLite has no ADD COLUMN IF NOT EXISTS, so we suppress the duplicate-column error.
  const alterations = [
    `ALTER TABLE newsletters ADD COLUMN sender_email TEXT`,
    `ALTER TABLE articles ADD COLUMN status TEXT NOT NULL DEFAULT 'unread'`,
    `ALTER TABLE articles ADD COLUMN rating INTEGER`,
    `ALTER TABLE articles ADD COLUMN notes TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE articles ADD COLUMN updated_at DATETIME`,
    `ALTER TABLE articles ADD COLUMN note_updated_at DATETIME`,
    `ALTER TABLE articles ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE articles ADD COLUMN content_type TEXT NOT NULL DEFAULT 'newsletter'`,
    `ALTER TABLE articles ADD COLUMN saved INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE articles ADD COLUMN cached_content_url TEXT`,
    `ALTER TABLE articles ADD COLUMN cached_at DATETIME`,
    `ALTER TABLE articles ADD COLUMN ai_summary TEXT`,
    `ALTER TABLE articles ADD COLUMN pdf_type TEXT`,
    `ALTER TABLE articles ADD COLUMN processing_status TEXT NOT NULL DEFAULT 'done'`,
    `ALTER TABLE articles ADD COLUMN extract_ocr INTEGER NOT NULL DEFAULT 1`,
  ];
  for (const sql of alterations) {
    try {
      await db.execute(sql);
    } catch (e: any) {
      if (!String(e?.message).includes('duplicate column')) throw e;
    }
  }

  await db.execute(`
    CREATE TABLE IF NOT EXISTS email_tag_mappings (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      email      TEXT NOT NULL UNIQUE,
      tag        TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS article_ocr (
      article_id INTEGER PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
      ocr_text   TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.execute(`
    CREATE VIRTUAL TABLE IF NOT EXISTS article_ocr_fts
      USING fts5(ocr_text, content='article_ocr', content_rowid='article_id')
  `);

  await db.execute(`
    CREATE TRIGGER IF NOT EXISTS article_ocr_ai AFTER INSERT ON article_ocr BEGIN
      INSERT INTO article_ocr_fts(rowid, ocr_text) VALUES (new.article_id, new.ocr_text);
    END
  `);

  await db.execute(`
    CREATE TRIGGER IF NOT EXISTS article_ocr_ad AFTER DELETE ON article_ocr BEGIN
      DELETE FROM article_ocr_fts WHERE rowid = old.article_id;
    END
  `);

  await db.execute(`
    CREATE TRIGGER IF NOT EXISTS article_ocr_au AFTER UPDATE ON article_ocr BEGIN
      UPDATE article_ocr_fts SET ocr_text = new.ocr_text WHERE rowid = new.article_id;
    END
  `);

  console.log('Migration complete');
  process.exit(0);
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
