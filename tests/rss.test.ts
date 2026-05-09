import { generateRssFeed } from '../src/rss/generator';

describe('RSS Generator', () => {
  it('should generate a valid RSS XML feed', () => {
    const articles = [
      {
        id: 123,
        title: 'Breaking News',
        summary: 'Something happened.',
        url: 'http://news.com/1',
        received_at: new Date('2026-05-04T10:00:00Z').toUTCString(),
        newsletter_name: 'Daily News'
      }
    ];

    const xml = generateRssFeed(articles, 'http://localhost:8080');
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<title><![CDATA[Breaking News]]></title>');
    expect(xml).toContain('<link>http://news.com/1</link>');
    expect(xml).toContain('Daily News');
    expect(xml).toContain('<strong>From:</strong> Daily News');
    expect(xml).toContain('<guid isPermaLink="false">article-123</guid>');
  });

  it('should handle empty articles list gracefully', () => {
    const xml = generateRssFeed([], 'http://localhost:8080');
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).not.toContain('<item>');
  });
});
