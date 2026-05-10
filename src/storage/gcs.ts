import { Storage } from '@google-cloud/storage';
import { config } from '../config';

const storage = new Storage();

function getBucket() {
  if (!config.GCS_BUCKET) throw new Error('GCS_BUCKET is not configured');
  return storage.bucket(config.GCS_BUCKET);
}

export async function uploadHtml(articleId: number, html: string): Promise<string> {
  const bucket = getBucket();
  const file = bucket.file(`articles/${articleId}/content.html`);
  await file.save(html, { contentType: 'text/html; charset=utf-8', resumable: false });
  return `gs://${config.GCS_BUCKET}/articles/${articleId}/content.html`;
}

export function getFileStream(gsUri: string) {
  const bucket = getBucket();
  const objectPath = gsUri.replace(`gs://${config.GCS_BUCKET}/`, '');
  return bucket.file(objectPath).createReadStream();
}
