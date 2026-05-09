import express from 'express';
import { HttpFunction } from '@google-cloud/functions-framework';
import { config } from '../config';
import { logger } from '../logger';
import { getArticleById } from '../db/database';
import { summarizeArticleFromUrl } from '../llm/parser';

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
