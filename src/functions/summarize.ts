import express from 'express';
import { HttpFunction } from '@google-cloud/functions-framework';
import { GoogleGenAI, Type, Schema } from '@google/genai';
import { config } from '../config';
import { logger } from '../logger';
import { getArticleById, getDistinctTags, updateArticle, setAiSummary, setArticleSummary, setCachedContent, setPdfProcessingStatus, setOcrText } from '../db/database';
import { summarizeArticleFromUrl, describeArticleFromUrl, fetchRawHtml } from '../llm/parser';
import { uploadHtml, getFileStream, downloadPdf } from '../storage/gcs';
import { parseJsonBody } from './parseBody';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';

const app = express();
app.use(parseJsonBody);

const ai = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });

const pdfOcrAndSummarySchema: Schema = {
  type: Type.OBJECT,
  properties: {
    ocr_text: { type: Type.STRING, description: 'All text extracted verbatim from the PDF' },
    summary: { type: Type.STRING, description: 'A 2–3 paragraph executive summary of the PDF' },
  },
  required: ['ocr_text', 'summary'],
};

async function uploadPdfToGemini(pdfBytes: Buffer): Promise<string> {
  const ab = new ArrayBuffer(pdfBytes.byteLength);
  new Uint8Array(ab).set(pdfBytes);
  const blob = new Blob([ab], { type: 'application/pdf' });
  const file = await ai.files.upload({ file: blob, config: { mimeType: 'application/pdf' } });
  if (!file.uri) throw new Error('Gemini Files API returned no URI');
  return file.uri;
}

app.use((_req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key');
  next();
});
app.options('*', (_req, res) => res.status(204).end());

app.get('/articles/:id/summary', async (req, res) => {
  try {
    const secret = req.headers['x-api-key'] as string | undefined;
    if (secret !== config.RSS_SECRET) return res.status(401).send('Unauthorized');

    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id <= 0) return res.status(400).send('Invalid article ID — must be a positive integer.');

    logger.info('Summary requested', { articleId: id });

    const article = await getArticleById(id);
    if (!article) return res.status(404).send(`Article with ID ${id} not found.`);

    logger.info('Generating summary', { articleId: id, title: article.title });

    let summary: string;
    if (article.content_type === 'pdf') {
      const pdfBytes = await downloadPdf(id);
      const fileUri = await uploadPdfToGemini(pdfBytes);
      const response = await ai.models.generateContent({
        model: config.PDF_MODEL_TYPED,
        contents: [{
          parts: [
            { fileData: { mimeType: 'application/pdf', fileUri } },
            { text: `You are an expert summariser. Write a concise 2-3 paragraph executive summary of this PDF document titled "${article.title}".${article.notes?.trim() ? `\n\nFocus on: ${article.notes.trim()}` : ''}` },
          ],
        }],
      });
      summary = response.text?.trim() ?? '';
    } else {
      summary = await summarizeArticleFromUrl(article.url, article.title, article.notes);
    }
    await setAiSummary(id, summary);
    res.set('Content-Type', 'text/plain; charset=utf-8');
    return res.status(200).send(summary);

  } catch (err) {
    logger.error('Error generating article summary', { error: err instanceof Error ? err.message : String(err) });
    return res.status(500).send('Failed to generate summary. Please try again later.');
  }
});

app.get('/articles/:id/describe', async (req, res) => {
  try {
    const secret = req.headers['x-api-key'] as string | undefined;
    if (secret !== config.RSS_SECRET) return res.status(401).json({ error: 'Unauthorized' });

    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id <= 0) return res.status(400).json({ error: 'Invalid article ID' });

    const [article, existingTags] = await Promise.all([getArticleById(id), getDistinctTags()]);
    if (!article) return res.status(404).json({ error: `Article ${id} not found` });

    logger.info('Describing article', { articleId: id, title: article.title });

    let result: { summary: string; suggestedTag: string };
    if (article.content_type === 'pdf') {
      const pdfBytes = await downloadPdf(id);
      const fileUri = await uploadPdfToGemini(pdfBytes);
      const tagHint = existingTags.length
        ? `Here are existing tags used in the system: ${JSON.stringify(existingTags)}. If one is a strong and specific match for this article's topic, use it. Otherwise invent a new short lowercase hyphenated slug that precisely describes the topic.`
        : 'Invent a short lowercase hyphenated slug tag that precisely describes the topic.';
      const response = await ai.models.generateContent({
        model: config.PDF_MODEL_TYPED,
        contents: [{
          parts: [
            { fileData: { mimeType: 'application/pdf', fileUri } },
            { text: `Write a neutral 1-2 sentence description of this PDF titled "${article.title}". Then ${tagHint}` },
          ],
        }],
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              summary: { type: Type.STRING },
              suggestedTag: { type: Type.STRING },
            },
            required: ['summary', 'suggestedTag'],
          },
        },
      });
      result = JSON.parse(response.text ?? '{}') as { summary: string; suggestedTag: string };
    } else {
      result = await describeArticleFromUrl(article.url, article.title, existingTags);
    }

    await setArticleSummary(id, result.summary);
    if (!article.tags || article.tags.length === 0) {
      await updateArticle(id, { tags: [result.suggestedTag] });
    }

    return res.status(200).json(result);
  } catch (err) {
    logger.error('Error describing article', { error: err instanceof Error ? err.message : String(err) });
    return res.status(500).json({ error: 'Failed to describe article' });
  }
});

