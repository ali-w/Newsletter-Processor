import request from 'supertest';
import { app } from '../src/api/server';
import { extractArticles, summarizeArticleFromUrl } from '../src/llm/parser';
import { insertNewsletter, insertArticle, getLatestArticles, getArticleById, updateArticle, updateArticles } from '../src/db/database';
import { generateRssFeed } from '../src/rss/generator';

// Mock the entire database module — no libsql client needed in server tests
jest.mock('../src/db/database', () => ({
  insertNewsletter: jest.fn().mockResolvedValue(1),
  insertArticle: jest.fn().mockResolvedValue(undefined),
  getLatestArticles: jest.fn().mockResolvedValue([]),
  getArticleById: jest.fn().mockResolvedValue(null),
  updateArticle: jest.fn().mockResolvedValue('2026-05-09T12:00:00.000Z'),
  updateArticles: jest.fn().mockResolvedValue({ succeeded: [], failed: [] }),
}));

jest.mock('../src/llm/parser', () => ({
  extractArticles: jest.fn(),
  summarizeArticleFromUrl: jest.fn(),
}));

jest.mock('../src/rss/generator', () => ({
  generateRssFeed: jest.fn().mockReturnValue('<?xml version="1.0"?><rss version="2.0"></rss>'),
}));

// Cloudmailin is used when forwarding emails with no articles for manual review
jest.mock('cloudmailin', () => ({
  MessageClient: jest.fn().mockImplementation(() => ({
    sendMessage: jest.fn().mockResolvedValue(undefined),
  })),
}));

const SECRET = 'test_secret_123';

const validMailPayload = {
  envelope: { from: 'newsletter@example.com' },
  headers: { Date: 'Mon, 09 May 2026 12:00:00 +0000' },
  html: '<p>Newsletter content with articles</p>',
};

// ---------------------------------------------------------------------------
// CloudMailin webhook
// ---------------------------------------------------------------------------

describe('POST /webhook/cloudmailin', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (extractArticles as jest.Mock).mockResolvedValue([
      { title: 'Test Article', summary: 'A summary', url: 'http://example.com/article' },
    ]);
    (insertNewsletter as jest.Mock).mockResolvedValue(1);
    (insertArticle as jest.Mock).mockResolvedValue(undefined);
  });

  it('returns 401 for a missing or wrong secret', async () => {
    await request(app)
      .post('/webhook/cloudmailin?secret=wrong')
      .send(validMailPayload)
      .expect(401);
  });

  it('returns 400 when the email has neither html nor plain content', async () => {
    const res = await request(app)
      .post(`/webhook/cloudmailin?secret=${SECRET}`)
      .send({ envelope: { from: 'sender@example.com' }, headers: {} })
      .expect(400);
    expect(res.body.error).toMatch(/no content/i);
  });

  it('extracts articles and stores them, returning 200 with the article count', async () => {
    const res = await request(app)
      .post(`/webhook/cloudmailin?secret=${SECRET}`)
      .send(validMailPayload)
      .expect(200);
    expect(res.body.status).toBe('success');
    expect(res.body.message).toMatch(/1 article/);
    expect(insertNewsletter).toHaveBeenCalledWith('newsletter@example.com', 'newsletter@example.com', expect.any(Date));
    expect(insertArticle).toHaveBeenCalledTimes(1);
  });

  it('uses the plain text body when html is absent', async () => {
    await request(app)
      .post(`/webhook/cloudmailin?secret=${SECRET}`)
      .send({ envelope: { from: 'x@example.com' }, headers: {}, plain: 'Plain text content' })
      .expect(200);
    expect(extractArticles).toHaveBeenCalledWith('Plain text content');
  });

  it('falls back to headers.From when envelope.from is absent', async () => {
    await request(app)
      .post(`/webhook/cloudmailin?secret=${SECRET}`)
      .send({ headers: { From: 'fallback@example.com', Date: '' }, html: '<p>Content</p>' })
      .expect(200);
    expect(insertNewsletter).toHaveBeenCalledWith('fallback@example.com', 'fallback@example.com', expect.any(Date));
  });

  it('returns 200 with a no-articles message when the LLM extracts nothing', async () => {
    (extractArticles as jest.Mock).mockResolvedValueOnce([]);
    const res = await request(app)
      .post(`/webhook/cloudmailin?secret=${SECRET}`)
      .send(validMailPayload)
      .expect(200);
    expect(res.body.message).toMatch(/no articles found/i);
    expect(insertNewsletter).not.toHaveBeenCalled();
  });

  it('returns 500 when LLM extraction throws', async () => {
    (extractArticles as jest.Mock).mockRejectedValueOnce(new Error('Gemini timeout'));
    await request(app)
      .post(`/webhook/cloudmailin?secret=${SECRET}`)
      .send(validMailPayload)
      .expect(500);
  });
});

