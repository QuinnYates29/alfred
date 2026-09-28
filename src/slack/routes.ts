// P20 — Slack HTTP surface: GET /slack/status.
import { Router } from 'express';

export function slackRouter(getStatus: () => {
  configured: boolean;
  connected: boolean;
  lastError: string | null;
}): Router {
  const r = Router();
  r.get('/slack/status', (_req, res) => {
    res.json(getStatus());
  });
  return r;
}
