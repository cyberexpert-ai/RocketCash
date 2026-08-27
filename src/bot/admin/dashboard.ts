import { Context } from 'telegraf';
import { db } from '../../db';
import { paiseToRupees } from '../../utils/money';
import { testBitLabsConnection } from '../../providers/bitlabs';
import { testConnection as testRazorpayX } from '../../providers/razorpayx';

export async function handleDashboard(ctx: Context, admin: any): Promise<void> {
  const stats = await getDashboardStats();

  const bitlabsStatus = stats.bitlabsConnected ? '🟢 CONNECTED' : '🔴 DISCONNECTED';
  const razorpayStatus = stats.razorpayConnected ? '🟢 CONNECTED' : '🔴 DISCONNECTED';
  const dbStatus = stats.dbHealthy ? '🟢 ONLINE' : '🔴 OFFLINE';

  const msg =
    `📊 <b>RocketCash Dashboard</b>\n\n` +
    `<b>👥 Users</b>\n` +
    `Total: <code>${stats.totalUsers}</code>\n` +
    `Today: <code>${stats.todayUsers}</code>\n` +
    `Active (30d): <code>${stats.activeUsers}</code>\n\n` +
    `<b>🎯 Tasks</b>\n` +
    `Completions: <code>${stats.taskCompletions}</code>\n` +
    `Rewards: <code>${paiseToRupees(stats.taskRewardsPaise)}</code>\n\n` +
    `<b>🎡 Spin</b>\n` +
    `Rewards: <code>${paiseToRupees(stats.spinRewardsPaise)}</code>\n\n` +
    `<b>💰 Withdrawals</b>\n` +
    `Pending: <code>${stats.pendingWithdrawals}</code>\n` +
    `Processing: <code>${stats.processingWithdrawals}</code>\n` +
    `Success: <code>${stats.successWithdrawals}</code>\n` +
    `Failed: <code>${stats.failedWithdrawals}</code>\n` +
    `Total Paid: <code>${paiseToRupees(stats.totalPaidPaise)}</code>\n\n` +
    `<b>🛡 Fraud</b>\n` +
    `High Risk: <code>${stats.highRiskUsers}</code>\n` +
    `Fraud Flags: <code>${stats.openFraudFlags}</code>\n\n` +
    `<b>🔌 Services</b>\n` +
    `BitLabs: ${bitlabsStatus}\n` +
    `RazorpayX: ${razorpayStatus}\n` +
    `Database: ${dbStatus}`;

  await ctx.editMessageText(msg, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔄 Refresh', callback_data: 'admin:dashboard' }],
        [{ text: '◀️ Menu', callback_data: 'admin:menu' }],
      ],
    },
  }).catch(() => ctx.reply(msg, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔄 Refresh', callback_data: 'admin:dashboard' }],
        [{ text: '◀️ Menu', callback_data: 'admin:menu' }],
      ],
    },
  }));
}

async function getDashboardStats() {
  const [users, withdrawals, tasks, spinRewards, referralRewards, fraud, dbHealthy] =
    await Promise.all([
      db.query(`
        SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE) as today,
          COUNT(*) FILTER (WHERE last_active_at >= NOW() - INTERVAL '30 days') as active
        FROM users
      `),
      db.query(`
        SELECT
          COUNT(*) FILTER (WHERE status='PENDING') as pending,
          COUNT(*) FILTER (WHERE status='PROCESSING') as processing,
          COUNT(*) FILTER (WHERE status='SUCCESS') as success,
          COUNT(*) FILTER (WHERE status='FAILED' OR status='REVERSED') as failed,
          COALESCE(SUM(amount_paise) FILTER (WHERE status='SUCCESS'), 0) as total_paid
        FROM withdrawals
      `),
      db.query(`
        SELECT COUNT(*) as completions, COALESCE(SUM(amount_paise), 0) as rewards
        FROM wallet_transactions WHERE type IN ('TASK_REWARD','SURVEY_REWARD','OFFER_REWARD')
      `),
      db.query(`SELECT COALESCE(SUM(amount_paise), 0) as rewards FROM wallet_transactions WHERE type='SPIN_REWARD'`),
      db.query(`SELECT COALESCE(SUM(amount_paise), 0) as rewards FROM wallet_transactions WHERE type='REFERRAL_REWARD'`),
      db.query(`
        SELECT
          COUNT(*) FILTER (WHERE risk_level IN ('HIGH_RISK','BLOCKED')) as high_risk
        FROM users
      `),
      db.query(`SELECT 1`).then(() => true).catch(() => false),
    ]);

  const openFraudFlags = await db.query(`SELECT COUNT(*) as count FROM fraud_flags WHERE admin_reviewed=FALSE`);

  // Test provider connections (cached)
  const [bitlabsResult, razorpayResult] = await Promise.allSettled([
    testBitLabsConnection(),
    testRazorpayX(),
  ]);

  return {
    totalUsers: parseInt(users.rows[0].total),
    todayUsers: parseInt(users.rows[0].today),
    activeUsers: parseInt(users.rows[0].active),
    pendingWithdrawals: parseInt(withdrawals.rows[0].pending),
    processingWithdrawals: parseInt(withdrawals.rows[0].processing),
    successWithdrawals: parseInt(withdrawals.rows[0].success),
    failedWithdrawals: parseInt(withdrawals.rows[0].failed),
    totalPaidPaise: parseInt(withdrawals.rows[0].total_paid),
    taskCompletions: parseInt(tasks.rows[0].completions),
    taskRewardsPaise: parseInt(tasks.rows[0].rewards),
    spinRewardsPaise: parseInt(spinRewards.rows[0].rewards),
    highRiskUsers: parseInt(fraud.rows[0].high_risk),
    openFraudFlags: parseInt(openFraudFlags.rows[0].count),
    bitlabsConnected: bitlabsResult.status === 'fulfilled' && bitlabsResult.value.connected,
    razorpayConnected: razorpayResult.status === 'fulfilled' && razorpayResult.value.connected,
    dbHealthy,
  };
}
