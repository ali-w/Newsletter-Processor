// Truncates all article and newsletter data from the database.
// Run via: npm run reset-data
// Requires TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in environment.

import { db } from './database';

async function reset() {
  console.log('Deleting articles (cascades to article_ocr and FTS index)...');
  await db.execute('DELETE FROM articles');

  console.log('Deleting newsletters...');
  await db.execute('DELETE FROM newsletters');

  // Rebuild FTS5 index to ensure it is clean after cascade deletes via triggers
  console.log('Rebuilding FTS5 index...');
  await db.execute("INSERT INTO article_ocr_fts(article_ocr_fts) VALUES('rebuild')");

  console.log('Database reset complete.');
  process.exit(0);
}

reset().catch(err => {
  console.error('Reset failed:', err);
  process.exit(1);
});
