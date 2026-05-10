import { Request, Response, NextFunction } from 'express';
import { Request as FnRequest } from '@google-cloud/functions-framework';

const MAX_BODY_BYTES = 281_600; // 275 kB — CloudMailin email cap (~250 kB) + 10 % headroom

export function parseJsonBody(req: Request, _res: Response, next: NextFunction): void {
  const raw = (req as FnRequest).rawBody;
  if (raw !== undefined && raw.length <= MAX_BODY_BYTES) {
    try {
      req.body = JSON.parse(raw.toString('utf8'));
    } catch {
      // leave req.body unchanged — handlers validate their own input
    }
  }
  next();
}
