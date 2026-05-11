import express from 'express';
import cors from 'cors';
import { HttpFunction } from '@google-cloud/functions-framework';
import { CloudTasksClient } from '@google-cloud/tasks';
import { config } from '../config';
import { logger } from '../logger';
import {
  db,
  getLatestArticles,
  getArticleById,
  updateArticle,
  updateArticles,
  createManualArticle,
  setCachedContent,
  setPdfProcessingStatus,
  searchByOcrText,
  ArticlePatch,
} from '../db/database';
import { generateRssFeed } from '../rss/generator';
import { parseJsonBody } from './parseBody';
import { generateSignedPutUrl, generateSignedGetUrl, pdfExists, deletePdf } from '../storage/gcs';

const router = express.Router();
router.use(parseJsonBody);

const tasksClient = new CloudTasksClient({ fallback: true });

const HARD_CAP = 200;
const DEFAULT_LIMIT = 50;

const MAX_TITLE_LEN   = 500;
const MAX_URL_LEN     = 2048;
const MAX_SUMMARY_LEN = 10_000;
const MAX_NOTES_LEN   = 10_000;
const MAX_TAGS        = 20;
const MAX_TAG_LEN     = 50;
const VALID_CONTENT_TYPES = ['newsletter', 'article', 'video', 'podcast', 'webpage', 'notebook', 'pdf', 'other'];

function getQueryParam(req: express.Request, name: string): string | undefined {
  return new URL(req.url, 'https://localhost').searchParams.get(name) ?? undefined;
}

function parseLimit(req: express.Request): number {
  const n = parseInt(getQueryParam(req, 'limit') ?? '', 10);
  if (isNaN(n) || n <= 0) return Math.min(DEFAULT_LIMIT, config.ARTICLES_MAX_LIMIT);
  return Math.min(n, HARD_CAP, config.ARTICLES_MAX_LIMIT);
}

function getSecret(req: express.Request): string | undefined {
  return req.headers['x-api-key'] as string | undefined;
}

