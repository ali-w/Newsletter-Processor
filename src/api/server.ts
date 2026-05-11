import express from 'express';
import { MessageClient } from 'cloudmailin';
import { config } from '../config';
import { logger } from '../logger';
import { extractArticles, summarizeArticleFromUrl } from '../llm/parser';
import { insertNewsletter, insertArticle, getLatestArticles, getArticleById, updateArticle, updateArticles, ArticlePatch } from '../db/database';
import { generateRssFeed } from '../rss/generator';

export const app = express();

app.use(express.json({ limit: '5mb' }));

// Global CORS Middleware
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, secret, X-Api-Key');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  next();
});

const HARD_CAP = 200;
const DEFAULT_LIMIT = 50;

function parseLimit(raw: unknown): number {
  const n = parseInt(String(raw), 10);
  if (isNaN(n) || n <= 0) return Math.min(DEFAULT_LIMIT, config.ARTICLES_MAX_LIMIT);
  return Math.min(n, HARD_CAP, config.ARTICLES_MAX_LIMIT);
}

// Reads X-Api-Key header first, falls back to ?secret query param.
// RSS readers cannot set custom headers, so the query-param fallback is kept for GET endpoints.
function getSecret(req: express.Request): string | undefined {
  return (req.headers['x-api-key'] as string | undefined) ?? (req.query.secret as string | undefined);
}

// RSS Feed Endpoint
app.get('/rss', async (req, res) => {
  try {
    const { limit } = req.query;

    if (getSecret(req) !== config.RSS_SECRET) {
      return res.status(401).send('Unauthorized');
    }

    const articles = await getLatestArticles(parseLimit(limit));
    const xml = generateRssFeed(articles as any[], config.SERVICE_URL);

    res.set('Content-Type', 'application/rss+xml');
    res.send(xml);
  } catch (err) {
    logger.error('Error generating RSS feed', { error: String(err) });
    res.status(500).send('Internal Server Error');
  }
});

