import { Request, Response, NextFunction } from 'express';
import { Request as FnRequest } from '@google-cloud/functions-framework';

export function parseJsonBody(req: Request, _res: Response, next: NextFunction): void {
  const raw = (req as FnRequest).rawBody;
  if (raw !== undefined) {
    try {
      req.body = JSON.parse(raw.toString('utf8'));
    } catch {
      // leave req.body unchanged — handlers validate their own input
    }
  }
  next();
}
