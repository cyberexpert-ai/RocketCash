import { db } from '../db';
import { creditWallet } from './wallet';
import { getSetting } from './settings';
import { notifyReferralReward } from './notification';
import { logger } from '../utils/logger';

export async function getReferralInfo(userId: string): Promise<any> {
  const user = await db.query(`SELECT id, referral_code, referral_eligible, device_account_type FROM users WHERE id = $1`, [userId]);
  if (!user.rows[0]) return null;

  const u = user.rows[0];

  // Secondary accounts cannot refer
  if (u.device_account_type === 'SECONDARY_DEVICE_ACCOUNT') {
    return { eligible: false, reason: 'Referral feature is unavailable for this account.' };
  }

  if (!u.referral_eligible) {
    return { eligible: false, reason: 'Referral feature has been disabled for your account.' };
  }

  const referralEnabled = (await getSetting('referral_enabled')) === 'true';
  if (!referralEnabled) {
    return { eligible: false, reason: 'Referral feature is currently unavailable.' };
  }

  const referralCode = u.referral_code;
  const appUrl = process.env.MINI_APP_URL || '';

  const { rows: stats } = await db.query(
    `SELECT
      COUNT(*) as total_referrals,
      SUM(CASE WHEN is_valid THEN 1 ELSE 0 END) as valid_referrals,
      COALESCE(SUM(reward_paise), 0) as total_earnings_paise
     FROM referrals WHERE referrer_user_id = $1`,
    [userId]
  );

  const { rows: recent } = await db.query(
    `SELECT r.id, r.status, r.is_valid, r.reward_paise, r.created_at,
            u.first_name, u.username
     FROM referrals r JOIN users u ON u.id = r.referred_user_id
     WHERE r.referrer_user_id = $1
     ORDER BY r.created_at DESC LIMIT 10`,
    [userId]
  );

  return {
    eligible: true,
    referralCode,
    referralLink: `https://t.me/RocketCashRobot?start=ref_${referralCode}`,
    stats: stats.rows[0],
    recentReferrals: recent,
  };
}

export async function processReferralCode(newUserId: string, referralCode: string): Promise<void> {
  if (!referralCode) return;

  const { rows: referrers } = await db.query(
    `SELECT id, referral_eligible, device_account_type FROM users WHERE referral_code = $1`,
    [referralCode]
  );

  if (!referrers[0]) return;
  const referrer = referrers[0];

  if (referrer.id === newUserId) return; // self-referral
  if (!referrer.referral_eligible) return;

  // Check secondary account
  const { rows: newUsers } = await db.query(
    `SELECT device_account_type FROM users WHERE id = $1`, [newUserId]
  );
  if (newUsers[0]?.device_account_type === 'SECONDARY_DEVICE_ACCOUNT') return;

  // Check if already referred
  const { rows: existing } = await db.query(
    `SELECT id FROM referrals WHERE referred_user_id = $1`, [newUserId]
  );
  if (existing.length > 0) return;

  await db.query(
    `INSERT INTO referrals (referrer_user_id, referred_user_id, status)
     VALUES ($1, $2, 'PENDING')
     ON CONFLICT DO NOTHING`,
    [referrer.id, newUserId]
  );

  logger.info('Referral recorded', { referrerId: referrer.id, referredId: newUserId });
}

/**
 * Called when a referred user completes qualifying activity.
 */
export async function triggerReferralReward(userId: string, activityType: string): Promise<void> {
  const qualifyingActivity = await getSetting('referral_qualifying_activity') || 'FIRST_WITHDRAWAL';
  if (activityType !== qualifyingActivity) return;

  const referralEnabled = (await getSetting('referral_enabled')) === 'true';
  if (!referralEnabled) return;

  const { rows: referrals } = await db.query(
    `SELECT r.*, u.first_name as referred_first_name
     FROM referrals r
     JOIN users u ON u.id = r.referred_user_id
     WHERE r.referred_user_id = $1 AND r.is_valid = FALSE AND r.status = 'PENDING'`,
    [userId]
  );

  if (!referrals[0]) return;
  const referral = referrals[0];

  // Check daily referral limit
  const dailyLimit = parseInt(await getSetting('daily_referral_limit') || '10');
  const { rows: todayCount } = await db.query(
    `SELECT COUNT(*) as count FROM referrals
     WHERE referrer_user_id = $1 AND is_valid = TRUE
       AND qualifying_activity_at >= CURRENT_DATE AT TIME ZONE 'Asia/Kolkata'`,
    [referral.referrer_user_id]
  );
  if (parseInt(todayCount[0].count) >= dailyLimit) {
    logger.info('Referral daily limit reached for referrer', { referrerId: referral.referrer_user_id });
    return;
  }

  const rewardPaise = parseInt(await getSetting('referral_reward_paise') || '5000');

  await db.transaction(async (client) => {
    const tx = await creditWallet({
      userId: referral.referrer_user_id,
      amountPaise: rewardPaise,
      type: 'REFERRAL_REWARD',
      referenceId: referral.id,
      referenceType: 'referral',
      idempotencyKey: `referral_reward_${referral.id}`,
      description: `Referral reward for ${referral.referred_first_name}`,
      client,
    });

    await client.query(
      `UPDATE referrals SET is_valid = TRUE, status = 'REWARDED',
       qualifying_activity_at = NOW(), reward_paise = $1, referrer_wallet_tx_id = $2, updated_at = NOW()
       WHERE id = $3`,
      [rewardPaise, tx.id, referral.id]
    );
  });

  await notifyReferralReward(referral.referrer_user_id, rewardPaise, referral.referred_first_name);
  logger.info('Referral reward paid', { referralId: referral.id, rewardPaise });
}
