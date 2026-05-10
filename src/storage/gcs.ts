import { Storage } from '@google-cloud/storage';
import { config } from '../config';

const storage = new Storage();

function getBucket() {
  if (!config.GCS_BUCKET) throw new Error('GCS_BUCKET is not configured');
  return storage.bucket(config.GCS_BUCKET);
}

export async function uploadHtml(articleId: number, html: string): Promise<string> {
  const bucket = getBucket();
  const path = `articles/${articleId}/content.html`;
  await bucket.file(path).save(html, { contentType: 'text/html; charset=utf-8', resumable: false });
  return path;
}

export function getFileStream(gcsPath: string) {
  const bucket = getBucket();
  return bucket.file(gcsPath).createReadStream();
}
