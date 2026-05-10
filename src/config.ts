import { z } from 'zod';
import dotenv from 'dotenv';

if (process.env.NODE_ENV !== 'test') dotenv.config();

const envSchema = z.object({
  // LLM Configuration
  GEMINI_API_KEY: z.string(),

  // Database Configuration (Turso)
  TURSO_DATABASE_URL: z.string().url(),
  TURSO_AUTH_TOKEN: z.string(),

  // API Configuration
  RSS_SECRET: z.string().min(8),
  PORT: z.coerce.number().default(8080),
  SERVICE_URL: z.string().url(),

  // Article limit cap (default 50, max enforced in code at 200)
  ARTICLES_MAX_LIMIT: z.coerce.number().default(200),

  // CloudMailin Configuration (for forwarding emails for review)
  CLOUDMAILIN_USERNAME: z.string().optional(),
  CLOUDMAILIN_API_KEY: z.string().optional(),
  REVIEW_RECIPIENT_EMAIL: z.string().email().optional(),

  // GCP Cloud Functions — async ingest worker
  GCP_PROJECT: z.string().optional(),
  GCP_REGION: z.string().default('europe-west1'),
  TASKS_QUEUE: z.string().default('newsletter-ingest'),
  INGEST_WORKER_URL: z.string().url().optional(),

  // GCS article cache bucket (used by summarize function)
  GCS_BUCKET: z.string().optional(),

  // Summarize function URL (used by reader-api to trigger auto-cache on save)
  SUMMARIZE_URL: z.string().url().optional(),
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  console.error("❌ Invalid environment variables:", parsedEnv.error.format());
  process.exit(1);
}

export const config = parsedEnv.data;