// ---------------------------------------------------------------------------
// PATCH /articles/:id  — single annotation update
// ---------------------------------------------------------------------------

describe('PATCH /articles/:id', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (updateArticle as jest.Mock).mockResolvedValue('2026-05-09T12:00:00.000Z');
  });

  it('returns 401 for a wrong secret', async () => {
    await request(app).patch('/articles/1?secret=wrong').send({ status: 'read' }).expect(401);
  });

  it('returns 400 for a non-numeric article ID', async () => {
    await request(app).patch(`/articles/abc?secret=${SECRET}`).send({ status: 'read' }).expect(400);
  });

  it('returns 400 for an unrecognised status value', async () => {
    await request(app)
      .patch(`/articles/1?secret=${SECRET}`)
      .send({ status: 'archived' })
      .expect(400);
  });

  it('returns 400 for a rating outside 1–5', async () => {
    await request(app).patch(`/articles/1?secret=${SECRET}`).send({ rating: 6 }).expect(400);
    await request(app).patch(`/articles/1?secret=${SECRET}`).send({ rating: 0 }).expect(400);
  });

  it('returns 400 when no recognised fields are sent', async () => {
    await request(app).patch(`/articles/1?secret=${SECRET}`).send({ unknown: 'field' }).expect(400);
  });

  it('returns 404 when the article does not exist', async () => {
    (updateArticle as jest.Mock).mockResolvedValueOnce(null);
    await request(app).patch(`/articles/99?secret=${SECRET}`).send({ status: 'read' }).expect(404);
  });

  it('updates status and returns id + updated_at', async () => {
    const res = await request(app)
      .patch(`/articles/1?secret=${SECRET}`)
      .send({ status: 'read' })
      .expect(200);
    expect(res.body).toEqual({ id: 1, updated_at: '2026-05-09T12:00:00.000Z' });
    expect(updateArticle).toHaveBeenCalledWith(1, { status: 'read' });
  });

  it('accepts null rating to clear the stored value', async () => {
    await request(app).patch(`/articles/1?secret=${SECRET}`).send({ rating: null }).expect(200);
    expect(updateArticle).toHaveBeenCalledWith(1, { rating: null });
  });

  it('updates notes', async () => {
    const note = 'Good compliance angle — follow up on token storage.';
    await request(app).patch(`/articles/1?secret=${SECRET}`).send({ notes: note }).expect(200);
    expect(updateArticle).toHaveBeenCalledWith(1, { notes: note });
  });

  it('accepts multiple fields in one request', async () => {
    await request(app)
      .patch(`/articles/1?secret=${SECRET}`)
      .send({ status: 'read', rating: 4, notes: 'Great article' })
      .expect(200);
    expect(updateArticle).toHaveBeenCalledWith(1, {
      status: 'read',
      rating: 4,
      notes: 'Great article',
    });
  });
});

// ---------------------------------------------------------------------------
// POST /articles/updates  — batch offline flush
// ---------------------------------------------------------------------------

describe('POST /articles/updates', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (updateArticles as jest.Mock).mockResolvedValue({ succeeded: [], failed: [] });
  });

  it('returns 401 for a wrong secret', async () => {
    await request(app)
      .post('/articles/updates?secret=wrong')
      .send([{ id: 1, status: 'read' }])
      .expect(401);
  });

  it('returns 400 when body is not an array', async () => {
    await request(app)
      .post(`/articles/updates?secret=${SECRET}`)
      .send({ id: 1, status: 'read' })
      .expect(400);
  });

  it('returns succeeded and failed lists from updateArticles', async () => {
    (updateArticles as jest.Mock).mockResolvedValueOnce({
      succeeded: [1, 2],
      failed: [{ id: 99, error: 'Article not found' }],
    });
    const res = await request(app)
      .post(`/articles/updates?secret=${SECRET}`)
      .send([
        { id: 1, status: 'read' },
        { id: 2, rating: 4 },
        { id: 99, status: 'skipped' },
      ])
      .expect(200);
    expect(res.body.succeeded).toEqual([1, 2]);
    expect(res.body.failed[0]).toMatchObject({ id: 99, error: 'Article not found' });
  });

  it('drops items with non-integer IDs before calling updateArticles', async () => {
    await request(app)
      .post(`/articles/updates?secret=${SECRET}`)
      .send([
        { id: 1, status: 'read' },
        { id: 'bad', status: 'read' },
        { id: -5, status: 'skipped' },
      ])
      .expect(200);
    expect(updateArticles).toHaveBeenCalledWith([{ id: 1, status: 'read' }]);
  });

  it('passes notes and coerces invalid ratings to null', async () => {
    await request(app)
      .post(`/articles/updates?secret=${SECRET}`)
      .send([{ id: 1, rating: 99, notes: 'My note' }])
      .expect(200);
    // rating 99 is out of range — coerced to null in the batch endpoint
    expect(updateArticles).toHaveBeenCalledWith([{ id: 1, rating: null, notes: 'My note' }]);
  });

  it('accepts X-Api-Key header auth', async () => {
    await request(app)
      .post('/articles/updates')
      .set('X-Api-Key', SECRET)
      .send([{ id: 1, status: 'read' }])
      .expect(200);
  });
});

