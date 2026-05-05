import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

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

  // CloudMailin Configuration (for forwarding emails for review)
  CLOUDMAILIN_USERNAME: z.string().optional(),
  CLOUDMAILIN_API_KEY: z.string().optional(),
  REVIEW_RECIPIENT_EMAIL: z.string().email().optional(),
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  console.error("❌ Invalid environment variables:", parsedEnv.error.format());
  process.exit(1);
}

export const config = parsedEnv.data;
