import express from 'express';
import { config } from '../config';
import { processEmails } from '../pop3/client';
import { extractArticles, summarizeArticleFromUrl } from '../llm/parser';
import { insertNewsletter, insertArticle, getLatestArticles, getArticleById } from '../db/database';
import { generateRssFeed } from '../rss/generator';

export const app = express();

app.use(express.json());

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

// Processing Trigger Endpoint
// In production, this can be triggered by Cloud Scheduler or manually in a browser.
app.get('/process', async (req, res) => {
  try {
    const { secret } = req.query;
    // Also allow secret in body for convenience with POST requests
    const providedSecret = secret || req.body?.secret;

    if (providedSecret !== config.RSS_SECRET) {
      console.warn("⚠️  Unauthorized attempt to trigger processing.");
      return res.status(401).json({ status: "error", message: "Unauthorized" });
    }

    console.log("🚀 Triggered newsletter processing...");

    const result = await processEmails(async (email) => {
      console.log(`🔍 Extracting articles for newsletter from "${email.senderName}"...`);

      // Extract articles via LLM (retries internally with exponential backoff)
      const articles = await extractArticles(email.content);

      if (articles.length === 0) {
        console.log(`⚠️  No articles extracted from newsletter by "${email.senderName}". Skipping DB insert.`);
        return;
      }

      // Store in DB
      const newsletterId = await insertNewsletter(email.senderName, email.receivedAt);

      for (const article of articles) {
        await insertArticle(newsletterId, article);
      }

      console.log(`✅ Saved ${articles.length} article(s) from "${email.senderName}".`);
    });

    const { processed, failed, failedSenders } = result;

    if (processed === 0 && failed === 0) {
      return res.status(200).json({ status: "success", message: "No new emails found" });
    }

    if (failed > 0) {
      // Some emails failed — report a 500 so Cloud Scheduler knows to retry the job
      console.error(
        `⚠️  Processing completed with ${failed} failure(s). ` +
        `Failed senders: ${failedSenders.join(', ')}. ` +
        `${processed} email(s) processed successfully.`
      );
      return res.status(500).json({
        status: "partial_failure",
        message: `${processed} email(s) processed successfully, ${failed} failed.`,
        failedSenders,
      });
    }

    return res.status(200).json({
      status: "success",
      message: `Successfully processed ${processed} email(s).`,
    });

  } catch (err) {
    // Unexpected / fatal error (e.g. POP3 connection failure)
    console.error("❌ Fatal error during processing:", err instanceof Error ? err.message : err);
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