const UNCACHEABLE_TYPES = ['video', 'podcast', 'other', 'pdf'];

app.post('/articles/:id/cache', async (req, res) => {
  try {
    const secret = req.headers['x-api-key'] as string | undefined;
    if (secret !== config.RSS_SECRET) return res.status(401).json({ error: 'Unauthorized' });

    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id <= 0) return res.status(400).json({ error: 'Invalid article ID' });

    const article = await getArticleById(id);
    if (!article) return res.status(404).json({ error: `Article ${id} not found` });

    if (UNCACHEABLE_TYPES.includes(article.content_type ?? '')) {
      return res.status(422).json({ error: 'Caching is not supported for this content type' });
    }

    logger.info('Caching article', { articleId: id, url: article.url });

    const html = await fetchRawHtml(article.url);
    const dom = new JSDOM(html, { url: article.url }); 
    const reader = new Readability(dom.window.document);
    const parsed = reader.parse();
    if (!parsed) return res.status(422).json({ error: 'Could not extract article content from page' }); //TODO: handle this better, maybe flag article as uncacheable? 

    const cleanHtml = `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>${parsed.title}</title>
<style>body{max-width:800px;margin:2rem auto;font-family:Georgia,serif;line-height:1.6;padding:0 1rem}h1{font-size:1.5rem}</style>
</head><body><h1>${parsed.title}</h1>${parsed.content}</body></html>`;

    const gcsPath = await uploadHtml(id, cleanHtml);
    const now = new Date().toISOString();
    await setCachedContent(id, gcsPath, now);

    logger.info('Article cached', { articleId: id, gcsPath });
    return res.status(200).json({ cached_content_url: gcsPath, cached_at: now });
  } catch (err) {
    logger.error('Error caching article', { error: err instanceof Error ? err.message : String(err) });
    return res.status(500).json({ error: 'Failed to cache article' });
  }
});

async function suggestAndApplyTag(id: number, title: string, summary: string, existingTags: string[]): Promise<void> {
  try {
    const tagHint = existingTags.length
      ? `Here are existing tags used in the system: ${JSON.stringify(existingTags)}. If one is a strong and specific match for this article's topic, use it. Otherwise invent a new short lowercase hyphenated slug that precisely describes the topic.`
      : 'Invent a short lowercase hyphenated slug tag that precisely describes the topic.';
    const response = await ai.models.generateContent({
      model: config.PDF_MODEL_TYPED,
      contents: `Article title: "${title}"\n\nSummary:\n${summary}\n\n${tagHint} Respond with only the tag, nothing else.`,
    });
    const tag = response.text?.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    if (tag) await updateArticle(id, { tags: [tag] });
  } catch (err) {
    logger.warn('Tag suggestion failed', { articleId: id, error: String(err) });
  }
}

