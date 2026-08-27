import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { db } from '../../db';
import { getWallet } from '../../services/wallet';
import { getAllSettings } from '../../services/settings';
import { paiseToRupees } from '../../utils/money';

const router = Router();

/**
 * GET /api/me
 * Returns authenticated user's profile. Uses session — never trusts frontend IDs.
 */
router.get('/me', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.userId!;

  const { rows } = await db.query(
    `SELECT u.first_name, u.last_name, u.username, u.referral_code,
            u.device_account_type, u.referral_eligible, u.risk_level,
            u.created_at, u.last_active_at,
            wa.balance_paise, wa.total_earned_paise, wa.total_withdrawn_paise
     FROM users u
     LEFT JOIN wallet_accounts wa ON wa.user_id = u.id
     WHERE u.id = $1`,
    [userId]
  );

  if (!rows[0]) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  const u = rows[0];

  // Today's earnings
  const { rows: todayRows } = await db.query(
    `SELECT COALESCE(SUM(amount_paise), 0) as today_earned
     FROM wallet_transactions
     WHERE user_id = $1
       AND type IN ('TASK_REWARD','SURVEY_REWARD','SPIN_REWARD','REFERRAL_REWARD','SIGNUP_BONUS')
       AND created_at >= CURRENT_DATE AT TIME ZONE 'Asia/Kolkata'
       AND status = 'COMPLETED'`,
    [userId]
  );

  // Pending rewards
  const { rows: pendingRows } = await db.query(
    `SELECT COALESCE(SUM(amount_paise), 0) as pending
     FROM withdrawals
     WHERE user_id = $1 AND status IN ('PENDING', 'PROCESSING')`,
    [userId]
  );

  res.json({
    firstName: u.first_name,
    lastName: u.last_name,
    username: u.username,
    referralCode: u.referral_eligible && u.device_account_type !== 'SECONDARY_DEVICE_ACCOUNT'
      ? u.referral_code : null,
    deviceAccountType: u.device_account_type,
    referralEligible: u.referral_eligible && u.device_account_type !== 'SECONDARY_DEVICE_ACCOUNT',
    memberSince: u.created_at,
    wallet: {
      balance: parseInt(u.balance_paise || 0),
      balanceFormatted: paiseToRupees(parseInt(u.balance_paise || 0)),
      totalEarned: parseInt(u.total_earned_paise || 0),
      totalWithdrawn: parseInt(u.total_withdrawn_paise || 0),
      todayEarned: parseInt(todayRows[0]?.today_earned || 0),
      pendingRewards: parseInt(pendingRows[0]?.pending || 0),
    },
  });
});

/**
 * GET /api/config
 * Returns app configuration for Mini App rendering.
 * Never includes provider secrets.
 */
router.get('/config', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const settings = await getAllSettings();

  res.json({
    minWithdrawalPaise: parseInt(settings.min_withdrawal_paise || '10000'),
    maxWithdrawalPaise: parseInt(settings.max_withdrawal_paise || '500000'),
    dailyWithdrawalLimit: parseInt(settings.daily_withdrawal_limit || '3'),
    withdrawalEnabled: settings.withdrawal_enabled === 'true',
    bankEnabled: settings.bank_enabled === 'true',
    upiEnabled: settings.upi_enabled === 'true',
    referralEnabled: settings.referral_enabled === 'true',
    referralRewardPaise: parseInt(settings.referral_reward_paise || '5000'),
    taskSystemEnabled: settings.task_system_enabled === 'true',
    maintenanceMode: settings.maintenance_mode === 'true',
    supportUsername: settings.support_username || '',
  });
});

export default router;
