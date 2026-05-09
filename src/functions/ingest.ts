import express from 'express';
import { HttpFunction, Request as FnRequest } from '@google-cloud/functions-framework';
import { CloudTasksClient } from '@google-cloud/tasks';
import { config } from '../config';
import { logger } from '../logger';
import { parseJsonBody } from './parseBody';

const app = express();
app.use(parseJsonBody);

// Initialised once at module load; fallback:true uses REST instead of gRPC,
// avoiding gRPC name-resolution timeouts in Cloud Run cold starts.
const tasksClient = new CloudTasksClient({ fallback: true });

app.post('/webhook/cloudmailin', async (req, res) => {
  const parsedUrl = new URL(req.url, 'https://localhost');
  const secret = parsedUrl.searchParams.get('secret');
  if (secret !== config.RSS_SECRET) {
    logger.warn('Unauthorized attempt to post to ingest webhook');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!config.GCP_PROJECT || !config.INGEST_WORKER_URL) {
    logger.error('GCP_PROJECT or INGEST_WORKER_URL not configured - cannot enqueue task');
    return res.status(500).json({ error: 'Service misconfigured' });
  }

  try {
    const parent = tasksClient.queuePath(config.GCP_PROJECT, config.GCP_REGION, config.TASKS_QUEUE);

    const task = {
      httpRequest: {
        httpMethod: 'POST' as const,
        url: config.INGEST_WORKER_URL,
        headers: { 'Content-Type': 'application/json' },
        body: Buffer.from(JSON.stringify(req.body)).toString('base64'),
      },
    };

    const [response] = await tasksClient.createTask({ parent, task });
    logger.info('Ingest task enqueued', { taskName: response.name });
    return res.status(202).json({ status: 'accepted' });
  } catch (err) {
    logger.error('Failed to enqueue ingest task', { error: err instanceof Error ? err.message : String(err) });
    return res.status(500).json({ error: 'Failed to enqueue task' });
  }
});

export const ingest: HttpFunction = (req, res) => app(req, res);
