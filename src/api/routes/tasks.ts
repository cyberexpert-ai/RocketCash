import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { playSpin, getSpinStatus } from '../../services/spin';
import { getTransactionHistory, getWallet } from '../../services/wallet';
import { getReferralInfo } from '../../services/referral';
import { getBitLabsTasks, getBitLabsSurveyUrl } from '../../providers/bitlabs';
import { db } from '../../db';
import { paiseToRupees } from '../../utils/money';
import { spinLimiter } from '../middleware/rateLimit';
import { notifySpinSuccess } from '../../services/notification';

// ─── SPIN ────────────────────────────────────────────────────

export const spinRouter = Router();

spinRouter.get('/status', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const status = await getSpinStatus(req.userId!);
  res.json(status);
});

spinRouter.post('/play', requireAuth, spinLimiter, async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.userId!;
  try {
    const result = await playSpin(userId);
    const wallet = await getWallet(userId);

    // Send Telegram notification
    notifySpinSuccess(
      userId,
      wallet?.first_name || 'User',
      result.rewardPaise,
      wallet?.balance_paise || 0
    ).catch(() => {});

    res.json({
      success: true,
      rewardPaise: result.rewardPaise,
      rewardFormatted: paiseToRupees(result.rewardPaise),
      balancePaise: wallet?.balance_paise || 0,
      balanceFormatted: paiseToRupees(wallet?.balance_paise || 0),
      spinId: result.spinId,
    });
  } catch (err: any) {
    if (err.message === 'SPIN_DISABLED') {
      res.status(403).json({ error: 'SPIN_DISABLED', message: '🎡 Spin temporarily unavailable.' });
      return;
    }
    if (err.message === 'DAILY_LIMIT_REACHED') {
      res.status(429).json({ error: 'DAILY_LIMIT_REACHED', message: 'Aaj ke spins khatam 🎯' });
      return;
    }
    res.status(500).json({ error: 'Spin failed', message: err.message });
  }
});

// ─── TASKS ───────────────────────────────────────────────────

export const tasksRouter = Router();

tasksRouter.get('/', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.userId!;
  const { rows: users } = await db.query(`SELECT telegram_id FROM users WHERE id=$1`, [userId]);
  const telegramId = users[0]?.telegram_id;

  const tasks = await getBitLabsTasks(userId, telegramId);
  const surveyUrl = await getBitLabsSurveyUrl(telegramId);

  res.json({ tasks, surveyUrl });
});

tasksRouter.post('/:taskId/start', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.userId!;
  const taskId = req.params.taskId;

  const { rows: users } = await db.query(`SELECT telegram_id FROM users WHERE id=$1`, [userId]);
  const surveyUrl = await getBitLabsSurveyUrl(users[0]?.telegram_id);

  // Record task session start
  const provider = await db.query(`SELECT id FROM task_providers WHERE name='bitlabs' LIMIT 1`);
  if (provider.rows[0]) {
    await db.query(
      `INSERT INTO task_sessions (user_id, provider_id, external_task_id, status)
       VALUES ($1, $2, $3, 'STARTED')`,
      [userId, provider.rows[0].id, taskId]
    );
  }

  res.json({ surveyUrl, taskId });
});

// ─── WALLET ──────────────────────────────────────────────────

export const walletRouter = Router();

walletRouter.get('/', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.userId!;
  const wallet = await getWallet(userId);
  if (!wallet) { res.status(404).json({ error: 'Wallet not found' }); return; }

  res.json({
    balancePaise: parseInt(wallet.balance_paise),
    balanceFormatted: paiseToRupees(parseInt(wallet.balance_paise)),
    totalEarnedPaise: parseInt(wallet.total_earned_paise),
    totalWithdrawnPaise: parseInt(wallet.total_withdrawn_paise),
    isFrozen: wallet.is_frozen,
  });
});

// ─── HISTORY ─────────────────────────────────────────────────

export const historyRouter = Router();

historyRouter.get('/', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.userId!;
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);
  const offset = parseInt(req.query.offset as string) || 0;

  const txns = await getTransactionHistory(userId, limit, offset);

  res.json({
    transactions: txns.map(t => ({
      id: t.id,
      type: t.type,
      amountPaise: parseInt(t.amount_paise),
      amountFormatted: paiseToRupees(parseInt(t.amount_paise)),
      balanceAfterPaise: parseInt(t.balance_after_paise),
      balanceAfterFormatted: paiseToRupees(parseInt(t.balance_after_paise)),
      description: t.description,
      status: t.status,
      createdAt: t.created_at,
    })),
    hasMore: txns.length === limit,
  });
});

// ─── REFERRAL ─────────────────────────────────────────────────

export const referralRouter = Router();

referralRouter.get('/', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.userId!;
  const info = await getReferralInfo(userId);
  res.json(info);
});
