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

function getPdfBucket() {
  if (!config.GCS_PDF_BUCKET) throw new Error('GCS_PDF_BUCKET is not configured');
  return storage.bucket(config.GCS_PDF_BUCKET);
}

export async function generateSignedPutUrl(articleId: number, expiresInSeconds = 900): Promise<string> {
  const [url] = await getPdfBucket().file(`${articleId}.pdf`).getSignedUrl({
    version: 'v4',
    action: 'write',
    expires: Date.now() + expiresInSeconds * 1000,
    contentType: 'application/pdf',
  });
  return url;
}

export async function generateSignedGetUrl(articleId: number, expiresInSeconds = 30): Promise<string> {
  const [url] = await getPdfBucket().file(`${articleId}.pdf`).getSignedUrl({
    version: 'v4',
    action: 'read',
    expires: Date.now() + expiresInSeconds * 1000,
  });
  return url;
}

export async function pdfExists(articleId: number): Promise<boolean> {
  const [exists] = await getPdfBucket().file(`${articleId}.pdf`).exists();
  return exists;
}

export async function deletePdf(articleId: number): Promise<void> {
  await getPdfBucket().file(`${articleId}.pdf`).delete({ ignoreNotFound: true });
}

export async function downloadPdf(articleId: number): Promise<Buffer> {
  const [bytes] = await getPdfBucket().file(`${articleId}.pdf`).download();
  return bytes;
}
