import { insertNewsletter, insertArticle, getLatestArticles, initDb, updateArticle, updateArticles } from '../src/db/database';

// Mutable — tests set this before exercising functions that hit SELECT
let mockSelectRows: any[] = [];

jest.mock('@libsql/client/web', () => ({
  createClient: () => ({
    execute: jest.fn().mockImplementation((query: any) => {
      if (typeof query === 'string') return Promise.resolve(); // CREATE TABLE / ALTER TABLE
      const { sql } = query;
      if (sql.includes('INSERT INTO newsletters'))
        return Promise.resolve({ lastInsertRowid: BigInt(1) });
      if (sql.includes('INSERT INTO articles'))
        return Promise.resolve();
      if (sql.includes('SELECT'))
        return Promise.resolve({ rows: mockSelectRows });
      if (sql.includes('UPDATE'))
        return Promise.resolve();
      return Promise.resolve({ rows: [] });
    }),
  }),
}));

describe('Database Layer', () => {
  beforeAll(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  describe('initDb, insert, and read', () => {
    beforeEach(() => {
      mockSelectRows = [
        {
          title: 'Test Article',
          summary: 'This is a test',
          url: 'http://test.com',
          received_at: new Date().toISOString(),
          newsletter_name: 'Test Newsletter',
        },
      ];
    });

    it('initializes the database without errors', async () => {
      await expect(initDb()).resolves.toBeUndefined();
    });

    it('inserts a newsletter and returns a numeric ID', async () => {
      const id = await insertNewsletter('Test Newsletter', 'test@example.com', new Date());
      expect(typeof id).toBe('number');
      expect(id).toBeGreaterThan(0);
    });

    it('inserts an article without throwing', async () => {
      await expect(insertArticle(1, { title: 'T', summary: 'S', url: 'U' })).resolves.toBeUndefined();
    });

    it('retrieves latest articles', async () => {
      const articles = await getLatestArticles(10);
      expect(articles).toHaveLength(1);
      expect(articles[0].title).toBe('Test Article');
    });
  });

  describe('updateArticle', () => {
    it('returns an ISO timestamp string when the article exists', async () => {
      mockSelectRows = [{ id: 1 }];
      const result = await updateArticle(1, { status: 'read', rating: 4 });
      expect(typeof result).toBe('string');
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('returns null when the article does not exist', async () => {
      mockSelectRows = [];
      const result = await updateArticle(99, { status: 'skipped' });
      expect(result).toBeNull();
    });

    it('accepts a null rating to clear the value', async () => {
      mockSelectRows = [{ id: 1 }];
      await expect(updateArticle(1, { rating: null })).resolves.not.toBeNull();
    });

    it('accepts notes and returns a timestamp', async () => {
      mockSelectRows = [{ id: 1 }];
      await expect(updateArticle(1, { notes: 'Interesting point on compliance.' })).resolves.not.toBeNull();
    });
  });

  describe('updateArticles', () => {
    it('returns all IDs as succeeded when every article exists', async () => {
      mockSelectRows = [{ id: 1 }]; // mock returns this for every SELECT
      const result = await updateArticles([
        { id: 1, status: 'read' },
        { id: 2, rating: 3 },
      ]);
      expect(result.succeeded).toHaveLength(2);
      expect(result.failed).toHaveLength(0);
    });

    it('reports not-found articles in the failed list', async () => {
      mockSelectRows = [];
      const result = await updateArticles([{ id: 99, status: 'read' }]);
      expect(result.succeeded).toHaveLength(0);
      expect(result.failed).toEqual([{ id: 99, error: 'Article not found' }]);
    });
  });
});
