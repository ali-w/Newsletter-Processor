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
  status?: 'unread' | 'read' | 'skipped' | 'later';
  rating?: number | null;
  notes?: string;
  updated_at?: string | null;
  note_updated_at?: string | null;
  tags?: string[];
  content_type?: string;
  saved?: boolean;
  cached_content_url?: string | null;
  cached_at?: string | null;
  ai_summary?: string | null;
  pdf_type?: 'typed' | 'handwritten' | null;
  processing_status?: 'pending' | 'processing' | 'done' | 'error';
  extract_ocr?: boolean;
}

export interface ArticleRow extends Omit<Article, 'id'> {
  id: number;
  newsletter_name: string;
  received_at: string;
}

export interface ArticlePatch {
  title?: string;
  status?: 'unread' | 'read' | 'skipped' | 'later';
  rating?: number | null;
  notes?: string;
  tags?: string[];
  saved?: boolean;
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

export async function getLatestArticles(limit: number, updatedSince?: string) {
  const whereClause = updatedSince
    ? `WHERE COALESCE(a.updated_at, a.created_at) > ?`
    : '';
  const args: (number | string)[] = updatedSince ? [updatedSince, limit] : [limit];
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
        a.tags,
        a.content_type,
        a.saved,
        a.cached_content_url,
        a.cached_at,
        a.ai_summary,
        a.pdf_type,
        a.processing_status,
        n.name as newsletter_name,
        n.received_at
      FROM articles a
      JOIN newsletters n ON a.newsletter_id = n.id
      ${whereClause}
      ORDER BY COALESCE(a.updated_at, a.created_at) DESC, a.id DESC
      LIMIT ?
    `,
    args
  });
  return result.rows.map(row => ({
    ...(row as Record<string, unknown>),
    tags: JSON.parse(String(row.tags ?? '[]')),
    saved: Boolean(row.saved),
    pdf_type: row.pdf_type != null ? String(row.pdf_type) : null,
    processing_status: row.processing_status != null ? String(row.processing_status) : 'done',
  })) as ArticleRow[];
}

export async function getArticleById(id: number): Promise<Article | null> {
  const result = await db.execute({
    sql: `SELECT id, newsletter_id, title, summary, url, created_at, notes, tags, content_type, cached_content_url, cached_at, ai_summary, pdf_type, processing_status, extract_ocr FROM articles WHERE id = ?`,
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
    notes: row.notes != null ? String(row.notes) : undefined,
    tags: JSON.parse(String(row.tags ?? '[]')),
    content_type: row.content_type != null ? String(row.content_type) : undefined,
    cached_content_url: row.cached_content_url != null ? String(row.cached_content_url) : null,
    cached_at: row.cached_at != null ? String(row.cached_at) : null,
    ai_summary: row.ai_summary != null ? String(row.ai_summary) : null,
    pdf_type: row.pdf_type != null ? (String(row.pdf_type) as 'typed' | 'handwritten') : null,
    processing_status: row.processing_status != null ? (String(row.processing_status) as 'pending' | 'processing' | 'done' | 'error') : 'done',
    extract_ocr: row.extract_ocr != null ? Boolean(row.extract_ocr) : true,
  };
}

// Returns the updated_at timestamp on success, or null if the article was not found.
export async function updateArticle(id: number, patch: ArticlePatch): Promise<string | null> {
  const check = await db.execute({ sql: `SELECT id FROM articles WHERE id = ?`, args: [id] });
  if (check.rows.length === 0) return null;

  const now = new Date().toISOString();
  const sets: string[] = ['updated_at = ?'];
  const args: (string | number | null)[] = [now];

  if (patch.title !== undefined) {
    sets.push('title = ?');
    args.push(patch.title);
  }
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
  if ('tags' in patch) {
    sets.push('tags = ?');
    args.push(JSON.stringify(patch.tags ?? []));
  }
  if ('saved' in patch) {
    sets.push('saved = ?');
    args.push(patch.saved ? 1 : 0);
  }
  args.push(id);
  await db.execute({ sql: `UPDATE articles SET ${sets.join(', ')} WHERE id = ?`, args });
  return now;
}

async function getOrCreateManualNewsletter(): Promise<number> {
  const existing = await db.execute({
    sql: `SELECT id FROM newsletters WHERE name = 'Manual' LIMIT 1`,
    args: [],
  });
  if (existing.rows.length > 0) return Number(existing.rows[0].id);
  const result = await db.execute({
    sql: `INSERT INTO newsletters (name, received_at) VALUES ('Manual', ?)`,
    args: [new Date().toISOString()],
  });
  return Number(result.lastInsertRowid);
}

export async function createManualArticle(data: {
  title: string;
  url: string;
  summary?: string;
  tags?: string[];
  content_type?: string;
  saved?: boolean;
  pdf_type?: 'typed' | 'handwritten';
  processing_status?: 'pending' | 'processing' | 'done' | 'error';
  extract_ocr?: boolean;
}): Promise<Article> {
  const newsletterId = await getOrCreateManualNewsletter();
  const now = new Date().toISOString();
  const result = await db.execute({
    sql: `INSERT INTO articles (newsletter_id, title, summary, url, tags, content_type, saved, created_at, pdf_type, processing_status, extract_ocr)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      newsletterId,
      data.title,
      data.summary ?? '',
      data.url,
      JSON.stringify(data.tags ?? []),
      data.content_type ?? 'newsletter',
      data.saved ? 1 : 0,
      now,
      data.pdf_type ?? null,
      data.processing_status ?? 'done',
      data.extract_ocr !== false ? 1 : 0,
    ],
  });
  return {
    id: Number(result.lastInsertRowid),
    newsletter_id: newsletterId,
    title: data.title,
    summary: data.summary ?? '',
    url: data.url,
    created_at: now,
    status: 'unread',
    tags: data.tags ?? [],
    content_type: data.content_type ?? 'newsletter',
    saved: data.saved ?? false,
    pdf_type: data.pdf_type ?? null,
    processing_status: data.processing_status ?? 'done',
    extract_ocr: data.extract_ocr !== false,
  };
}