function validateArticleUrl(raw: string): string | null {
  let parsed: URL;
  try { parsed = new URL(raw); } catch { return 'url must be a valid URL'; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return 'url must use http or https';
  const host = parsed.hostname.toLowerCase();
  const blocked = /^(localhost|127\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|169\.254\.|::1$|0\.0\.0\.0)/.test(host)
    || host === 'metadata.google.internal';
  if (blocked) return 'url host is not allowed';
  return null;
}

// ---------------------------------------------------------------------------
// GET /rss
// ---------------------------------------------------------------------------

router.get('/rss', async (req, res) => {
  try {
    const rssSecret = getSecret(req) ?? getQueryParam(req, 'secret');
    if (rssSecret !== config.RSS_SECRET) return res.status(401).send('Unauthorized');
    const articles = await getLatestArticles(parseLimit(req));
    const xml = generateRssFeed(articles as any[], config.SERVICE_URL);
    res.set('Content-Type', 'application/rss+xml');
    res.send(xml);
  } catch (err) {
    logger.error('Error generating RSS feed', { error: String(err) });
    res.status(500).send('Internal Server Error');
  }
});

// ---------------------------------------------------------------------------
// GET /articles
// ---------------------------------------------------------------------------

router.get('/articles', async (req, res) => {
  try {
    if (getSecret(req) !== config.RSS_SECRET) return res.status(401).json({ error: 'Unauthorized' });
    const updatedSinceRaw = getQueryParam(req, 'updated_since');
    if (updatedSinceRaw !== undefined && isNaN(new Date(updatedSinceRaw).getTime())) {
      return res.status(400).json({ error: 'updated_since must be a valid ISO timestamp' });
    }
    const articles = await getLatestArticles(parseLimit(req), updatedSinceRaw);
    res.json(articles);
  } catch (err) {
    logger.error('Error fetching articles JSON', { error: String(err) });
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// ---------------------------------------------------------------------------
// GET /articles/search  — FTS5 full-text search over OCR text
// Must be registered before any /articles/:id routes.
// ---------------------------------------------------------------------------

router.get('/articles/search', async (req, res) => {
  if (getSecret(req) !== config.RSS_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  const q = getQueryParam(req, 'q') ?? '';
  if (q.length < 3) return res.status(400).json({ error: 'q must be at least 3 characters' });
  try {
    const results = await searchByOcrText(q);
    return res.json({ results });
  } catch (err) {
    logger.error('Search error', { error: String(err) });
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// ---------------------------------------------------------------------------
// PATCH /articles/:id
// ---------------------------------------------------------------------------

router.patch('/articles/:id', async (req, res) => {
  if (getSecret(req) !== config.RSS_SECRET) return res.status(401).json({ error: 'Unauthorized' });

  const id = parseInt(req.params.id, 10);
  if (isNaN(id) || id <= 0) return res.status(400).json({ error: 'Invalid article ID' });

  const { status, rating, notes, tags, saved } = req.body;

  if (status !== undefined && !['unread', 'read', 'skipped', 'later'].includes(status)) {
    return res.status(400).json({ error: 'status must be "unread", "read", "skipped", or "later"' });
  }
  if ('rating' in req.body && rating !== null && (!Number.isInteger(rating) || rating < 1 || rating > 5)) {
    return res.status(400).json({ error: 'rating must be an integer 1–5, or null' });
  }
  if (notes !== undefined && typeof notes !== 'string') {
    return res.status(400).json({ error: 'notes must be a string' });
  }
  if (notes !== undefined && notes.length > MAX_NOTES_LEN) {
    return res.status(400).json({ error: `notes must be ${MAX_NOTES_LEN} characters or fewer` });
  }
  if ('tags' in req.body && (!Array.isArray(tags) || tags.some((t: unknown) => typeof t !== 'string'))) {
    return res.status(400).json({ error: 'tags must be an array of strings' });
  }
  if ('tags' in req.body && Array.isArray(tags) && tags.length > MAX_TAGS) {
    return res.status(400).json({ error: `tags must contain ${MAX_TAGS} items or fewer` });
  }
  if ('tags' in req.body && Array.isArray(tags) && tags.some((t: string) => t.length > MAX_TAG_LEN)) {
    return res.status(400).json({ error: `each tag must be ${MAX_TAG_LEN} characters or fewer` });
  }
  if ('saved' in req.body && typeof saved !== 'boolean') {
    return res.status(400).json({ error: 'saved must be a boolean' });
  }

  const patch: ArticlePatch = {};
  if (status !== undefined) patch.status = status;
  if ('rating' in req.body) patch.rating = rating ?? null;
  if (notes !== undefined) patch.notes = notes;
  if ('tags' in req.body) patch.tags = tags ?? [];
  if ('saved' in req.body) patch.saved = saved;

  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: 'No recognised fields to update' });
  }

  const updatedAt = await updateArticle(id, patch);
  if (updatedAt === null) return res.status(404).json({ error: 'Article not found' });

  if (patch.saved === true && config.SUMMARIZE_URL) {
    fetch(`${config.SUMMARIZE_URL}/articles/${id}/cache`, {
      method: 'POST',
      headers: { 'x-api-key': config.RSS_SECRET },
    }).catch(err => logger.warn('Auto-cache trigger failed', { articleId: id, error: String(err) }));
  }

  return res.json({ id, updated_at: updatedAt });
});

// ---------------------------------------------------------------------------
// POST /articles/upload-pdf  — initiate PDF upload
// Must be registered before POST /articles to avoid ambiguity.
// ---------------------------------------------------------------------------

router.post('/articles/upload-pdf', async (req, res) => {
  if (getSecret(req) !== config.RSS_SECRET) return res.status(401).json({ error: 'Unauthorized' });

  const { title, pdf_type, extract_ocr, tags, summary, saved } = req.body ?? {};

  if (title !== undefined && typeof title !== 'string') return res.status(400).json({ error: 'title must be a string' });
  if (title !== undefined && title.length > MAX_TITLE_LEN) return res.status(400).json({ error: `title must be ${MAX_TITLE_LEN} characters or fewer` });
  if (!['typed', 'handwritten'].includes(pdf_type)) {
    return res.status(400).json({ error: 'pdf_type must be "typed" or "handwritten"' });
  }
  if (tags !== undefined && (!Array.isArray(tags) || tags.some((t: unknown) => typeof t !== 'string'))) {
    return res.status(400).json({ error: 'tags must be an array of strings' });
  }
  if (tags !== undefined && tags.length > MAX_TAGS) return res.status(400).json({ error: `tags must contain ${MAX_TAGS} items or fewer` });
  if (tags !== undefined && tags.some((t: string) => t.length > MAX_TAG_LEN)) return res.status(400).json({ error: `each tag must be ${MAX_TAG_LEN} characters or fewer` });
  if (summary !== undefined && typeof summary !== 'string') return res.status(400).json({ error: 'summary must be a string' });
  if (summary !== undefined && summary.length > MAX_SUMMARY_LEN) return res.status(400).json({ error: `summary must be ${MAX_SUMMARY_LEN} characters or fewer` });

  try {
    const autoTag = pdf_type === 'handwritten' ? 'notes' : 'document';
    const mergedTags = [autoTag, ...(tags ?? []).filter((t: string) => t !== autoTag)];
    const hasTitle = !!title;

    const article = await createManualArticle({
      title: title ?? 'Untitled',
      url: 'gs://pending',
      summary: summary ?? '',
      tags: mergedTags,
      content_type: 'pdf',
      saved: saved !== false,
      pdf_type,
      processing_status: 'pending',
      extract_ocr: extract_ocr !== false,
    });

    const id = article.id!;
    const gcsUri = `gs://${config.GCS_PDF_BUCKET}/${id}.pdf`;

    await db.execute({ sql: `UPDATE articles SET url = ? WHERE id = ?`, args: [gcsUri, id] });

    const uploadUrl = await generateSignedPutUrl(id);

    return res.status(201).json({ id, upload_url: uploadUrl, gcs_uri: gcsUri, has_title: hasTitle });
  } catch (err) {
    logger.error('Error creating PDF article', { error: String(err) });
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// ---------------------------------------------------------------------------
// POST /articles  — manual article creation
// ---------------------------------------------------------------------------

router.post('/articles', async (req, res) => {
  if (getSecret(req) !== config.RSS_SECRET) return res.status(401).json({ error: 'Unauthorized' });

  const { title, url, summary, tags, content_type, saved } = req.body ?? {};

  if (!title || typeof title !== 'string') return res.status(400).json({ error: 'title is required and must be a string' });
  if (title.length > MAX_TITLE_LEN) return res.status(400).json({ error: `title must be ${MAX_TITLE_LEN} characters or fewer` });
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url is required and must be a string' });
  if (url.length > MAX_URL_LEN) return res.status(400).json({ error: `url must be ${MAX_URL_LEN} characters or fewer` });
  const urlError = validateArticleUrl(url);
  if (urlError) return res.status(400).json({ error: urlError });
  if (summary !== undefined && typeof summary !== 'string') return res.status(400).json({ error: 'summary must be a string' });
  if (summary !== undefined && summary.length > MAX_SUMMARY_LEN) return res.status(400).json({ error: `summary must be ${MAX_SUMMARY_LEN} characters or fewer` });
  if (tags !== undefined && (!Array.isArray(tags) || tags.some((t: unknown) => typeof t !== 'string'))) {
    return res.status(400).json({ error: 'tags must be an array of strings' });
  }
  if (tags !== undefined && tags.length > MAX_TAGS) return res.status(400).json({ error: `tags must contain ${MAX_TAGS} items or fewer` });
  if (tags !== undefined && tags.some((t: string) => t.length > MAX_TAG_LEN)) return res.status(400).json({ error: `each tag must be ${MAX_TAG_LEN} characters or fewer` });
  if (content_type !== undefined && !VALID_CONTENT_TYPES.includes(content_type)) {
    return res.status(400).json({ error: `content_type must be one of: ${VALID_CONTENT_TYPES.join(', ')}` });
  }
  if (saved !== undefined && typeof saved !== 'boolean') return res.status(400).json({ error: 'saved must be a boolean' });

  try {
    const article = await createManualArticle({ title, url, summary, tags, content_type, saved });
    const ct = content_type ?? 'newsletter';
    if (config.SUMMARIZE_URL && !['video', 'podcast', 'other'].includes(ct)) {
      fetch(`${config.SUMMARIZE_URL}/articles/${article.id}/cache`, {
        method: 'POST',
        headers: { 'x-api-key': config.RSS_SECRET },
      }).catch(err => logger.warn('Auto-cache trigger failed', { articleId: article.id, error: String(err) }));
    }
    return res.status(201).json(article);
  } catch (err) {
    logger.error('Error creating article', { error: String(err) });
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// ---------------------------------------------------------------------------
// POST /articles/updates  — batch offline flush
// ---------------------------------------------------------------------------

router.post('/articles/updates', async (req, res) => {
  if (getSecret(req) !== config.RSS_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  if (!Array.isArray(req.body)) return res.status(400).json({ error: 'Expected a JSON array' });

  const updates: Array<{ id: number } & ArticlePatch> = [];
  for (const item of req.body) {
    const { id, status, rating, notes } = item;
    if (!Number.isInteger(id) || id <= 0) continue;
    const patch: ArticlePatch = {};
    if (status !== undefined && ['unread', 'read', 'skipped', 'later'].includes(status)) patch.status = status;
    if ('rating' in item) patch.rating = (Number.isInteger(rating) && rating >= 1 && rating <= 5) ? rating : null;
    if (typeof notes === 'string' && notes.length <= MAX_NOTES_LEN) patch.notes = notes;
    if (Array.isArray(item.tags)) {
      const validTags = item.tags.filter((t: unknown) => typeof t === 'string' && (t as string).length <= MAX_TAG_LEN);
      if (validTags.length <= MAX_TAGS) patch.tags = validTags;
    }
    if (typeof item.saved === 'boolean') patch.saved = item.saved;
    updates.push({ id, ...patch });
  }

  const result = await updateArticles(updates);
  return res.json(result);
});

// ---------------------------------------------------------------------------
// POST /articles/:id/confirm-upload  — confirm PDF uploaded to GCS, enqueue processing
// ---------------------------------------------------------------------------

router.post('/articles/:id/confirm-upload', async (req, res) => {
  if (getSecret(req) !== config.RSS_SECRET) return res.status(401).json({ error: 'Unauthorized' });

  const id = parseInt(req.params.id, 10);
  if (isNaN(id) || id <= 0) return res.status(400).json({ error: 'Invalid article ID' });

  try {
    const article = await getArticleById(id);
    if (!article) return res.status(404).json({ error: 'Article not found' });

    const uploaded = await pdfExists(id);
    if (!uploaded) {
      return res.status(422).json({ error: 'PDF has not been uploaded yet — complete the file upload before confirming' });
    }

    const gcsUri = `gs://${config.GCS_PDF_BUCKET}/${id}.pdf`;
    const now = new Date().toISOString();
    await setCachedContent(id, gcsUri, now);

    const skipGemini = !article.extract_ocr && !!article.summary;
    if (skipGemini) {
      await setPdfProcessingStatus(id, 'done');
      return res.json({ ok: true });
    }

    await setPdfProcessingStatus(id, 'processing');

    if (!config.GCP_PROJECT || !config.SUMMARIZE_URL) {
      logger.error('GCP_PROJECT or SUMMARIZE_URL not configured — cannot enqueue PDF task');
      return res.status(500).json({ error: 'Service misconfigured' });
    }

    const parent = tasksClient.queuePath(config.GCP_PROJECT, config.GCP_REGION, config.TASKS_QUEUE);
    const payload = {
      pdf_type: article.pdf_type,
      gcs_uri: gcsUri,
      extract_ocr: article.extract_ocr,
      has_summary: !!(article.summary),
      has_title: article.title !== 'Untitled',
    };
    const task = {
      httpRequest: {
        httpMethod: 'POST' as const,
        url: `${config.SUMMARIZE_URL}/articles/${id}/process-pdf`,
        headers: { 'Content-Type': 'application/json', 'x-api-key': config.RSS_SECRET },
        body: Buffer.from(JSON.stringify(payload)).toString('base64'),
      },
    };

    const [response] = await tasksClient.createTask({ parent, task });
    logger.info('PDF process task enqueued', { taskName: response.name, articleId: id });

    return res.json({ ok: true });
  } catch (err) {
    logger.error('confirm-upload error', { error: String(err) });
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// ---------------------------------------------------------------------------
// GET /articles/:id/pdf  — redirect to signed GCS URL for PDF viewing
// Supports ?secret query param (URL opened in new tab, no header possible).
// ---------------------------------------------------------------------------

router.get('/articles/:id/pdf', async (req, res) => {
  const secret = (req.headers['x-api-key'] as string | undefined) ?? getQueryParam(req, 'secret');
  if (secret !== config.RSS_SECRET) return res.status(401).json({ error: 'Unauthorized' });

  const id = parseInt(req.params.id, 10);
  if (isNaN(id) || id <= 0) return res.status(400).json({ error: 'Invalid article ID' });

  try {
    const article = await getArticleById(id);
    if (!article || article.content_type !== 'pdf') return res.status(404).json({ error: 'PDF not found' });

    const signedUrl = await generateSignedGetUrl(id);
    return res.redirect(302, signedUrl);
  } catch (err) {
    logger.error('Error generating PDF URL', { error: String(err) });
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /articles/:id  — delete article and clean up GCS PDF if pending
// ---------------------------------------------------------------------------

router.delete('/articles/:id', async (req, res) => {
  if (getSecret(req) !== config.RSS_SECRET) return res.status(401).json({ error: 'Unauthorized' });

  const id = parseInt(req.params.id, 10);
  if (isNaN(id) || id <= 0) return res.status(400).json({ error: 'Invalid article ID' });

  try {
    const article = await getArticleById(id);
    if (!article) return res.status(404).json({ error: 'Article not found' });

    if (article.content_type === 'pdf' && article.processing_status === 'pending') {
      await deletePdf(id).catch(err =>
        logger.warn('Could not delete PDF from GCS during article cleanup', { articleId: id, error: String(err) }),
      );
    }

    await db.execute({ sql: `DELETE FROM articles WHERE id = ?`, args: [id] });
    return res.status(204).end();
  } catch (err) {
    logger.error('Error deleting article', { error: String(err) });
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// ---------------------------------------------------------------------------

const app = express();
app.use(router);

const corsMiddleware = cors({
  origin: '*',
  methods: ['GET', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Api-Key'],
});

export const readerApi: HttpFunction = (req, res) => {
  corsMiddleware(req, res, () => app(req, res));
};