// ---------------------------------------------------------------------------
// GET /articles  — JSON article list
// ---------------------------------------------------------------------------

describe('GET /articles', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getLatestArticles as jest.Mock).mockResolvedValue([
      { id: 1, title: 'Test Article', summary: 'A summary', url: 'http://example.com', status: 'unread' },
    ]);
  });

  it('returns 401 for a wrong secret', async () => {
    await request(app).get('/articles?secret=wrong').expect(401);
  });

  it('returns 200 with an articles array via query param', async () => {
    const res = await request(app).get(`/articles?secret=${SECRET}`).expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0].title).toBe('Test Article');
  });

  it('accepts X-Api-Key header auth', async () => {
    const res = await request(app).get('/articles').set('X-Api-Key', SECRET).expect(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('passes the limit param to getLatestArticles', async () => {
    await request(app).get(`/articles?secret=${SECRET}&limit=10`).expect(200);
    expect(getLatestArticles).toHaveBeenCalledWith(10);
  });
});

// ---------------------------------------------------------------------------
// GET /rss  — RSS 2.0 feed
// ---------------------------------------------------------------------------

describe('GET /rss', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getLatestArticles as jest.Mock).mockResolvedValue([]);
    (generateRssFeed as jest.Mock).mockReturnValue('<?xml version="1.0"?><rss version="2.0"></rss>');
  });

  it('returns 401 for a wrong secret', async () => {
    await request(app).get('/rss?secret=wrong').expect(401);
  });

  it('returns 200 with RSS XML via query param', async () => {
    const res = await request(app).get(`/rss?secret=${SECRET}`).expect(200);
    expect(res.headers['content-type']).toMatch(/rss\+xml/);
    expect(res.text).toContain('<rss');
  });

  it('accepts X-Api-Key header auth', async () => {
    const res = await request(app).get('/rss').set('X-Api-Key', SECRET).expect(200);
    expect(res.headers['content-type']).toMatch(/rss\+xml/);
  });
});

// ---------------------------------------------------------------------------
// GET /summarize/:id  — on-demand AI executive summary
// ---------------------------------------------------------------------------

describe('GET /summarize/:id', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getArticleById as jest.Mock).mockResolvedValue({
      id: 1, title: 'Test Article', url: 'http://example.com/article', notes: '',
    });
    (summarizeArticleFromUrl as jest.Mock).mockResolvedValue('Executive summary text.');
  });

  it('returns 401 for a wrong secret', async () => {
    await request(app).get('/summarize/1?secret=wrong').expect(401);
  });

  it('returns 400 for a non-numeric article ID', async () => {
    await request(app).get(`/summarize/abc?secret=${SECRET}`).expect(400);
  });

  it('returns 404 when the article does not exist', async () => {
    (getArticleById as jest.Mock).mockResolvedValueOnce(null);
    await request(app).get(`/summarize/99?secret=${SECRET}`).expect(404);
  });

  it('returns 200 with a plain text summary', async () => {
    const res = await request(app).get(`/summarize/1?secret=${SECRET}`).expect(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.text).toBe('Executive summary text.');
    expect(summarizeArticleFromUrl).toHaveBeenCalledWith('http://example.com/article', 'Test Article');
  });

  it('returns 500 when the LLM call fails', async () => {
    (summarizeArticleFromUrl as jest.Mock).mockRejectedValueOnce(new Error('Gemini timeout'));
    await request(app).get(`/summarize/1?secret=${SECRET}`).expect(500);
  });

  it('accepts X-Api-Key header auth', async () => {
    await request(app).get('/summarize/1').set('X-Api-Key', SECRET).expect(200);
  });
});

// ---------------------------------------------------------------------------
// PATCH /articles/:id  — X-Api-Key header variant
// ---------------------------------------------------------------------------

describe('PATCH /articles/:id — header auth', () => {
  it('accepts X-Api-Key header auth', async () => {
    (updateArticle as jest.Mock).mockResolvedValue('2026-05-09T12:00:00.000Z');
    const res = await request(app)
      .patch('/articles/1')
      .set('X-Api-Key', SECRET)
      .send({ status: 'read' })
      .expect(200);
    expect(res.body).toEqual({ id: 1, updated_at: '2026-05-09T12:00:00.000Z' });
  });
});
