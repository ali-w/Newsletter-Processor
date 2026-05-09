import RSS from 'rss';

interface RssArticle {
  id: number;
  title: string;
  summary: string;
  url: string;
  received_at: string;
  newsletter_name: string;
}

export function generateRssFeed(articles: RssArticle[], baseUrl: string): string {
  const feed = new RSS({
    title: 'Newsletter Processor Feed',
    description: 'Articles extracted from email newsletters',
    feed_url: `${baseUrl}/rss`,
    site_url: baseUrl,
    language: 'en',
    pubDate: new Date().toUTCString(),
  });

  for (const article of articles) {
    feed.item({
      title: article.title,
      description: `
        <p>${article.summary}</p>
        <p><small><strong>From:</strong> ${article.newsletter_name}</small></p>
      `,
      url: article.url,
      guid: `article-${article.id}`,
      date: article.received_at,
      author: article.newsletter_name,
    });
  }

  return feed.xml({ indent: true });
}
