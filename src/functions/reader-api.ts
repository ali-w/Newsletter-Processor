import express from 'express';
import cors from 'cors';
import { HttpFunction } from '@google-cloud/functions-framework';
import { config } from '../config';
import { logger } from '../logger';
import { getLatestArticles, updateArticle, updateArticles, createManualArticle, ArticlePatch } from '../db/database';
import { generateRssFeed } from '../rss/generator';
import { parseJsonBody } from './parseBody';

const router = express.Router();
router.use(parseJsonBody);

const HARD_CAP = 200;
const DEFAULT_LIMIT = 50;

function getQueryParam(req: express.Request, name: string): string | undefined {
  return new URL(req.url, 'https://localhost').searchParams.get(name) ?? undefined;
}

function parseLimit(req: express.Request): number {
  const n = parseInt(getQueryParam(req, 'limit') ?? '', 10);
  if (isNaN(n) || n <= 0) return Math.min(DEFAULT_LIMIT, config.ARTICLES_MAX_LIMIT);
  return Math.min(n, HARD_CAP, config.ARTICLES_MAX_LIMIT);
}

function getSecret(req: express.Request): string | undefined {
  return (req.headers['x-api-key'] as string | undefined) ?? getQueryParam(req, 'secret');
}

router.get('/rss', async (req, res) => {
  try {
    if (getSecret(req) !== config.RSS_SECRET) return res.status(401).send('Unauthorized');
    const articles = await getLatestArticles(parseLimit(req));
    const xml = generateRssFeed(articles as any[], config.SERVICE_URL);
    res.set('Content-Type', 'application/rss+xml');
    res.send(xml);
  } catch (err) {
    logger.error('Error generating RSS feed', { error: String(err) });
    res.status(500).send('Internal Server Error');
  }
});

router.get('/articles', async (req, res) => {
  try {
    if (getSecret(req) !== config.RSS_SECRET) return res.status(401).json({ error: 'Unauthorized' });
    const articles = await getLatestArticles(parseLimit(req));
    res.json(articles);
  } catch (err) {
    logger.error('Error fetching articles JSON', { error: String(err) });
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

router.patch('/articles/:id', async (req, res) => {
  if (getSecret(req) !== config.RSS_SECRET) return res.status(401).json({ error: 'Unauthorized' });

  const id = parseInt(req.params.id, 10);
  if (isNaN(id) || id <= 0) return res.status(400).json({ error: 'Invalid article ID' });

  const { status, rating, notes, tags, saved } = req.body;

  if (status !== undefined && !['unread', 'read', 'skipped'].includes(status)) {
    return res.status(400).json({ error: 'status must be "unread", "read", or "skipped"' });
  }
  if ('rating' in req.body && rating !== null && (!Number.isInteger(rating) || rating < 1 || rating > 5)) {
    return res.status(400).json({ error: 'rating must be an integer 1–5, or null' });
  }
  if (notes !== undefined && typeof notes !== 'string') {
    return res.status(400).json({ error: 'notes must be a string' });
  }
  if ('tags' in req.body && (!Array.isArray(tags) || tags.some((t: unknown) => typeof t !== 'string'))) {
    return res.status(400).json({ error: 'tags must be an array of strings' });
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

  return res.json({ id, updated_at: updatedAt });
});

router.post('/articles', async (req, res) => {
  if (getSecret(req) !== config.RSS_SECRET) return res.status(401).json({ error: 'Unauthorized' });

  const { title, url, summary, tags, content_type, saved } = req.body ?? {};

  if (!title || typeof title !== 'string') return res.status(400).json({ error: 'title is required and must be a string' });
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url is required and must be a string' });
  if (summary !== undefined && typeof summary !== 'string') return res.status(400).json({ error: 'summary must be a string' });
  if (tags !== undefined && (!Array.isArray(tags) || tags.some((t: unknown) => typeof t !== 'string'))) {
    return res.status(400).json({ error: 'tags must be an array of strings' });
  }
  if (content_type !== undefined && typeof content_type !== 'string') return res.status(400).json({ error: 'content_type must be a string' });
  if (saved !== undefined && typeof saved !== 'boolean') return res.status(400).json({ error: 'saved must be a boolean' });

  try {
    const article = await createManualArticle({ title, url, summary, tags, content_type, saved });
    return res.status(201).json(article);
  } catch (err) {
    logger.error('Error creating article', { error: String(err) });
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

router.post('/articles/updates', async (req, res) => {
  if (getSecret(req) !== config.RSS_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  if (!Array.isArray(req.body)) return res.status(400).json({ error: 'Expected a JSON array' });

  const updates: Array<{ id: number } & ArticlePatch> = [];
  for (const item of req.body) {
    const { id, status, rating, notes } = item;
    if (!Number.isInteger(id) || id <= 0) continue;
    const patch: ArticlePatch = {};
    if (status !== undefined && ['unread', 'read', 'skipped'].includes(status)) patch.status = status;
    if ('rating' in item) patch.rating = (Number.isInteger(rating) && rating >= 1 && rating <= 5) ? rating : null;
    if (typeof notes === 'string') patch.notes = notes;
    if (Array.isArray(item.tags)) patch.tags = item.tags.filter((t: unknown) => typeof t === 'string');
    if (typeof item.saved === 'boolean') patch.saved = item.saved;
    updates.push({ id, ...patch });
  }

  const result = await updateArticles(updates);
  return res.json(result);
});

const app = express();
app.use(router);

const corsMiddleware = cors({
  origin: '*',
  methods: ['GET', 'PATCH', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Api-Key'],
});

export const readerApi: HttpFunction = (req, res) => {
  corsMiddleware(req, res, () => app(req, res));
};
