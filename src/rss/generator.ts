import RSS from 'rss';


interface RssArticle {
  id: number;
  title: string;
  summary: string;
  url: string;
  received_at: string;
  newsletter_name: string;
}

export function generateRssFeed(articles: RssArticle[], baseUrl: string, rssSecret: string): string {
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
        <p><strong>Article ID:</strong> ${article.id}</p>
        <p><strong>From:</strong> ${article.newsletter_name}</p>
        <p>${article.summary}</p>
      `,
      url: article.url,
      guid: `article-${article.id}`,
      date: article.received_at, // Use the newsletter received_at date
      author: article.newsletter_name,
      custom_elements: [
        { comments: `${baseUrl}/summarize/${article.id}?secret=${rssSecret}` }
      ]
    });
  }

  return feed.xml({ indent: true });
}
