import express from 'express';
import { HttpFunction } from '@google-cloud/functions-framework';
import { MessageClient } from 'cloudmailin';
import { config } from '../config';
import { logger } from '../logger';
import { extractArticles } from '../llm/parser';
import { insertNewsletter, insertArticle, getTagForEmail } from '../db/database';
import { parseJsonBody } from './parseBody';

const app = express();
app.use(parseJsonBody);

app.post('/', async (req, res) => {
  // Cloud Tasks sets this header — confirms the request originated from the queue
  if (!req.headers['x-cloudtasks-taskname']) {
    logger.warn('Request missing X-CloudTasks-TaskName header — rejecting');
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Respond 200 immediately so Cloud Tasks marks the task done;
  // processing continues after the response is sent.
  res.status(200).json({ status: 'processing' });

  const payload = req.body;
  // headers.From is "Display Name <email>" — more stable than envelope.from which is a garbled bounce address
  const rawFrom = String(payload.headers?.From ?? payload.envelope?.from ?? '');
  const angleMatch = rawFrom.match(/<([^>]+)>/);
  const senderEmail = (angleMatch ? angleMatch[1] : rawFrom).toLowerCase().trim();
  const senderName = angleMatch
    ? rawFrom.replace(/<[^>]+>/, '').trim().replace(/^"|"$/g, '').trim() || senderEmail
    : senderEmail || 'Unknown Sender';
  const receivedAtStr = payload.headers?.Date;
  const receivedAt = receivedAtStr ? new Date(receivedAtStr) : new Date();
  const content = payload.html || payload.plain || '';

  if (!content) {
    logger.warn('Ingest worker received empty content', { sender: senderName });
    return;
  }

  logger.info('Ingest worker processing newsletter', { sender: senderName });

  try {
    const articles = await extractArticles(content);

    if (articles.length === 0) {
      logger.warn('No articles extracted', { sender: senderName });

      if (config.CLOUDMAILIN_USERNAME && config.CLOUDMAILIN_API_KEY && config.REVIEW_RECIPIENT_EMAIL) {
        try {
          const client = new MessageClient({
            username: config.CLOUDMAILIN_USERNAME,
            apiKey: config.CLOUDMAILIN_API_KEY,
          });
          await client.sendMessage({
            to: config.REVIEW_RECIPIENT_EMAIL,
            from: 'newsletterprocessing-fail@infinitefunk.co.uk',
            subject: `Manual Review Required: Newsletter from ${senderName}`,
            plain: payload.plain || 'No plain text content available.',
            html: payload.html || content,
          });
          logger.info('Forwarded for manual review', { recipient: config.REVIEW_RECIPIENT_EMAIL });
        } catch (forwardErr) {
          logger.error('Failed to forward email', { error: String(forwardErr) });
        }
      }
      return;
    }

    const newsletterId = await insertNewsletter(senderName, senderEmail, receivedAt);
    const autoTag = senderEmail ? await getTagForEmail(senderEmail) : null;
    for (const article of articles) {
      const tags = autoTag ? [autoTag] : [];
      await insertArticle(newsletterId, { ...article, tags });
    }

    logger.info('Saved articles from newsletter', { sender: senderName, count: articles.length });
  } catch (err) {
    logger.error('Ingest worker failed', { sender: senderName, error: err instanceof Error ? err.message : String(err) });
    // Cloud Tasks already received 200 — log the error but do not retry from here
  }
});

export const ingestWorker: HttpFunction = (req, res) => app(req, res);
