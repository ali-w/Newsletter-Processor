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
  ];
  for (const sql of alterations) {
    try {
      await db.execute(sql);
    } catch (e: any) {
      if (!String(e?.message).includes('duplicate column')) throw e;
    }
  }

  console.log('Migration complete');
  process.exit(0);
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
