import { insertNewsletter, insertArticle, getLatestArticles, initDb } from '../src/db/database';

// Mock the @libsql/client/web (used to avoid native binding issues on Windows ARM)
jest.mock('@libsql/client/web', () => {
  let mockDb: any[] = [];
  return {
    createClient: () => ({
      execute: jest.fn().mockImplementation((query) => {
        if (typeof query === 'string') return Promise.resolve(); // For initDb
        
        const { sql, args } = query;
        if (sql.includes('INSERT INTO newsletters')) {
          mockDb.push({ type: 'newsletter', id: mockDb.length + 1, ...args });
          return Promise.resolve({ lastInsertRowid: BigInt(mockDb.length) });
        }
        if (sql.includes('INSERT INTO articles')) {
          mockDb.push({ type: 'article', id: mockDb.length + 1, ...args });
          return Promise.resolve();
        }
        if (sql.includes('SELECT')) {
          return Promise.resolve({
            rows: [
              {
                title: 'Test Article',
                summary: 'This is a test',
                url: 'http://test.com',
                received_at: new Date().toISOString(),
                newsletter_name: 'Test Newsletter'
              }
            ]
          });
        }
        return Promise.resolve({ rows: [] });
      })
    })
  };
});

describe('Database Layer', () => {
  beforeAll(async () => {
    // Suppress console.log for clean test output
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  it('should initialize the database without errors', async () => {
    await expect(initDb()).resolves.toBeUndefined();
  });

  it('should insert a newsletter and return an ID', async () => {
    const id = await insertNewsletter('Test Newsletter', new Date());
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);
  });

  it('should insert an article', async () => {
    await expect(insertArticle(1, { title: 'T', summary: 'S', url: 'U' })).resolves.toBeUndefined();
  });

  it('should retrieve latest articles', async () => {
    const articles = await getLatestArticles(10);
    expect(articles).toHaveLength(1);
    expect(articles[0].title).toBe('Test Article');
  });
});
