import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  // Mail Configuration (IMAP but using existing POP3 names for convenience)
  POP3_HOST: z.string(),
  POP3_PORT: z.coerce.number().default(993), // IMAP default
  POP3_USERNAME: z.string(),
  POP3_PASSWORD: z.string(),
  POP3_TLS: z.preprocess((val) => val === 'true' || val === true, z.boolean().default(true)),

  // LLM Configuration
  GEMINI_API_KEY: z.string(),

  // Database Configuration (Turso)
  TURSO_DATABASE_URL: z.string().url(),
  TURSO_AUTH_TOKEN: z.string(),

  // API Configuration
  RSS_SECRET: z.string().min(8),
  PORT: z.coerce.number().default(8080),
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  console.error("❌ Invalid environment variables:", parsedEnv.error.format());
  process.exit(1);
}

export const config = parsedEnv.data;