// JSON Feed Endpoint
app.get('/articles', async (req, res) => {
  try {
    const { limit } = req.query;

    if (getSecret(req) !== config.RSS_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const articles = await getLatestArticles(parseLimit(limit));
    res.json(articles);
  } catch (err) {
    logger.error('Error fetching articles JSON', { error: String(err) });
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// CloudMailin Webhook Endpoint
// POST /webhook/cloudmailin
app.post('/webhook/cloudmailin', async (req, res) => {
  try {
    if (getSecret(req) !== config.RSS_SECRET) {
      logger.warn('Unauthorized attempt to post to webhook');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const payload = req.body;
    const senderName = payload.envelope?.from || payload.headers?.From || 'Unknown Sender';
    const receivedAtStr = payload.headers?.Date;
    const receivedAt = receivedAtStr ? new Date(receivedAtStr) : new Date();
    const content = payload.html || payload.plain || '';

    if (!content) {
      logger.warn('Received empty content', { sender: senderName });
      return res.status(400).json({ error: 'No content found in email' });
    }

    logger.info('Processing incoming newsletter', { sender: senderName });

    const articles = await extractArticles(content);

    if (articles.length === 0) {
      logger.warn('No articles extracted', { sender: senderName });

      if (config.CLOUDMAILIN_USERNAME && config.CLOUDMAILIN_API_KEY && config.REVIEW_RECIPIENT_EMAIL) {
        try {
          logger.info('Forwarding newsletter for manual review', { sender: senderName });
          const client = new MessageClient({
            username: config.CLOUDMAILIN_USERNAME,
            apiKey: config.CLOUDMAILIN_API_KEY
          });
          await client.sendMessage({
            to: config.REVIEW_RECIPIENT_EMAIL,
            from: 'newsletterprocessing-fail@infinitefunk.co.uk',
            subject: `Manual Review Required: Newsletter from ${senderName}`,
            plain: payload.plain || 'No plain text content available.',
            html: payload.html || content
          });
          logger.info('Forwarded for manual review', { recipient: config.REVIEW_RECIPIENT_EMAIL });
        } catch (forwardErr) {
          logger.error('Failed to forward email', { error: String(forwardErr) });
        }
      }

      return res.status(200).json({ status: 'success', message: 'No articles found' });
    }

    const newsletterId = await insertNewsletter(senderName, receivedAt);
    for (const article of articles) {
      await insertArticle(newsletterId, article);
    }

    logger.info('Saved articles from newsletter', { sender: senderName, count: articles.length });

    return res.status(200).json({
      status: 'success',
      message: `Successfully processed newsletter with ${articles.length} articles.`,
    });

  } catch (err) {
    logger.error('Error processing CloudMailin webhook', { error: err instanceof Error ? err.message : String(err) });
    return res.status(500).json({ error: 'Internal server error during processing' });
  }
});

// Single article annotation update — PATCH /articles/:id
app.patch('/articles/:id', async (req, res) => {
  if (getSecret(req) !== config.RSS_SECRET) return res.status(401).json({ error: 'Unauthorized' });

  const id = parseInt(req.params.id, 10);
  if (isNaN(id) || id <= 0) return res.status(400).json({ error: 'Invalid article ID' });

  const { status, rating, notes } = req.body;

  if (status !== undefined && !['unread', 'read', 'skipped', 'later'].includes(status)) {
    return res.status(400).json({ error: 'status must be "unread", "read", "skipped", or "later"' });
  }
  if ('rating' in req.body && rating !== null && (!Number.isInteger(rating) || rating < 1 || rating > 5)) {
    return res.status(400).json({ error: 'rating must be an integer 1–5, or null' });
  }
  if (notes !== undefined && typeof notes !== 'string') {
    return res.status(400).json({ error: 'notes must be a string' });
  }

  const patch: ArticlePatch = {};
  if (status !== undefined) patch.status = status;
  if ('rating' in req.body) patch.rating = rating ?? null;
  if (notes !== undefined) patch.notes = notes;

  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: 'No recognised fields to update' });
  }

  const updatedAt = await updateArticle(id, patch);
  if (updatedAt === null) return res.status(404).json({ error: 'Article not found' });

  return res.json({ id, updated_at: updatedAt });
});

// Batch annotation update (offline flush) — POST /articles/updates
app.post('/articles/updates', async (req, res) => {
  if (getSecret(req) !== config.RSS_SECRET) return res.status(401).json({ error: 'Unauthorized' });

  if (!Array.isArray(req.body)) return res.status(400).json({ error: 'Expected a JSON array' });

  const updates: Array<{ id: number } & ArticlePatch> = [];

  for (const item of req.body) {
    const { id, status, rating, notes } = item;
    if (!Number.isInteger(id) || id <= 0) continue;

    const patch: ArticlePatch = {};
    if (status !== undefined && ['unread', 'read', 'skipped', 'later'].includes(status)) patch.status = status;
    if ('rating' in item) patch.rating = (Number.isInteger(rating) && rating >= 1 && rating <= 5) ? rating : null;
    if (typeof notes === 'string') patch.notes = notes;

    updates.push({ id, ...patch });
  }

  const result = await updateArticles(updates);
  return res.json(result);
});

// Article Summarization Endpoint — GET /summarize/:id
app.get('/summarize/:id', async (req, res) => {
  try {
    if (getSecret(req) !== config.RSS_SECRET) {
      return res.status(401).send('Unauthorized');
    }

    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id <= 0) {
      return res.status(400).send('Invalid article ID — must be a positive integer.');
    }

    logger.info('Summary requested', { articleId: id });

    const article = await getArticleById(id);
    if (!article) {
      return res.status(404).send(`Article with ID ${id} not found.`);
    }

    logger.info('Generating summary', { articleId: id, title: article.title });

    const summary = await summarizeArticleFromUrl(article.url, article.title);

    res.set('Content-Type', 'text/plain; charset=utf-8');
    return res.status(200).send(summary);

  } catch (err) {
    logger.error('Error generating article summary', { error: err instanceof Error ? err.message : String(err) });
    return res.status(500).send('Failed to generate summary. Please try again later.');
  }
});
