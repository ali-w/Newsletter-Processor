import express from 'express';
import { MessageClient } from 'cloudmailin';
import { config } from '../config';
import { extractArticles, summarizeArticleFromUrl } from '../llm/parser';
import { insertNewsletter, insertArticle, getLatestArticles, getArticleById } from '../db/database';
import { generateRssFeed } from '../rss/generator';

export const app = express();

app.use(express.json({ limit: '5mb' }));

// RSS Feed Endpoint (Protected by secret)
app.get('/rss', async (req, res) => {
  try {
    const { secret, limit } = req.query;

    if (secret !== config.RSS_SECRET) {
      return res.status(401).send('Unauthorized');
    }

    const defaultLimit = 30;
    const parsedLimit = limit ? parseInt(limit as string, 10) : defaultLimit;
    const safeLimit = isNaN(parsedLimit) || parsedLimit <= 0 ? defaultLimit : Math.min(parsedLimit, 30);

    const articles = await getLatestArticles(safeLimit);
    const xml = generateRssFeed(articles as any[]);

    res.set('Content-Type', 'application/rss+xml');
    res.send(xml);
  } catch (err) {
    console.error("❌ Error generating RSS feed:", err);
    res.status(500).send('Internal Server Error');
  }
});

/**
 * CloudMailin Webhook Endpoint
 * Expects CloudMailin JSON Normalized payload.
 * POST /webhook/cloudmailin?secret=YOUR_SECRET
 */
app.post('/webhook/cloudmailin', async (req, res) => {
  try {
    const { secret } = req.query;

    if (secret !== config.RSS_SECRET) {
      console.warn("⚠️  Unauthorized attempt to post to webhook.");
      return res.status(401).json({ status: "error", message: "Unauthorized" });
    }

    const payload = req.body;

    // Extract metadata from CloudMailin JSON Normalized format
    const senderName = payload.envelope?.from || payload.headers?.From || 'Unknown Sender';
    const receivedAtStr = payload.headers?.Date;
    const receivedAt = receivedAtStr ? new Date(receivedAtStr) : new Date();
    const content = payload.html || payload.plain || '';

    if (!content) {
      console.warn(`⚠️  Received empty content from "${senderName}".`);
      return res.status(400).json({ status: "error", message: "No content found in email" });
    }

    console.log(`🚀 Processing incoming newsletter from "${senderName}"...`);

    // Extract articles via LLM
    const articles = await extractArticles(content);

    if (articles.length === 0) {
      console.log(`⚠️  No articles extracted from newsletter by "${senderName}".`);
      // Forward for manual review if CloudMailin is configured
      if (config.CLOUDMAILIN_USERNAME && config.CLOUDMAILIN_API_KEY && config.REVIEW_RECIPIENT_EMAIL) {
        try {
          console.log(`✉️  Forwarding newsletter from "${senderName}" for manual review...`);
          const client = new MessageClient({
            username: config.CLOUDMAILIN_USERNAME,
            apiKey: config.CLOUDMAILIN_API_KEY
          });
          await client.sendMessage({
            to: config.REVIEW_RECIPIENT_EMAIL,
            from: 'newsletter-processor@cloudmailin.net',
            subject: `Manual Review Required: Newsletter from ${senderName}`,
            plain: payload.plain || 'No plain text content available.',
            html: payload.html || content
          });
          console.log(`✅ Forwarded to ${config.REVIEW_RECIPIENT_EMAIL}`);
        } catch (forwardErr) {
          console.error(`❌ Failed to forward email:`, forwardErr);
        }
      }

      return res.status(200).json({ status: "success", message: "No articles found" });
    }

    // Store in DB
    const newsletterId = await insertNewsletter(senderName, receivedAt);

    for (const article of articles) {
      await insertArticle(newsletterId, article);
    }

    console.log(`✅ Saved ${articles.length} article(s) from "${senderName}".`);

    return res.status(200).json({
      status: "success",
      message: `Successfully processed newsletter with ${articles.length} articles.`,
    });

  } catch (err) {
    console.error("❌ Error processing CloudMailin webhook:", err instanceof Error ? err.message : err);
    return res.status(500).json({ status: "error", message: "Internal server error during processing" });
  }
});

// Article Summarization Endpoint
// GET /summarize/:id?secret=<RSS_SECRET>
// Returns a plain-text executive summary of the article at its stored URL,
// suitable for sharing in Microsoft Teams with Agility Leads / HR / Op Model owners.
app.get('/summarize/:id', async (req, res) => {
  try {
    const { secret } = req.query;
    if (secret !== config.RSS_SECRET) {
      return res.status(401).send('Unauthorized');
    }

    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id <= 0) {
      return res.status(400).send('Invalid article ID — must be a positive integer.');
    }

    console.log(`📝 Summary requested for article ID: ${id}`);

    const article = await getArticleById(id);
    if (!article) {
      return res.status(404).send(`Article with ID ${id} not found.`);
    }

    console.log(`📄 Found article: "${article.title}" — ${article.url}`);

    const summary = await summarizeArticleFromUrl(article.url, article.title);

    res.set('Content-Type', 'text/plain; charset=utf-8');
    return res.status(200).send(summary);

  } catch (err) {
    console.error("❌ Error generating article summary:", err instanceof Error ? err.message : err);
    return res.status(500).send('Failed to generate summary. Please try again later.');
  }
});
