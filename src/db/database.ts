import { createClient } from '@libsql/client/web';
import { config } from '../config';

export const db = createClient({
  url: config.TURSO_DATABASE_URL,
  authToken: config.TURSO_AUTH_TOKEN,
});

export interface Article {
  id?: number;
  newsletter_id?: number;
  title: string;
  summary: string;
  url: string;
  created_at?: string;
}

export interface Newsletter {
  id?: number;
  name: string;
  received_at: string;
}

export async function initDb() {
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
      FOREIGN KEY (newsletter_id) REFERENCES newsletters (id)
    )
  `);
  console.log('✅ Database tables initialized');
}

export async function insertNewsletter(name: string, receivedAt: Date): Promise<number> {
  const result = await db.execute({
    sql: `INSERT INTO newsletters (name, received_at) VALUES (?, ?)`,
    args: [name, receivedAt.toISOString()]
  });
  return Number(result.lastInsertRowid);
}

export async function insertArticle(newsletterId: number, article: Article) {
  await db.execute({
    sql: `INSERT INTO articles (newsletter_id, title, summary, url) VALUES (?, ?, ?, ?)`,
    args: [newsletterId, article.title, article.summary, article.url]
  });
}

export async function getLatestArticles(limit: number) {
  const result = await db.execute({
    sql: `
      SELECT a.id, a.title, a.summary, a.url, n.received_at, n.name as newsletter_name 
      FROM articles a
      JOIN newsletters n ON a.newsletter_id = n.id
      ORDER BY n.received_at DESC, a.id ASC
      LIMIT ?
    `,
    args: [limit]
  });
  return result.rows;
}

export async function getArticleById(id: number): Promise<Article | null> {
  const result = await db.execute({
    sql: `SELECT id, newsletter_id, title, summary, url, created_at FROM articles WHERE id = ?`,
    args: [id]
  });

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  return {
    id: Number(row.id),
    newsletter_id: Number(row.newsletter_id),
    title: String(row.title),
    summary: String(row.summary),
    url: String(row.url),
    created_at: String(row.created_at),
  };
}
