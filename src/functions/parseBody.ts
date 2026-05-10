import express, { Request, Response, NextFunction } from 'express';
import { Request as FnRequest } from '@google-cloud/functions-framework';

const MAX_BODY_BYTES = 550_000; // 275 kB — CloudMailin email cap (~512 kB) + 5 % headroom

const jsonFallback = express.json({ limit: MAX_BODY_BYTES });

export function parseJsonBody(req: Request, res: Response, next: NextFunction): void {
  const raw = (req as FnRequest).rawBody;
  if (raw !== undefined) {
    if (raw.length <= MAX_BODY_BYTES) {
      try {
        req.body = JSON.parse(raw.toString('utf8'));
      } catch {
        // leave req.body unchanged — handlers validate their own input
      }
    }
    next();
  } else {
    // rawBody is only set by the Cloud Functions framework; fall back to standard
    // Express JSON parsing for local dev and tests.
    jsonFallback(req, res, next);
  }
}
