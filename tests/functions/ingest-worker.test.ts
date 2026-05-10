import request from 'supertest';

const mockInsertNewsletter = jest.fn().mockResolvedValue(1);
const mockInsertArticle = jest.fn().mockResolvedValue(undefined);
const mockExtractArticles = jest.fn();
const mockSendMessage = jest.fn().mockResolvedValue(undefined);

jest.mock('../../src/db/database', () => ({
  insertNewsletter: mockInsertNewsletter,
  insertArticle: mockInsertArticle,
}));

jest.mock('../../src/llm/parser', () => ({
  extractArticles: mockExtractArticles,
}));

jest.mock('cloudmailin', () => ({
  MessageClient: jest.fn().mockImplementation(() => ({
    sendMessage: mockSendMessage,
  })),
}));

import { ingestWorker } from '../../src/functions/ingest-worker';

const validPayload = {
  envelope: { from: 'newsletter@example.com' },
  headers: { Date: 'Mon, 09 May 2026 12:00:00 +0000' },
  html: '<p>Newsletter content with articles</p>',
};

// Helper: wait for all pending microtasks and I/O callbacks to drain so that
// background processing (which continues after the 200 response is sent) completes.
const flush = () => new Promise(resolve => setImmediate(resolve));

describe('ingestWorker — POST /', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExtractArticles.mockResolvedValue([
      { title: 'Article 1', summary: 'Summary 1', url: 'http://example.com/1' },
    ]);
  });

  it('returns 403 when the Cloud Tasks header is absent', async () => {
    await request(ingestWorker as any).post('/').send(validPayload).expect(403);
  });

  it('returns 200 immediately when the Cloud Tasks header is present', async () => {
    const res = await request(ingestWorker as any)
      .post('/')
      .set('x-cloudtasks-taskname', 'projects/test/tasks/123')
      .send(validPayload)
      .expect(200);
    expect(res.body).toEqual({ status: 'processing' });
  });

  it('extracts articles and writes them to the database', async () => {
    await request(ingestWorker as any)
      .post('/')
      .set('x-cloudtasks-taskname', 'projects/test/tasks/123')
      .send(validPayload);
    await flush();
    expect(mockExtractArticles).toHaveBeenCalledWith(validPayload.html);
    expect(mockInsertNewsletter).toHaveBeenCalledWith('newsletter@example.com', expect.any(Date));
    expect(mockInsertArticle).toHaveBeenCalledTimes(1);
  });

  it('falls back to headers.From when envelope.from is absent', async () => {
    const payload = { headers: { From: 'fallback@example.com', Date: '' }, html: '<p>Content</p>' };
    await request(ingestWorker as any)
      .post('/')
      .set('x-cloudtasks-taskname', 'projects/test/tasks/123')
      .send(payload);
    await flush();
    expect(mockInsertNewsletter).toHaveBeenCalledWith('fallback@example.com', expect.any(Date));
  });

  it('skips DB writes and does not crash when no articles are extracted', async () => {
    mockExtractArticles.mockResolvedValueOnce([]);
    await request(ingestWorker as any)
      .post('/')
      .set('x-cloudtasks-taskname', 'projects/test/tasks/123')
      .send(validPayload)
      .expect(200);
    await flush();
    expect(mockInsertNewsletter).not.toHaveBeenCalled();
    // CLOUDMAILIN_USERNAME/API_KEY/REVIEW_RECIPIENT_EMAIL are not set in setup.ts,
    // so the forwarding branch is skipped and sendMessage should not be called.
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('returns 200 and logs the error when LLM extraction throws', async () => {
    mockExtractArticles.mockRejectedValueOnce(new Error('Gemini failure'));
    const res = await request(ingestWorker as any)
      .post('/')
      .set('x-cloudtasks-taskname', 'projects/test/tasks/123')
      .send(validPayload)
      .expect(200);
    expect(res.body).toEqual({ status: 'processing' });
    await flush();
    expect(mockInsertNewsletter).not.toHaveBeenCalled();
  });
});
