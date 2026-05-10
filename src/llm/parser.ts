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

export async function fetchRawHtml(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; NewsletterProcessor/1.0)',
      'Accept': 'text/html,application/xhtml+xml',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  return response.text();
}

async function fetchArticleContent(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; NewsletterProcessor/1.0)',
      'Accept': 'text/html,application/xhtml+xml',
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  const html = await response.text();
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .substring(0, 100_000);
}

const describeSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    summary: { type: Type.STRING, description: 'A 1–2 sentence neutral description of the article' },
    suggestedTag: { type: Type.STRING, description: 'A single lowercase tag or slug for the article' },
  },
  required: ['summary', 'suggestedTag'],
};

export async function describeArticleFromUrl(
  url: string,
  title: string,
  existingTags: string[],
): Promise<{ summary: string; suggestedTag: string }> {
  logger.info('Fetching article content for describe', { url });

  let articleContent: string;
  try {
    articleContent = await fetchArticleContent(url);
  } catch (err) {
    throw new Error(`Failed to fetch article at ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const tagHint = existingTags.length
    ? `Choose the single best tag from this list: ${JSON.stringify(existingTags)}. If none fit, invent a short lowercase hyphenated slug.`
    : `Invent a short lowercase hyphenated slug tag that describes the topic.`;

  const prompt = `Article title: "${title}"

Article content:
${articleContent}

Write a neutral 1–2 sentence description of what this article is about. Then ${tagHint}`;

  logger.info('Requesting article description from Gemini', { title });

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: describeSchema,
          temperature: 0.2,
        },
      });

      const text = response.text;
      if (!text) throw new Error('Empty response from Gemini');

      const result = JSON.parse(text) as { summary: string; suggestedTag: string };
      logger.info(`Description generated on attempt ${attempt}/${MAX_RETRIES}`);
      return result;
    } catch (error) {
      lastError = error;
      if (attempt < MAX_RETRIES) {
        const waitMs = Math.min(Math.pow(2, attempt) * 1000 + Math.random() * 1000, MAX_WAIT_MS);
        logger.error(`Describe attempt ${attempt}/${MAX_RETRIES} failed`, {
          error: error instanceof Error ? error.message : String(error),
          retryInMs: waitMs,
        });
        await sleep(waitMs);
      } else {
        logger.error(`Describe failed on final attempt ${attempt}/${MAX_RETRIES}`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  throw lastError;
}

export async function summarizeArticleFromUrl(url: string, title: string, notes?: string): Promise<string> {
  logger.info('Fetching article content', { url });

  let articleContent: string;
  try {
    articleContent = await fetchArticleContent(url);
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
${notes?.trim() ? `
The reader has added these personal notes about this article:
"${notes.trim()}"

Use these notes to focus and shape your summary — prioritise the aspects of the article most relevant to what the reader has highlighted.
` : ''}
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
