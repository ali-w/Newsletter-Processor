import request from 'supertest';

const mockGetLatestArticles = jest.fn();
const mockUpdateArticle = jest.fn();
const mockUpdateArticles = jest.fn();
const mockCreateManualArticle = jest.fn();
const mockGenerateRssFeed = jest.fn();

jest.mock('../../src/db/database', () => ({
  getLatestArticles: mockGetLatestArticles,
  updateArticle: mockUpdateArticle,
  updateArticles: mockUpdateArticles,
  createManualArticle: mockCreateManualArticle,
}));

jest.mock('../../src/rss/generator', () => ({
  generateRssFeed: mockGenerateRssFeed,
}));

import { readerApi } from '../../src/functions/reader-api';

const SECRET = 'test_secret_123';
const sampleArticle = {
  id: 1, title: 'Test Article', summary: 'A summary',
  url: 'https://example.com/test', status: 'unread', rating: null, notes: '',
};

describe('readerApi function', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetLatestArticles.mockResolvedValue([sampleArticle]);
    mockUpdateArticle.mockResolvedValue('2026-05-09T12:00:00.000Z');
    mockUpdateArticles.mockResolvedValue({ succeeded: [], failed: [] });
    mockCreateManualArticle.mockResolvedValue(sampleArticle);
    mockGenerateRssFeed.mockReturnValue('<?xml version="1.0"?><rss version="2.0"></rss>');
  });

  // ---------------------------------------------------------------------------
  // GET /articles
  // ---------------------------------------------------------------------------

  describe('GET /articles', () => {
    it('returns 401 without auth', async () => {
      await request(readerApi as any).get('/articles').expect(401);
    });

    it('returns 401 with a wrong X-Api-Key', async () => {
      await request(readerApi as any).get('/articles').set('X-Api-Key', 'wrong').expect(401);
    });

    it('returns 200 with articles array', async () => {
      const res = await request(readerApi as any)
        .get('/articles').set('X-Api-Key', SECRET).expect(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body[0].id).toBe(1);
    });

    it('passes the limit param to getLatestArticles', async () => {
      await request(readerApi as any).get('/articles?limit=10').set('X-Api-Key', SECRET).expect(200);
      expect(mockGetLatestArticles).toHaveBeenCalledWith(10, undefined);
    });

    it('returns 400 for an invalid updated_since timestamp', async () => {
      await request(readerApi as any)
        .get('/articles?updated_since=not-a-date').set('X-Api-Key', SECRET).expect(400);
    });

    it('passes updated_since to getLatestArticles', async () => {
      const ts = '2026-05-01T00:00:00.000Z';
      await request(readerApi as any)
        .get(`/articles?updated_since=${ts}`).set('X-Api-Key', SECRET).expect(200);
      expect(mockGetLatestArticles).toHaveBeenCalledWith(expect.any(Number), ts);
    });
  });

  // ---------------------------------------------------------------------------
  // GET /rss
  // ---------------------------------------------------------------------------

  describe('GET /rss', () => {
    it('returns 401 without auth', async () => {
      await request(readerApi as any).get('/rss').expect(401);
    });

    it('returns 200 with RSS XML via X-Api-Key header', async () => {
      const res = await request(readerApi as any)
        .get('/rss').set('X-Api-Key', SECRET).expect(200);
      expect(res.headers['content-type']).toMatch(/rss\+xml/);
      expect(res.text).toContain('<rss');
    });

    it('accepts ?secret query param as fallback for RSS readers', async () => {
      const res = await request(readerApi as any)
        .get(`/rss?secret=${SECRET}`).expect(200);
      expect(res.headers['content-type']).toMatch(/rss\+xml/);
    });
  });

  // ---------------------------------------------------------------------------
  // PATCH /articles/:id
  // ---------------------------------------------------------------------------

  describe('PATCH /articles/:id', () => {
    it('returns 401 without auth', async () => {
      await request(readerApi as any).patch('/articles/1').send({ status: 'read' }).expect(401);
    });

    it('returns 400 for a non-numeric ID', async () => {
      await request(readerApi as any)
        .patch('/articles/abc').set('X-Api-Key', SECRET).send({ status: 'read' }).expect(400);
    });

    it('returns 400 for an invalid status value', async () => {
      await request(readerApi as any)
        .patch('/articles/1').set('X-Api-Key', SECRET).send({ status: 'archived' }).expect(400);
    });

    it('returns 400 when tags is not an array of strings', async () => {
      await request(readerApi as any)
        .patch('/articles/1').set('X-Api-Key', SECRET).send({ tags: 'not-an-array' }).expect(400);
    });

    it('returns 400 when no recognised fields are sent', async () => {
      await request(readerApi as any)
        .patch('/articles/1').set('X-Api-Key', SECRET).send({ unknown: 'field' }).expect(400);
    });

    it('returns 404 when the article does not exist', async () => {
      mockUpdateArticle.mockResolvedValueOnce(null);
      await request(readerApi as any)
        .patch('/articles/99').set('X-Api-Key', SECRET).send({ status: 'read' }).expect(404);
    });

    it('updates status, tags, and saved flag, returning id + updated_at', async () => {
      const res = await request(readerApi as any)
        .patch('/articles/1').set('X-Api-Key', SECRET)
        .send({ status: 'read', tags: ['compliance'], saved: true })
        .expect(200);
      expect(res.body).toEqual({ id: 1, updated_at: '2026-05-09T12:00:00.000Z' });
      expect(mockUpdateArticle).toHaveBeenCalledWith(1, {
        status: 'read', tags: ['compliance'], saved: true,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // POST /articles  — manual article creation
  // ---------------------------------------------------------------------------

  describe('POST /articles', () => {
    const validBody = { title: 'New Article', url: 'https://example.com/article' };

    it('returns 401 without auth', async () => {
      await request(readerApi as any).post('/articles').send(validBody).expect(401);
    });

    it('returns 400 when title is missing', async () => {
      await request(readerApi as any)
        .post('/articles').set('X-Api-Key', SECRET)
        .send({ url: 'https://example.com' }).expect(400);
    });

    it('returns 400 when url is missing', async () => {
      await request(readerApi as any)
        .post('/articles').set('X-Api-Key', SECRET)
        .send({ title: 'Test' }).expect(400);
    });

    it('returns 400 for a private/local IP URL', async () => {
      await request(readerApi as any)
        .post('/articles').set('X-Api-Key', SECRET)
        .send({ title: 'Test', url: 'http://192.168.1.1/page' }).expect(400);
    });

    it('returns 400 for an invalid content_type', async () => {
      await request(readerApi as any)
        .post('/articles').set('X-Api-Key', SECRET)
        .send({ ...validBody, content_type: 'unknown' }).expect(400);
    });

    it('returns 201 with the created article', async () => {
      const res = await request(readerApi as any)
        .post('/articles').set('X-Api-Key', SECRET).send(validBody).expect(201);
      expect(res.body.id).toBe(1);
      expect(mockCreateManualArticle).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'New Article', url: 'https://example.com/article' }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // POST /articles/updates  — batch offline flush
  // ---------------------------------------------------------------------------

  describe('POST /articles/updates', () => {
    it('returns 401 without auth', async () => {
      await request(readerApi as any)
        .post('/articles/updates').send([{ id: 1, status: 'read' }]).expect(401);
    });

    it('returns 400 when body is not an array', async () => {
      await request(readerApi as any)
        .post('/articles/updates').set('X-Api-Key', SECRET).send({ id: 1 }).expect(400);
    });

    it('returns 200 with succeeded and failed lists', async () => {
      mockUpdateArticles.mockResolvedValueOnce({ succeeded: [1], failed: [] });
      const res = await request(readerApi as any)
        .post('/articles/updates').set('X-Api-Key', SECRET)
        .send([{ id: 1, status: 'read' }]).expect(200);
      expect(res.body.succeeded).toEqual([1]);
      expect(res.body.failed).toEqual([]);
    });

    it('drops items with non-integer or non-positive IDs', async () => {
      await request(readerApi as any)
        .post('/articles/updates').set('X-Api-Key', SECRET)
        .send([{ id: 1, status: 'read' }, { id: 'bad', status: 'read' }, { id: -5, status: 'skipped' }])
        .expect(200);
      expect(mockUpdateArticles).toHaveBeenCalledWith([{ id: 1, status: 'read' }]);
    });
  });
});
