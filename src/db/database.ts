import { createClient } from '@libsql/client/web';
import { config } from '../config';
import { logger } from '../logger';

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
  status?: 'unread' | 'read' | 'skipped';
  rating?: number | null;
  notes?: string;
  updated_at?: string | null;
  note_updated_at?: string | null;
}

export interface ArticlePatch {
  status?: 'unread' | 'read' | 'skipped';
  rating?: number | null;
  notes?: string;
}

export interface Newsletter {
  id?: number;
  name: string;
  received_at: string;
}

// initDb is a no-op at runtime — schema is applied by `npm run migrate` (src/db/migrate.ts)
// before each deployment. Kept here so local `npm run dev` still has a hook to call.
export async function initDb() {
  logger.info('Database ready');
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
      SELECT
        a.id,
        a.newsletter_id,
        a.title,
        a.summary,
        a.url,
        a.created_at as article_created_at,
        a.status,
        a.rating,
        a.notes,
        a.updated_at,
        a.note_updated_at,
        n.name as newsletter_name,
        n.received_at
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

// Returns the updated_at timestamp on success, or null if the article was not found.
export async function updateArticle(id: number, patch: ArticlePatch): Promise<string | null> {
  const check = await db.execute({ sql: `SELECT id FROM articles WHERE id = ?`, args: [id] });
  if (check.rows.length === 0) return null;

  const now = new Date().toISOString();
  const sets: string[] = ['updated_at = ?'];
  const args: (string | number | null)[] = [now];

  if (patch.status !== undefined) {
    sets.push('status = ?');
    args.push(patch.status);
  }
  if ('rating' in patch) {
    sets.push('rating = ?');
    args.push(patch.rating ?? null);
  }
  if (patch.notes !== undefined) {
    sets.push('notes = ?');
    args.push(patch.notes);
    sets.push('note_updated_at = ?');
    args.push(now);
  }

  args.push(id);
  await db.execute({ sql: `UPDATE articles SET ${sets.join(', ')} WHERE id = ?`, args });
  return now;
}

export async function updateArticles(
  updates: Array<{ id: number } & ArticlePatch>
): Promise<{ succeeded: number[]; failed: Array<{ id: number; error: string }> }> {
  const succeeded: number[] = [];
  const failed: Array<{ id: number; error: string }> = [];

  for (const { id, ...patch } of updates) {
    try {
      const result = await updateArticle(id, patch);
      if (result === null) {
        failed.push({ id, error: 'Article not found' });
      } else {
        succeeded.push(id);
      }
    } catch {
      failed.push({ id, error: 'Update failed' });
    }
  }

  return { succeeded, failed };
}