app.post('/articles/:id/process-pdf', async (req, res) => {
  const secret = req.headers['x-api-key'] as string | undefined;
  if (secret !== config.RSS_SECRET) return res.status(401).json({ error: 'Unauthorized' });

  const id = parseInt(req.params.id, 10);
  if (isNaN(id) || id <= 0) return res.status(400).json({ error: 'Invalid article ID' });

  const { pdf_type, extract_ocr, has_summary } = req.body ?? {};
  logger.info('process-pdf request received', { articleId: id, pdf_type, extract_ocr, has_summary });

  try {
    const [article, existingTags] = await Promise.all([getArticleById(id), getDistinctTags()]);
    logger.info('Article loaded', { articleId: id, title: article?.title, extract_ocr, has_summary });

    if (!extract_ocr && has_summary) {
      logger.info('No Gemini processing needed — has summary, OCR not requested', { articleId: id });
      await setPdfProcessingStatus(id, 'done');
      if (article && (!article.tags || article.tags.length === 0) && article.summary) {
        logger.info('Suggesting tag from existing summary', { articleId: id });
        await suggestAndApplyTag(id, article.title, article.summary, existingTags);
        logger.info('Tag suggestion complete', { articleId: id });
      }
      logger.info('PDF processing complete (no Gemini)', { articleId: id });
      return res.status(200).json({ ok: true });
    }

    const modelName = pdf_type === 'handwritten'
      ? config.PDF_MODEL_HANDWRITTEN
      : config.PDF_MODEL_TYPED;

    logger.info('Downloading PDF from GCS', { articleId: id });
    const pdfBytes = await downloadPdf(id);
    logger.info('PDF downloaded, uploading to Gemini Files API', { articleId: id, sizeBytes: pdfBytes.length, model: modelName });
    const fileUri = await uploadPdfToGemini(pdfBytes);
    logger.info('PDF uploaded to Gemini Files API, calling generateContent', { articleId: id, fileUri });
    const pdfData = { fileData: { mimeType: 'application/pdf', fileUri } };

    let generatedSummary: string | null = null;

    if (extract_ocr && !has_summary) {
      logger.info('Extracting OCR text and generating summary', { articleId: id });
      const response = await ai.models.generateContent({
        model: modelName,
        contents: [{ parts: [pdfData, { text: 'Extract all text verbatim from this PDF. Also write a 2-3 paragraph executive summary of its key points.' }] }],
        config: { responseMimeType: 'application/json', responseSchema: pdfOcrAndSummarySchema },
      });
      const parsed = JSON.parse(response.text ?? '{}') as { ocr_text?: string; summary?: string };
      if (parsed.ocr_text) { await setOcrText(id, parsed.ocr_text); logger.info('OCR text saved', { articleId: id, ocrLength: parsed.ocr_text.length }); }
      if (parsed.summary) { await setArticleSummary(id, parsed.summary); generatedSummary = parsed.summary; logger.info('Summary saved', { articleId: id, summaryLength: parsed.summary.length }); }
    } else if (extract_ocr) {
      logger.info('Extracting OCR text only', { articleId: id });
      const response = await ai.models.generateContent({
        model: modelName,
        contents: [{ parts: [pdfData, { text: 'Extract all text verbatim from this PDF.' }] }],
      });
      if (response.text) { await setOcrText(id, response.text.trim()); logger.info('OCR text saved', { articleId: id, ocrLength: response.text.length }); }
    } else {
      logger.info('Generating summary only', { articleId: id });
      const response = await ai.models.generateContent({
        model: modelName,
        contents: [{ parts: [pdfData, { text: 'Write a 2-3 paragraph executive summary of this PDF document\'s key points.' }] }],
      });
      if (response.text) { await setArticleSummary(id, response.text.trim()); generatedSummary = response.text.trim(); logger.info('Summary saved', { articleId: id, summaryLength: response.text.length }); }
    }

    if (article && (!article.tags || article.tags.length === 0) && generatedSummary) {
      logger.info('Suggesting tag from generated summary', { articleId: id });
      await suggestAndApplyTag(id, article.title, generatedSummary, existingTags);
      logger.info('Tag suggestion complete', { articleId: id });
    }

    await setPdfProcessingStatus(id, 'done');
    logger.info('PDF processing complete', { articleId: id });
    return res.status(200).json({ ok: true });
  } catch (err) {
    logger.error('PDF processing failed', { articleId: id, error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined, cause: err instanceof Error && err.cause ? String(err.cause) : undefined });
    await setPdfProcessingStatus(id, 'error').catch(() => {});
    return res.status(500).json({ error: 'PDF processing failed' });
  }
});

app.get('/articles/:id/cached-content', async (req, res) => {
  try {
    const secret = (req.headers['x-api-key'] as string | undefined)
      ?? (new URL(req.url, 'https://localhost').searchParams.get('secret') ?? undefined);
    if (secret !== config.RSS_SECRET) return res.status(401).json({ error: 'Unauthorized' });

    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id <= 0) return res.status(400).json({ error: 'Invalid article ID' });

    const article = await getArticleById(id);
    if (!article) return res.status(404).json({ error: `Article ${id} not found` });
    if (article.content_type === 'pdf') {
      return res.status(404).json({ error: 'Use GET /articles/:id/pdf for PDF content' });
    }
    if (!article.cached_content_url) return res.status(404).json({ error: 'No cached content for this article' });

    const stream = getFileStream(article.cached_content_url);
    res.set('Content-Type', 'text/html; charset=utf-8');
    stream.on('error', (err) => {
      logger.error('GCS stream error', { error: err.message, gcsPath: article.cached_content_url });
      if (!res.headersSent) res.status(500).json({ error: 'Failed to read cached content' });
    });
    stream.pipe(res);
  } catch (err) {
    logger.error('Error retrieving cached content', { error: err instanceof Error ? err.message : String(err) });
    return res.status(500).json({ error: 'Failed to retrieve cached content' });
  }
});

export const summarize: HttpFunction = (req, res) => app(req, res);
