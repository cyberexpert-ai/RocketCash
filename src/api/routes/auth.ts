import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authenticateUser } from '../../services/auth';
import { assessDevice } from '../../services/fraud';
import { getSetting } from '../../services/settings';
import { creditWallet } from '../../services/wallet';
import { authLimiter } from '../middleware/rateLimit';
import { getIpHash, getUserAgentHash } from '../middleware/auth';
import { logger } from '../../utils/logger';

const router = Router();

const AuthSchema = z.object({
  initData: z.string().min(10),
  signals: z.object({
    timezone: z.string().optional(),
    language: z.string().optional(),
    screenInfo: z.string().optional(),
    installationId: z.string().optional(),
  }).optional(),
});

/**
 * POST /api/auth/telegram
 * Validates Telegram Mini App initData and creates a session.
 * Returns session token — NEVER leaks userId/telegramId to be trusted by backend.
 */
router.post('/telegram', authLimiter, async (req: Request, res: Response): Promise<void> => {
  try {
    const body = AuthSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'Invalid request', details: body.error.flatten() });
      return;
    }

    const { initData, signals } = body.data;
    const ipHash = getIpHash(req);
    const uaHash = getUserAgentHash(req);

    const authResult = await authenticateUser(initData, ipHash, uaHash);

    // Assess device risk asynchronously
    assessDevice(authResult.userId, {
      ipHash,
      userAgentHash: uaHash,
      timezone: signals?.timezone,
      language: signals?.language,
      screenInfo: signals?.screenInfo,
      installationId: signals?.installationId,
    }).catch(err => logger.warn('Device assessment failed', { err: err.message }));

    // Signup bonus if configured
    const bonusPaise = parseInt(await getSetting('signup_bonus_paise') || '0');
    if (bonusPaise > 0) {
      // Only credit once per user (idempotency)
      try {
        await creditWallet({
          userId: authResult.userId,
          amountPaise: bonusPaise,
          type: 'SIGNUP_BONUS',
          idempotencyKey: `signup_bonus_${authResult.userId}`,
          description: 'Welcome bonus',
        });
      } catch {
        // Already credited — ignore duplicate
      }
    }

    res.json({
      success: true,
      sessionToken: authResult.sessionToken,
      user: {
        firstName: authResult.user.first_name,
        lastName: authResult.user.last_name,
        username: authResult.user.username,
        // Never send internal userId or telegramId to frontend
      },
    });
  } catch (err: any) {
    if (err.message === 'Invalid Telegram initData') {
      res.status(401).json({ error: 'Unauthorized', message: 'Invalid Telegram data' });
      return;
    }
    if (err.message === 'Account is blocked') {
      res.status(403).json({ error: 'Forbidden', message: 'Your account has been blocked.' });
      return;
    }
    logger.error('Auth error', { err: err.message });
    res.status(500).json({ error: 'Auth failed' });
  }
});

export default router;
