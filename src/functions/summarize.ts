import express from 'express';
import { HttpFunction } from '@google-cloud/functions-framework';
import { config } from '../config';
import { logger } from '../logger';
import { getArticleById, getDistinctTags, updateArticle, ArticlePatch } from '../db/database';
import { summarizeArticleFromUrl, describeArticleFromUrl } from '../llm/parser';

const app = express();

app.get('/articles/:id/summary', async (req, res) => {
  try {
    const secret = (req.headers['x-api-key'] as string | undefined)
      ?? (new URL(req.url, 'https://localhost').searchParams.get('secret') ?? undefined);
    if (secret !== config.RSS_SECRET) return res.status(401).send('Unauthorized');

    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id <= 0) return res.status(400).send('Invalid article ID — must be a positive integer.');

    logger.info('Summary requested', { articleId: id });

    const article = await getArticleById(id);
    if (!article) return res.status(404).send(`Article with ID ${id} not found.`);

    logger.info('Generating summary', { articleId: id, title: article.title });

    const summary = await summarizeArticleFromUrl(article.url, article.title);
    res.set('Content-Type', 'text/plain; charset=utf-8');
    return res.status(200).send(summary);

  } catch (err) {
    logger.error('Error generating article summary', { error: err instanceof Error ? err.message : String(err) });
    return res.status(500).send('Failed to generate summary. Please try again later.');
  }
});

app.get('/articles/:id/describe', async (req, res) => {
  try {
    const secret = (req.headers['x-api-key'] as string | undefined)
      ?? (new URL(req.url, 'https://localhost').searchParams.get('secret') ?? undefined);
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

export const summarize: HttpFunction = (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  app(req, res);
};
