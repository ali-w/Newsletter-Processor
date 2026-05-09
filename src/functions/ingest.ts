import express from 'express';
import { HttpFunction } from '@google-cloud/functions-framework';
import { CloudTasksClient } from '@google-cloud/tasks';
import { config } from '../config';
import { logger } from '../logger';

const app = express();
app.use(express.json({ limit: '5mb' }));

app.post('/webhook/cloudmailin', async (req, res) => {
  const secret = (req.headers['x-api-key'] as string | undefined) ?? (req.query.secret as string | undefined);
  if (secret !== config.RSS_SECRET) {
    logger.warn('Unauthorized attempt to post to ingest webhook');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Respond immediately so CloudMailin does not timeout and retry
  res.status(202).json({ status: 'accepted' });

  if (!config.GCP_PROJECT || !config.INGEST_WORKER_URL) {
    logger.error('GCP_PROJECT or INGEST_WORKER_URL not configured — cannot enqueue task');
    return;
  }

  try {
    const client = new CloudTasksClient();
    const parent = client.queuePath(config.GCP_PROJECT, config.GCP_REGION, config.TASKS_QUEUE);

    const task = {
      httpRequest: {
        httpMethod: 'POST' as const,
        url: config.INGEST_WORKER_URL,
        headers: { 'Content-Type': 'application/json' },
        body: Buffer.from(JSON.stringify(req.body)).toString('base64'),
      },
    };

    const [response] = await client.createTask({ parent, task });
    logger.info('Ingest task enqueued', { taskName: response.name });
  } catch (err) {
    logger.error('Failed to enqueue ingest task', { error: err instanceof Error ? err.message : String(err) });
  }
});

export const ingest: HttpFunction = (req, res) => app(req, res);
