import { Context } from 'telegraf';
import { db } from '../../db';
import { paiseToRupees } from '../../utils/money';
import { blockUser, unblockUser } from '../../services/fraud';
import { setAdminState, clearAdminState } from './index';

export async function handleUsers(ctx: Context, admin: any, subAction: string): Promise<void> {
  if (subAction && subAction.startsWith('page_')) {
    const page = parseInt(subAction.replace('page_', '')) || 0;
    await showUserList(ctx, admin, page);
    return;
  }
  if (subAction && subAction.startsWith('view_')) {
    const userId = subAction.replace('view_', '');
    await showUserDetail(ctx, admin, userId);
    return;
  }
  await showUserList(ctx, admin, 0);
}

async function showUserList(ctx: Context, admin: any, page: number): Promise<void> {
  const limit = 10;
  const offset = page * limit;
  const { rows: users } = await db.query(
    `SELECT u.id, u.telegram_id, u.username, u.first_name, u.status, u.risk_level,
            u.device_account_type, u.created_at, wa.balance_paise
     FROM users u
     LEFT JOIN wallet_accounts wa ON wa.user_id = u.id
     ORDER BY u.created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );

  const { rows: countRows } = await db.query(`SELECT COUNT(*) as total FROM users`);
  const total = parseInt(countRows[0].total);

  let msg = `👥 <b>Users</b> (${offset + 1}–${Math.min(offset + limit, total)} of ${total})\n\n`;
  const userButtons: any[][] = [];

  for (const u of users) {
    const risk = u.risk_level !== 'CLEAN' ? ` ⚠️${u.risk_level}` : '';
    const bal = paiseToRupees(parseInt(u.balance_paise || 0));
    msg += `• <code>${u.telegram_id}</code> ${u.first_name}${u.username ? ' @' + u.username : ''} — ${bal}${risk}\n`;
    userButtons.push([{ text: `${u.first_name} (${u.telegram_id})`, callback_data: `admin:users:view_${u.id}` }]);
  }

  const navButtons: any[] = [];
  if (page > 0) navButtons.push({ text: '◀️ Prev', callback_data: `admin:users:page_${page - 1}` });
  if (offset + limit < total) navButtons.push({ text: 'Next ▶️', callback_data: `admin:users:page_${page + 1}` });

  userButtons.push([{ text: '🔍 Search', callback_data: 'admin:users:search' }]);
  if (navButtons.length) userButtons.push(navButtons);
  userButtons.push([{ text: '◀️ Menu', callback_data: 'admin:menu' }]);

  await ctx.reply(msg, { parse_mode: 'HTML', reply_markup: { inline_keyboard: userButtons } });
}

export async function handleUserSearch(ctx: Context, admin: any, query: string): Promise<void> {
  const isNumeric = /^\d+$/.test(query);
  let rows: any[];

  if (isNumeric) {
    const { rows: r } = await db.query(
      `SELECT u.id, u.telegram_id, u.username, u.first_name, u.status, u.risk_level, wa.balance_paise
       FROM users u LEFT JOIN wallet_accounts wa ON wa.user_id=u.id
       WHERE u.telegram_id=$1`,
      [parseInt(query)]
    );
    rows = r;
  } else {
    const { rows: r } = await db.query(
      `SELECT u.id, u.telegram_id, u.username, u.first_name, u.status, u.risk_level, wa.balance_paise
       FROM users u LEFT JOIN wallet_accounts wa ON wa.user_id=u.id
       WHERE u.username ILIKE $1 OR u.first_name ILIKE $1
       LIMIT 10`,
      [`%${query}%`]
    );
    rows = r;
  }

  if (!rows.length) {
    await ctx.reply('❌ No users found.', { reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin:users' }]] } });
    return;
  }

  const buttons = rows.map(u => [{
    text: `${u.first_name} (${u.telegram_id}) — ${paiseToRupees(parseInt(u.balance_paise || 0))}`,
    callback_data: `admin:users:view_${u.id}`
  }]);
  buttons.push([{ text: '◀️ Back', callback_data: 'admin:users' }]);

  await ctx.reply(`🔍 Search results for "${query}":`, { reply_markup: { inline_keyboard: buttons } });
}

async function showUserDetail(ctx: Context, admin: any, userId: string): Promise<void> {
  const { rows } = await db.query(
    `SELECT u.*, wa.balance_paise, wa.total_earned_paise, wa.total_withdrawn_paise, wa.is_frozen
     FROM users u
     LEFT JOIN wallet_accounts wa ON wa.user_id=u.id
     WHERE u.id=$1`,
    [userId]
  );

  if (!rows[0]) { await ctx.reply('❌ User not found.'); return; }
  const u = rows[0];

  const { rows: taskCount } = await db.query(`SELECT COUNT(*) as c FROM task_sessions WHERE user_id=$1 AND status='COMPLETED'`, [userId]);
  const { rows: wdCount } = await db.query(`SELECT COUNT(*) as c FROM withdrawals WHERE user_id=$1 AND status='SUCCESS'`, [userId]);

  const statusEmoji = u.status === 'ACTIVE' ? '🟢' : '🔴';
  const riskEmoji = u.risk_level === 'CLEAN' ? '✅' : '⚠️';

  const msg =
    `👤 <b>User Details</b>\n\n` +
    `Name: <code>${u.first_name} ${u.last_name || ''}</code>\n` +
    `Username: <code>${u.username ? '@' + u.username : 'None'}</code>\n` +
    `Telegram ID: <code>${u.telegram_id}</code>\n` +
    `Status: ${statusEmoji} <code>${u.status}</code>\n` +
    `Risk: ${riskEmoji} <code>${u.risk_level}</code>\n` +
    `Device Type: <code>${u.device_account_type}</code>\n\n` +
    `💰 Balance: <b>${paiseToRupees(parseInt(u.balance_paise || 0))}</b>\n` +
    `📈 Total Earned: <code>${paiseToRupees(parseInt(u.total_earned_paise || 0))}</code>\n` +
    `📤 Total Withdrawn: <code>${paiseToRupees(parseInt(u.total_withdrawn_paise || 0))}</code>\n` +
    `Wallet Frozen: <code>${u.is_frozen ? 'Yes' : 'No'}</code>\n\n` +
    `🎯 Tasks Completed: <code>${taskCount.rows[0].c}</code>\n` +
    `💳 Successful Withdrawals: <code>${wdCount.rows[0].c}</code>\n` +
    `📅 Registered: <code>${new Date(u.created_at).toLocaleDateString()}</code>\n` +
    `🕐 Last Active: <code>${u.last_active_at ? new Date(u.last_active_at).toLocaleDateString() : 'Never'}</code>`;

  const isBlocked = u.status === 'BLOCKED';
  const keyboard = [
    [
      { text: isBlocked ? '✅ Unblock' : '🚫 Block', callback_data: `admin:user_action:${isBlocked ? 'unblock' : 'block'}_${userId}` },
      { text: u.is_frozen ? '🔓 Unfreeze' : '🧊 Freeze', callback_data: `admin:user_action:${u.is_frozen ? 'unfreeze' : 'freeze'}_${userId}` },
    ],
    [
      { text: u.referral_eligible ? '🚫 Disable Referral' : '✅ Enable Referral', callback_data: `admin:user_action:toggle_referral_${userId}` },
      { text: '💰 Admin Credit', callback_data: `admin:user_action:credit_${userId}` },
    ],
    [{ text: '📜 Transactions', callback_data: `admin:user_action:txns_${userId}` }],
    [{ text: '◀️ Back', callback_data: 'admin:users' }],
  ];

  await ctx.reply(msg, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
}

export async function handleUserAction(ctx: Context, admin: any, subAction: string, text?: string): Promise<void> {
  const telegramId = ctx.from!.id;

  if (subAction.startsWith('block_')) {
    const userId = subAction.replace('block_', '');
    await ctx.reply(`⚠️ Confirm block user?\n\nEnter reason:`, { parse_mode: 'HTML' });
    setAdminState(telegramId, 'USER_BLOCK_REASON', { userId, action: 'block' });
    return;
  }
  if (subAction.startsWith('unblock_')) {
    const userId = subAction.replace('unblock_', '');
    await unblockUser(admin.id, userId);
    await ctx.reply('✅ User unblocked.');
    return;
  }
  if (subAction.startsWith('freeze_')) {
    const userId = subAction.replace('freeze_', '');
    await db.query(`UPDATE wallet_accounts SET is_frozen=TRUE, frozen_reason='Admin action', updated_at=NOW() WHERE user_id=$1`, [userId]);
    await db.query(`INSERT INTO audit_logs (admin_id, action, target_type, target_id) VALUES ($1,'FREEZE_WALLET','user',$2)`, [admin.id, userId]);
    await ctx.reply('✅ Wallet frozen.');
    return;
  }
  if (subAction.startsWith('unfreeze_')) {
    const userId = subAction.replace('unfreeze_', '');
    await db.query(`UPDATE wallet_accounts SET is_frozen=FALSE, frozen_reason=NULL, updated_at=NOW() WHERE user_id=$1`, [userId]);
    await ctx.reply('✅ Wallet unfrozen.');
    return;
  }
  if (subAction.startsWith('toggle_referral_')) {
    const userId = subAction.replace('toggle_referral_', '');
    const { rows } = await db.query(`SELECT referral_eligible FROM users WHERE id=$1`, [userId]);
    const current = rows[0]?.referral_eligible;
    await db.query(`UPDATE users SET referral_eligible=$1 WHERE id=$2`, [!current, userId]);
    await ctx.reply(`✅ Referral ${!current ? 'enabled' : 'disabled'} for user.`);
    return;
  }
  if (subAction.startsWith('search')) {
    setAdminState(telegramId, 'USER_SEARCH', {});
    await ctx.reply('🔍 Enter Telegram ID, username, or name to search:');
    return;
  }
  if (subAction.startsWith('txns_')) {
    const userId = subAction.replace('txns_', '');
    const { rows } = await db.query(
      `SELECT type, amount_paise, status, created_at FROM wallet_transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 10`,
      [userId]
    );
    let msg = `📜 <b>Last 10 Transactions</b>\n\n`;
    for (const tx of rows) {
      msg += `• ${tx.type}: ${paiseToRupees(parseInt(tx.amount_paise))} — ${tx.status} (${new Date(tx.created_at).toLocaleDateString()})\n`;
    }
    await ctx.reply(msg, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin:users' }]] } });
    return;
  }
}