export async function getDistinctTags(): Promise<string[]> {
  const result = await db.execute({
    sql: `SELECT tags FROM articles WHERE tags IS NOT NULL AND tags != '[]'`,
    args: [],
  });
  const seen = new Set<string>();
  for (const row of result.rows) {
    try {
      const arr = JSON.parse(String(row.tags ?? '[]'));
      if (Array.isArray(arr)) arr.forEach((t: unknown) => { if (typeof t === 'string' && t) seen.add(t); });
    } catch { /* skip malformed */ }
  }
  return [...seen].sort();
}

export async function setAiSummary(id: number, aiSummary: string): Promise<void> {
  await db.execute({
    sql: `UPDATE articles SET ai_summary = ?, updated_at = ? WHERE id = ?`,
    args: [aiSummary, new Date().toISOString(), id],
  });
}

export async function setArticleSummary(id: number, summary: string): Promise<void> {
  await db.execute({
    sql: `UPDATE articles SET summary = ?, updated_at = ? WHERE id = ?`,
    args: [summary, new Date().toISOString(), id],
  });
}

export async function setCachedContent(id: number, url: string, cachedAt: string): Promise<void> {
  await db.execute({
    sql: `UPDATE articles SET cached_content_url = ?, cached_at = ?, updated_at = ? WHERE id = ?`,
    args: [url, cachedAt, new Date().toISOString(), id],
  });
}

export async function setPdfProcessingStatus(
  id: number,
  status: 'pending' | 'processing' | 'done' | 'error',
): Promise<void> {
  await db.execute({
    sql: `UPDATE articles SET processing_status = ?, updated_at = ? WHERE id = ?`,
    args: [status, new Date().toISOString(), id],
  });
}

export async function setOcrText(articleId: number, text: string): Promise<void> {
  await db.execute({
    sql: `INSERT OR REPLACE INTO article_ocr (article_id, ocr_text) VALUES (?, ?)`,
    args: [articleId, text],
  });
}

export async function searchByOcrText(
  query: string,
  limit = 20,
): Promise<Array<{ id: number; title: string }>> {
  const result = await db.execute({
    sql: `
      SELECT a.id, a.title
      FROM article_ocr_fts f
      JOIN articles a ON a.id = f.rowid
      WHERE article_ocr_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `,
    args: [query, limit],
  });
  return result.rows.map(row => ({
    id: Number(row.id),
    title: String(row.title),
  }));
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
