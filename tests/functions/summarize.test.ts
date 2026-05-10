import request from 'supertest';
import { Readable } from 'stream';

const mockGetArticleById = jest.fn();
const mockGetDistinctTags = jest.fn().mockResolvedValue(['ai', 'security']);
const mockUpdateArticle = jest.fn().mockResolvedValue('2026-05-09T12:00:00.000Z');
const mockSetAiSummary = jest.fn().mockResolvedValue(undefined);
const mockSetArticleSummary = jest.fn().mockResolvedValue(undefined);
const mockSetCachedContent = jest.fn().mockResolvedValue(undefined);
const mockSummarizeArticleFromUrl = jest.fn();
const mockDescribeArticleFromUrl = jest.fn();
const mockFetchRawHtml = jest.fn();
const mockUploadHtml = jest.fn();
const mockGetFileStream = jest.fn();

jest.mock('../../src/db/database', () => ({
  getArticleById: mockGetArticleById,
  getDistinctTags: mockGetDistinctTags,
  updateArticle: mockUpdateArticle,
  setAiSummary: mockSetAiSummary,
  setArticleSummary: mockSetArticleSummary,
  setCachedContent: mockSetCachedContent,
}));

jest.mock('../../src/llm/parser', () => ({
  summarizeArticleFromUrl: mockSummarizeArticleFromUrl,
  describeArticleFromUrl: mockDescribeArticleFromUrl,
  fetchRawHtml: mockFetchRawHtml,
}));

jest.mock('../../src/storage/gcs', () => ({
  uploadHtml: mockUploadHtml,
  getFileStream: mockGetFileStream,
}));

import { summarize } from '../../src/functions/summarize';

const SECRET = 'test_secret_123';
const sampleArticle = {
  id: 1,
  title: 'Test Article',
  url: 'https://example.com/test',
  notes: '',
  tags: [],
  content_type: 'article',
  cached_content_url: null,
};
// Minimal HTML that Readability can parse for cache tests
const fetchedHtml = `<html><head><title>Test Article</title></head>
<body><article><h1>Test Article</h1><p>This is a paragraph with enough content for Readability to extract successfully.</p></article></body></html>`;

