import { db } from '../db';
import { logger } from '../utils/logger';
import { paiseToRupees } from '../utils/money';

let _bot: any = null;

export function setBot(bot: any) { _bot = bot; }

export async function sendNotification(userId: string, type: string, message: string, metadata?: any): Promise<void> {
  const { rows } = await db.query(`SELECT telegram_id FROM users WHERE id = $1`, [userId]);
  if (!rows[0]) return;

  const { rows: notifRows } = await db.query(
    `INSERT INTO notifications (user_id, type, message, metadata)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [userId, type, message, metadata ? JSON.stringify(metadata) : null]
  );
  const notifId = notifRows[0].id;

  if (!_bot) { logger.warn('Bot not set — cannot send notification'); return; }

  try {
    await _bot.telegram.sendMessage(rows[0].telegram_id, message, { parse_mode: 'HTML' });
    await db.query(
      `UPDATE notifications SET is_sent = TRUE, sent_at = NOW() WHERE id = $1`, [notifId]
    );
  } catch (err: any) {
    logger.error('Failed to send notification', { userId, err: err.message });
    await db.query(
      `UPDATE notifications SET error = $1 WHERE id = $2`,
      [err.message, notifId]
    );
    if (err.message?.includes('bot was blocked')) {
      await db.query(`UPDATE users SET is_bot_blocked = TRUE WHERE id = $1`, [userId]);
    }
  }
}

export async function notifySpinSuccess(userId: string, firstName: string, rewardPaise: number, balancePaise: number) {
  const msg =
    `🎉 Congratulations ${firstName}!\n\n` +
    `🎡 Spin me aapne jeete: ${paiseToRupees(rewardPaise)}\n\n` +
    `💰 Total Balance: ${paiseToRupees(balancePaise)}`;
  await sendNotification(userId, 'SPIN_SUCCESS', msg);
}

export async function notifyWithdrawalProcessing(userId: string, amountPaise: number) {
  const msg =
    `⏳ <b>Withdrawal Processing</b>\n\n` +
    `💸 Amount: ${paiseToRupees(amountPaise)}\n\n` +
    `Your payout is being processed. Please check Withdrawal History for the latest status.`;
  await sendNotification(userId, 'WITHDRAWAL_PROCESSING', msg);
}

export async function notifyWithdrawalSuccess(
  userId: string, amountPaise: number, method: string,
  last4OrUpi: string, balancePaise: number
) {
  let msg = `✅ <b>Withdrawal Successful!</b>\n\n💸 Amount: ${paiseToRupees(amountPaise)}\n`;
  if (method === 'BANK') {
    msg += `🏦 A/c: ••••••••••••${last4OrUpi}\n`;
  } else {
    msg += `🏦 UPI: ${last4OrUpi}\n`;
  }
  msg += `💰 Balance: ${paiseToRupees(balancePaise)}\n\nPaisa kuch hi minute me aapke bank account me pahunch jayega 🚀`;
  await sendNotification(userId, 'WITHDRAWAL_SUCCESS', msg);
}

export async function notifyWithdrawalFailed(userId: string, amountPaise: number, reason?: string) {
  const msg =
    `❌ <b>Withdrawal Failed!</b>\n\n` +
    `💸 Amount: ${paiseToRupees(amountPaise)}\n\n` +
    `⚠️ Reason: ${reason || 'Payment could not be completed.'}\n\n` +
    `💰 Amount has been returned to your balance.`;
  await sendNotification(userId, 'WITHDRAWAL_FAILED', msg);
}

export async function notifyTaskReward(userId: string, rewardPaise: number, taskTitle?: string) {
  const msg =
    `🎯 Task Reward!\n\n` +
    `✅ ${taskTitle || 'Task'} completed\n` +
    `💰 Earned: ${paiseToRupees(rewardPaise)}`;
  await sendNotification(userId, 'TASK_REWARD', msg);
}

export async function notifyReferralReward(userId: string, rewardPaise: number, referredName: string) {
  const msg =
    `👥 Referral Reward!\n\n` +
    `🎉 ${referredName} completed a qualifying activity.\n` +
    `💰 You earned: ${paiseToRupees(rewardPaise)}`;
  await sendNotification(userId, 'REFERRAL_REWARD', msg);
}
