import { Router, Request, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { validateIFSC, searchIFSC, validateUPIId } from '../../providers/ifsc';
import { db } from '../../db';
import { generalLimiter } from '../middleware/rateLimit';

// ─── IFSC ─────────────────────────────────────────────────────

export const ifscRouter = Router();

ifscRouter.get('/search', requireAuth, generalLimiter, async (req: AuthRequest, res: Response): Promise<void> => {
  const ifsc = req.query.ifsc as string;
  const bank = req.query.bank as string;
  const city = req.query.city as string;

  if (ifsc) {
    const result = await validateIFSC(ifsc);
    res.json(result);
    return;
  }

  if (bank) {
    const results = await searchIFSC(bank, city);
    res.json({ results });
    return;
  }

  res.status(400).json({ error: 'Provide ifsc or bank query parameter' });
});

ifscRouter.post('/validate-upi', requireAuth, generalLimiter, async (req: AuthRequest, res: Response): Promise<void> => {
  const { upiId } = req.body;
  if (!upiId) { res.status(400).json({ error: 'upiId required' }); return; }

  const isValid = validateUPIId(upiId);
  res.json({
    upiId,
    status: isValid ? 'UNVERIFIED' : 'INVALID',
    valid: isValid,
    message: isValid
      ? 'UPI ID format is valid. Ownership not verified.'
      : 'Invalid UPI ID format.',
  });
});

// ─── HEALTH ───────────────────────────────────────────────────

export const healthRouter = Router();

healthRouter.get('/', async (req: Request, res: Response): Promise<void> => {
  const dbOk = await db.healthCheck();
  const status = dbOk ? 200 : 503;

  res.status(status).json({
    status: dbOk ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    services: {
      database: dbOk ? 'online' : 'offline',
      webService: 'online',
    },
  });
});