describe('summarize function', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetArticleById.mockResolvedValue(sampleArticle);
    mockSummarizeArticleFromUrl.mockResolvedValue('Executive summary text.');
    mockDescribeArticleFromUrl.mockResolvedValue({ summary: 'AI description', suggestedTag: 'ai' });
    mockFetchRawHtml.mockResolvedValue(fetchedHtml);
    mockUploadHtml.mockResolvedValue('gs://test-bucket/articles/1.html');
    mockGetFileStream.mockReturnValue(Readable.from(['<html>cached content</html>']));
  });

  // ---------------------------------------------------------------------------
  // GET /articles/:id/summary
  // ---------------------------------------------------------------------------

  describe('GET /articles/:id/summary', () => {
    it('returns 401 without auth', async () => {
      await request(summarize as any).get('/articles/1/summary').expect(401);
    });

    it('returns 400 for a non-numeric article ID', async () => {
      await request(summarize as any)
        .get('/articles/abc/summary').set('X-Api-Key', SECRET).expect(400);
    });

    it('returns 404 when the article does not exist', async () => {
      mockGetArticleById.mockResolvedValueOnce(null);
      await request(summarize as any)
        .get('/articles/99/summary').set('X-Api-Key', SECRET).expect(404);
    });

    it('returns 200 with a plain text summary', async () => {
      const res = await request(summarize as any)
        .get('/articles/1/summary').set('X-Api-Key', SECRET).expect(200);
      expect(res.headers['content-type']).toMatch(/text\/plain/);
      expect(res.text).toBe('Executive summary text.');
      expect(mockSummarizeArticleFromUrl).toHaveBeenCalledWith(
        sampleArticle.url, sampleArticle.title, sampleArticle.notes,
      );
    });

    it('returns 500 when the LLM call fails', async () => {
      mockSummarizeArticleFromUrl.mockRejectedValueOnce(new Error('LLM unavailable'));
      await request(summarize as any)
        .get('/articles/1/summary').set('X-Api-Key', SECRET).expect(500);
    });
  });

  // ---------------------------------------------------------------------------
  // GET /articles/:id/describe
  // ---------------------------------------------------------------------------

  describe('GET /articles/:id/describe', () => {
    it('returns 401 without auth', async () => {
      await request(summarize as any).get('/articles/1/describe').expect(401);
    });

    it('returns 400 for a non-numeric article ID', async () => {
      await request(summarize as any)
        .get('/articles/abc/describe').set('X-Api-Key', SECRET).expect(400);
    });

    it('returns 404 when the article does not exist', async () => {
      mockGetArticleById.mockResolvedValueOnce(null);
      await request(summarize as any)
        .get('/articles/99/describe').set('X-Api-Key', SECRET).expect(404);
    });

    it('returns 200 with description and suggested tag', async () => {
      const res = await request(summarize as any)
        .get('/articles/1/describe').set('X-Api-Key', SECRET).expect(200);
      expect(res.body.summary).toBe('AI description');
      expect(res.body.suggestedTag).toBe('ai');
    });

    it('writes the summary and suggested tag back to the article', async () => {
      await request(summarize as any)
        .get('/articles/1/describe').set('X-Api-Key', SECRET).expect(200);
      expect(mockSetArticleSummary).toHaveBeenCalledWith(1, 'AI description');
      // article has no existing tags, so the suggestedTag is patched in
      expect(mockUpdateArticle).toHaveBeenCalledWith(1, { tags: ['ai'] });
    });
  });

  // ---------------------------------------------------------------------------
  // POST /articles/:id/cache
  // ---------------------------------------------------------------------------

  describe('POST /articles/:id/cache', () => {
    it('returns 401 without auth', async () => {
      await request(summarize as any).post('/articles/1/cache').expect(401);
    });

    it('returns 400 for a non-numeric article ID', async () => {
      await request(summarize as any)
        .post('/articles/abc/cache').set('X-Api-Key', SECRET).expect(400);
    });

    it('returns 404 when the article does not exist', async () => {
      mockGetArticleById.mockResolvedValueOnce(null);
      await request(summarize as any)
        .post('/articles/99/cache').set('X-Api-Key', SECRET).expect(404);
    });

    it('returns 422 for uncacheable content types (video, podcast, other)', async () => {
      for (const ct of ['video', 'podcast', 'other']) {
        mockGetArticleById.mockResolvedValueOnce({ ...sampleArticle, content_type: ct });
        await request(summarize as any)
          .post('/articles/1/cache').set('X-Api-Key', SECRET).expect(422);
      }
    });

    it('fetches, parses, uploads, and returns the cached URL', async () => {
      const res = await request(summarize as any)
        .post('/articles/1/cache').set('X-Api-Key', SECRET).expect(200);
      expect(mockFetchRawHtml).toHaveBeenCalledWith(sampleArticle.url);
      expect(mockUploadHtml).toHaveBeenCalledWith(1, expect.stringContaining('<!DOCTYPE html>'));
      expect(res.body.cached_content_url).toBe('gs://test-bucket/articles/1.html');
      expect(res.body.cached_at).toBeDefined();
    });

    it('updates the article record with the cached URL and timestamp', async () => {
      await request(summarize as any)
        .post('/articles/1/cache').set('X-Api-Key', SECRET).expect(200);
      expect(mockSetCachedContent).toHaveBeenCalledWith(
        1, 'gs://test-bucket/articles/1.html', expect.any(String),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // GET /articles/:id/cached-content
  // ---------------------------------------------------------------------------

  describe('GET /articles/:id/cached-content', () => {
    const articleWithCache = { ...sampleArticle, cached_content_url: 'gs://test-bucket/articles/1.html' };

    it('returns 401 without auth', async () => {
      await request(summarize as any).get('/articles/1/cached-content').expect(401);
    });

    it('returns 400 for a non-numeric article ID', async () => {
      await request(summarize as any)
        .get('/articles/abc/cached-content').set('X-Api-Key', SECRET).expect(400);
    });

    it('returns 404 when the article does not exist', async () => {
      mockGetArticleById.mockResolvedValueOnce(null);
      await request(summarize as any)
        .get('/articles/99/cached-content').set('X-Api-Key', SECRET).expect(404);
    });

    it('returns 404 when no cached content URL is stored', async () => {
      // sampleArticle has cached_content_url: null
      await request(summarize as any)
        .get('/articles/1/cached-content').set('X-Api-Key', SECRET).expect(404);
    });

    it('streams cached HTML with text/html content type', async () => {
      mockGetArticleById.mockResolvedValueOnce(articleWithCache);
      const res = await request(summarize as any)
        .get('/articles/1/cached-content').set('X-Api-Key', SECRET).expect(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.text).toBe('<html>cached content</html>');
    });

    it('accepts ?secret query param as fallback', async () => {
      mockGetArticleById.mockResolvedValueOnce(articleWithCache);
      const res = await request(summarize as any)
        .get(`/articles/1/cached-content?secret=${SECRET}`).expect(200);
      expect(res.text).toBe('<html>cached content</html>');
    });
  });
});
