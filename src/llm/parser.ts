import { GoogleGenAI, Type, Schema } from '@google/genai';
import { config } from '../config';
import { logger } from '../logger';
import { Article } from '../db/database';

const ai = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });

const GEMINI_MODEL = 'gemini-2.5-flash-lite';
const MAX_RETRIES = 4;
const MAX_WAIT_MS = 120_000; // 2 minutes

const articleSchema: Schema = {
  type: Type.ARRAY,
  description: "A list of valid articles extracted from the newsletter",
  items: {
    type: Type.OBJECT,
    properties: {
      title: {
        type: Type.STRING,
        description: "The title of the article",
      },
      summary: {
        type: Type.STRING,
        description: "A 2-3 sentence summary of the article",
      },
      url: {
        type: Type.STRING,
        description: "The primary URL/link for the article",
      },
    },
    required: ["title", "summary", "url"],
  },
};

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function extractArticles(newsletterContent: string): Promise<Article[]> {
  const prompt = `
    You are an expert content extractor. Given the following email newsletter content, extract all the genuine articles or news items.
    
    Rules:
    1. Extract the Title, a short Summary, and the URL for each article.
    2. Ignore advertisements, sponsored content, internal promotional messages, and administrative footer links (like unsubscribe).
    3. If an article doesn't have a URL, you can omit it unless it's a major standalone piece of news.
    
    Newsletter Content:
    ${newsletterContent.substring(0, 300000)}
    `;
  /*
      
      For articles that directly cover the key topics I'm interested in, highlight the title with a ** before and after the title.
      
      Key Topics:
      - Engineering Management, the Invidivual Contributor vs Team Manager, 
      - Changing Skills for Engineers,
      - Engineering Organisational structures, 
      - The changing role of engineers with AI, 
      - Future Operating Models, 
      - Evolution of Site Reliability Engineering and Live Service, including build to run/operate
      
      */

  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      logger.info(`LLM extraction attempt ${attempt}/${MAX_RETRIES}`);

      const response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: articleSchema,
          temperature: 0.1, // Low temperature for deterministic extraction
        }
      });

      const textOutput = response.text;
      if (!textOutput) {
        logger.warn('No text returned from Gemini — treating as empty result');
        return [];
      }

      const articles: Article[] = JSON.parse(textOutput);
      logger.info(`LLM extraction succeeded on attempt ${attempt}/${MAX_RETRIES}`, { articleCount: articles.length });
      return articles;

    } catch (error) {
      lastError = error;

      if (attempt < MAX_RETRIES) {
        // Exponential backoff: 2^attempt seconds + random jitter (0–1s), capped at 2 minutes
        const baseDelay = Math.pow(2, attempt) * 1000;
        const jitter = Math.random() * 1000;
        const waitMs = Math.min(baseDelay + jitter, MAX_WAIT_MS);

        logger.error(`LLM extraction failed on attempt ${attempt}/${MAX_RETRIES}`, {
          error: error instanceof Error ? error.message : String(error),
          retryInMs: waitMs,
        });
        await sleep(waitMs);
      } else {
        logger.error(`LLM extraction failed on final attempt ${attempt}/${MAX_RETRIES}`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  throw lastError;
}

/**
 * Fetches the article at `url`, sends its content to Gemini and returns a
 * plain-text executive summary suitable for sharing in Microsoft Teams with
 * an Agility Leads / HR / Operating Model leadership audience.
 */
export async function summarizeArticleFromUrl(url: string, title: string): Promise<string> {
  logger.info('Fetching article content', { url });

  let articleContent: string;
  try {
    const response = await fetch(url, {
      headers: {
        // Appear as a standard browser to avoid bot-blocking
        'User-Agent': 'Mozilla/5.0 (compatible; NewsletterProcessor/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(15_000), // 15s page-fetch timeout
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    // Strip HTML tags to reduce noise in the prompt
    const html = await response.text();
    articleContent = html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim()
      .substring(0, 100_000); // cap at ~100k chars; well within Gemini's context
  } catch (err) {
    throw new Error(`Failed to fetch article at ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const prompt = `You are an expert technology and organisational strategy thought leader working for a CTO.

Be professional but conversational—clear and direct without being stiff or corporate.

Communication style:
  Use contractions naturally
  Be clear and direct, but friendly
  Vary your response structure
  Show expertise without being condescending/
  Use professional language without jargon.
  Avoid corporate buzzwords, overly formal language, and generic professional phrases.
  Keep formatting simple, no bold text.

Create a short, informal summary (2-3 short paragraphs) of the article below.

The summary will be shared in Microsoft Teams with a senior leadership team of an Agile practice that includes:
- Business Agility Leads
- HR Business Partners
- Operating Model Owners for Product, Agile and Engineering

Call out the KEY POINTS and their IMPLICATIONS specifically for any of these areas:
1. Engineering structures, job families or roles
2. Agile Delivery / Product Leadership
3. Software Engineering Leadership
4. The future of engineering (including the impact of AI on engineers)

Keep the tone professional, insightful and direct.

Article title: ${title}
Article URL: ${url}

Article content:
${articleContent}
`;

  logger.info('Requesting executive summary from Gemini', { title });

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: prompt,
        config: {
          temperature: 0.4, // slightly more creative for editorial writing
        },
      });

      const text = response.text;
      if (!text) throw new Error('Empty response from Gemini');

      logger.info(`Summary generated on attempt ${attempt}/${MAX_RETRIES}`);
      return text.trim();

    } catch (error) {
      lastError = error;
      if (attempt < MAX_RETRIES) {
        const waitMs = Math.min(Math.pow(2, attempt) * 1000 + Math.random() * 1000, MAX_WAIT_MS);
        logger.error(`Summary attempt ${attempt}/${MAX_RETRIES} failed`, {
          error: error instanceof Error ? error.message : String(error),
          retryInMs: waitMs,
        });
        await sleep(waitMs);
      } else {
        logger.error(`Summary failed on final attempt ${attempt}/${MAX_RETRIES}`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  throw lastError;
}
