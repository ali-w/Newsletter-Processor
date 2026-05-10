import express from 'express';
import { HttpFunction } from '@google-cloud/functions-framework';
import { config } from '../config';
import { logger } from '../logger';
import { getArticleById, getDistinctTags, updateArticle, ArticlePatch } from '../db/database';
import { summarizeArticleFromUrl, describeArticleFromUrl, fetchRawHtml } from '../llm/parser';
import { uploadHtml, getFileStream } from '../storage/gcs';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';

const app = express();

app.get('/articles/:id/summary', async (req, res) => {
  try {
    const secret = req.headers['x-api-key'] as string | undefined;
    if (secret !== config.RSS_SECRET) return res.status(401).send('Unauthorized');

    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id <= 0) return res.status(400).send('Invalid article ID — must be a positive integer.');

    logger.info('Summary requested', { articleId: id });

    const article = await getArticleById(id);
    if (!article) return res.status(404).send(`Article with ID ${id} not found.`);

    logger.info('Generating summary', { articleId: id, title: article.title });

    const summary = await summarizeArticleFromUrl(article.url, article.title, article.notes);
    res.set('Content-Type', 'text/plain; charset=utf-8');
    return res.status(200).send(summary);

  } catch (err) {
    logger.error('Error generating article summary', { error: err instanceof Error ? err.message : String(err) });
    return res.status(500).send('Failed to generate summary. Please try again later.');
  }
});

app.get('/articles/:id/describe', async (req, res) => {
  try {
    const secret = req.headers['x-api-key'] as string | undefined;
    if (secret !== config.RSS_SECRET) return res.status(401).json({ error: 'Unauthorized' });

    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id <= 0) return res.status(400).json({ error: 'Invalid article ID' });

    const [article, existingTags] = await Promise.all([getArticleById(id), getDistinctTags()]);
    if (!article) return res.status(404).json({ error: `Article ${id} not found` });

    logger.info('Describing article', { articleId: id, title: article.title });

    const result = await describeArticleFromUrl(article.url, article.title, existingTags);

    const patch: ArticlePatch = { summary: result.summary };
    if (!article.tags || article.tags.length === 0) {
      patch.tags = [result.suggestedTag];
    }
    await updateArticle(id, patch);

    return res.status(200).json(result);
  } catch (err) {
    logger.error('Error describing article', { error: err instanceof Error ? err.message : String(err) });
    return res.status(500).json({ error: 'Failed to describe article' });
  }
});

const UNCACHEABLE_TYPES = ['video', 'podcast', 'other'];

app.post('/articles/:id/cache', async (req, res) => {
  try {
    const secret = req.headers['x-api-key'] as string | undefined;
    if (secret !== config.RSS_SECRET) return res.status(401).json({ error: 'Unauthorized' });

    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id <= 0) return res.status(400).json({ error: 'Invalid article ID' });

    const article = await getArticleById(id);
    if (!article) return res.status(404).json({ error: `Article ${id} not found` });

    if (UNCACHEABLE_TYPES.includes(article.content_type ?? '')) {
      return res.status(422).json({ error: 'Caching is not supported for this content type' });
    }

    logger.info('Caching article', { articleId: id, url: article.url });

    const html = await fetchRawHtml(article.url);
    const dom = new JSDOM(html, { url: article.url });
    const reader = new Readability(dom.window.document);
    const parsed = reader.parse();
    if (!parsed) return res.status(422).json({ error: 'Could not extract article content from page' });

    const cleanHtml = `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>${parsed.title}</title>
<style>body{max-width:800px;margin:2rem auto;font-family:Georgia,serif;line-height:1.6;padding:0 1rem}h1{font-size:1.5rem}</style>
</head><body><h1>${parsed.title}</h1>${parsed.content}</body></html>`;

    const gsUri = await uploadHtml(id, cleanHtml);
    const now = new Date().toISOString();
    const patch: ArticlePatch = { cached_content_url: gsUri, cached_at: now };
    await updateArticle(id, patch);

    logger.info('Article cached', { articleId: id, gsUri });
    return res.status(200).json({ cached_content_url: gsUri, cached_at: now });
  } catch (err) {
    logger.error('Error caching article', { error: err instanceof Error ? err.message : String(err) });
    return res.status(500).json({ error: 'Failed to cache article' });
  }
});

app.get('/articles/:id/cached-content', async (req, res) => {
  try {
    const secret = req.headers['x-api-key'] as string | undefined;
    if (secret !== config.RSS_SECRET) return res.status(401).json({ error: 'Unauthorized' });

    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id <= 0) return res.status(400).json({ error: 'Invalid article ID' });

    const article = await getArticleById(id);
    if (!article) return res.status(404).json({ error: `Article ${id} not found` });
    if (!article.cached_content_url) return res.status(404).json({ error: 'No cached content for this article' });

    const stream = getFileStream(article.cached_content_url);
    res.set('Content-Type', 'text/html; charset=utf-8');
    stream.on('error', (err) => {
      logger.error('GCS stream error', { error: err.message, gsUri: article.cached_content_url });
      if (!res.headersSent) res.status(500).json({ error: 'Failed to read cached content' });
    });
    stream.pipe(res);
  } catch (err) {
    logger.error('Error retrieving cached content', { error: err instanceof Error ? err.message : String(err) });
    return res.status(500).json({ error: 'Failed to retrieve cached content' });
  }
});

export const summarize: HttpFunction = (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  app(req, res);
};
