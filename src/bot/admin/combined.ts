import { Context } from 'telegraf';
import { db } from '../../db';
import { paiseToRupees } from '../../utils/money';
import { setSetting, getAllSettings } from '../../services/settings';
import { getFraudSummary, blockUser, unblockUser } from '../../services/fraud';
import { setAdminState, clearAdminState, getAdminState } from './index';
import { sendBroadcast, createBroadcast } from '../../services/broadcast';

// ============================================================
// REFERRALS
// ============================================================

export async function handleReferralMenu(ctx: Context, admin: any): Promise<void> {
  const { rows: cfg } = await db.query(`SELECT value FROM admin_settings WHERE key='referral_enabled'`);
  const enabled = cfg[0]?.value === 'true';
  const { rows: stats } = await db.query(`SELECT COUNT(*) as total, SUM(CASE WHEN is_valid THEN 1 ELSE 0 END) as valid, COALESCE(SUM(reward_paise),0) as paid FROM referrals`);
  const s = stats[0];

  const msg =
    `👥 <b>Referral System</b>\n\n` +
    `Status: ${enabled ? '🟢 Enabled' : '🔴 Disabled'}\n\n` +
    `Total Referrals: <code>${s.total}</code>\n` +
    `Valid Referrals: <code>${s.valid}</code>\n` +
    `Total Paid: <code>${paiseToRupees(parseInt(s.paid))}</code>`;

  await ctx.reply(msg, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: enabled ? '🔴 Disable Referrals' : '🟢 Enable Referrals', callback_data: 'admin:referral_action:toggle' }],
        [{ text: '⚙️ Edit Settings', callback_data: 'admin:referral_action:edit' }],
        [{ text: '📋 Recent Referrals', callback_data: 'admin:referral_action:list' }],
        [{ text: '◀️ Menu', callback_data: 'admin:menu' }],
      ],
    },
  });
}

export async function handleReferralAction(ctx: Context, admin: any, subAction: string, text?: string): Promise<void> {
  switch (subAction) {
    case 'toggle': {
      const { rows } = await db.query(`SELECT value FROM admin_settings WHERE key='referral_enabled'`);
      const current = rows[0]?.value === 'true';
      await setSetting('referral_enabled', (!current).toString(), admin.id);
      await ctx.reply(`✅ Referral ${!current ? '🟢 Enabled' : '🔴 Disabled'}`);
      break;
    }
    case 'edit':
      await ctx.reply(
        `⚙️ <b>Referral Settings</b>\n\nUse /Superadmin → Settings to edit:`,
        {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [
            [{ text: '⚙️ Go to Settings', callback_data: 'admin:settings' }],
            [{ text: '◀️ Back', callback_data: 'admin:referrals' }],
          ] },
        }
      );
      break;
    case 'list': {
      const { rows } = await db.query(
        `SELECT r.*, u1.first_name as referrer_name, u2.first_name as referred_name
         FROM referrals r
         JOIN users u1 ON u1.id=r.referrer_user_id
         JOIN users u2 ON u2.id=r.referred_user_id
         ORDER BY r.created_at DESC LIMIT 15`
      );
      let msg = `📋 <b>Recent Referrals</b>\n\n`;
      for (const r of rows) {
        msg += `• ${r.referrer_name} → ${r.referred_name}: ${r.is_valid ? '✅' : '⏳'} ${r.is_valid ? paiseToRupees(parseInt(r.reward_paise)) : 'pending'}\n`;
      }
      await ctx.reply(msg, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin:referrals' }]] } });
      break;
    }
  }
}

// ============================================================
// WITHDRAWALS
// ============================================================

export async function handleWithdrawalMenu(ctx: Context, admin: any, subAction: string): Promise<void> {
  const { rows: stats } = await db.query(
    `SELECT status, COUNT(*) as count, COALESCE(SUM(amount_paise),0) as total
     FROM withdrawals GROUP BY status`
  );

  const byStatus: Record<string, any> = {};
  for (const s of stats) byStatus[s.status] = s;

  const msg =
    `💰 <b>Withdrawals</b>\n\n` +
    `Pending: <code>${byStatus.PENDING?.count || 0}</code> (${paiseToRupees(parseInt(byStatus.PENDING?.total || 0))})\n` +
    `Processing: <code>${byStatus.PROCESSING?.count || 0}</code>\n` +
    `Success: <code>${byStatus.SUCCESS?.count || 0}</code> (${paiseToRupees(parseInt(byStatus.SUCCESS?.total || 0))})\n` +
    `Failed: <code>${byStatus.FAILED?.count || 0}</code>\n` +
    `Reversed: <code>${byStatus.REVERSED?.count || 0}</code>`;

  await ctx.reply(msg, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '⏳ Pending Withdrawals', callback_data: 'admin:withdrawal_action:pending' }],
        [{ text: '⚙️ Withdrawal Settings', callback_data: 'admin:withdrawal_action:settings' }],
        [{ text: '◀️ Menu', callback_data: 'admin:menu' }],
      ],
    },
  });
}

export async function handleWithdrawalAction(ctx: Context, admin: any, subAction: string, text?: string): Promise<void> {
  if (subAction === 'pending') {
    const { rows } = await db.query(
      `SELECT w.id, w.method, w.amount_paise, w.created_at, u.first_name, u.telegram_id,
              ba.account_number_last4, ua.upi_id
       FROM withdrawals w
       JOIN users u ON u.id=w.user_id
       LEFT JOIN bank_accounts ba ON ba.id=w.bank_account_id
       LEFT JOIN upi_accounts ua ON ua.id=w.upi_account_id
       WHERE w.status='PENDING'
       ORDER BY w.created_at ASC LIMIT 10`
    );

    if (!rows.length) { await ctx.reply('✅ No pending withdrawals.'); return; }

    let msg = `⏳ <b>Pending Withdrawals</b>\n\n`;
    const buttons: any[][] = [];
    for (const w of rows) {
      const dest = w.method === 'BANK' ? `••••${w.account_number_last4}` : w.upi_id;
      msg += `• ${w.first_name} (${w.telegram_id}): ${paiseToRupees(parseInt(w.amount_paise))} → ${w.method} ${dest}\n`;
      buttons.push([
        { text: `✅ Approve ${paiseToRupees(parseInt(w.amount_paise))}`, callback_data: `admin:withdrawal_action:approve_${w.id}` },
        { text: `❌ Reject`, callback_data: `admin:withdrawal_action:reject_${w.id}` },
      ]);
    }
    buttons.push([{ text: '◀️ Back', callback_data: 'admin:withdrawals' }]);
    await ctx.reply(msg, { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
    return;
  }

  if (subAction.startsWith('approve_')) {
    const wId = subAction.replace('approve_', '');
    await db.query(
      `INSERT INTO scheduled_jobs (job_type, payload, next_run_at) VALUES ('PROCESS_PAYOUT',$1,NOW())`,
      [JSON.stringify({ withdrawalId: wId })]
    );
    await db.query(`INSERT INTO audit_logs (admin_id,action,target_type,target_id) VALUES ($1,'APPROVE_WITHDRAWAL','withdrawal',$2)`, [admin.id, wId]);
    await ctx.reply('✅ Withdrawal approved — payout job queued.');
    return;
  }

  if (subAction.startsWith('reject_')) {
    const wId = subAction.replace('reject_', '');
    const { reverseWithdrawal } = await import('../../services/withdrawal');
    await reverseWithdrawal(wId, 'Rejected by admin');
    await db.query(`UPDATE withdrawals SET status='REJECTED', admin_note='Rejected by admin', updated_at=NOW() WHERE id=$1`, [wId]);
    await db.query(`INSERT INTO audit_logs (admin_id,action,target_type,target_id) VALUES ($1,'REJECT_WITHDRAWAL','withdrawal',$2)`, [admin.id, wId]);
    await ctx.reply('✅ Withdrawal rejected — funds returned to user.');
    return;
  }

  if (subAction === 'settings') {
    await ctx.reply('⚙️ Use Settings menu to configure withdrawal limits.', {
      reply_markup: { inline_keyboard: [[{ text: '⚙️ Settings', callback_data: 'admin:settings' }], [{ text: '◀️ Back', callback_data: 'admin:withdrawals' }]] }
    });
  }
}

// ============================================================
// SETTINGS
// ============================================================

const EDITABLE_SETTINGS = [
  { key: 'min_withdrawal_paise', label: 'Min Withdrawal (paise)', type: 'number' },
  { key: 'max_withdrawal_paise', label: 'Max Withdrawal (paise)', type: 'number' },
  { key: 'daily_withdrawal_limit', label: 'Daily Withdrawal Limit', type: 'number' },
  { key: 'withdrawal_enabled', label: 'Withdrawal Enabled', type: 'bool' },
  { key: 'bank_enabled', label: 'Bank Enabled', type: 'bool' },
  { key: 'upi_enabled', label: 'UPI Enabled', type: 'bool' },
  { key: 'auto_payout_enabled', label: 'Auto Payout', type: 'bool' },
  { key: 'manual_approval_required', label: 'Manual Approval Required', type: 'bool' },
  { key: 'referral_enabled', label: 'Referral Enabled', type: 'bool' },
  { key: 'referral_reward_paise', label: 'Referral Reward (paise)', type: 'number' },
  { key: 'daily_referral_limit', label: 'Daily Referral Limit', type: 'number' },
  { key: 'task_system_enabled', label: 'Task System Enabled', type: 'bool' },
  { key: 'signup_bonus_paise', label: 'Signup Bonus (paise, 0=off)', type: 'number' },
  { key: 'maintenance_mode', label: 'Maintenance Mode', type: 'bool' },
  { key: 'support_username', label: 'Support Username', type: 'text' },
];

export async function handleSettingsMenu(ctx: Context, admin: any): Promise<void> {
  const all = await getAllSettings();
  let msg = `⚙️ <b>System Settings</b>\n\n`;
  for (const s of EDITABLE_SETTINGS) {
    const val = all[s.key] || 'not set';
    msg += `• ${s.label}: <code>${val}</code>\n`;
  }

  const buttons = EDITABLE_SETTINGS.map(s => [{
    text: `✏️ ${s.label}`,
    callback_data: `admin:setting_action:edit_${s.key}`,
  }]);
  buttons.push([{ text: '◀️ Menu', callback_data: 'admin:menu' }]);

  await ctx.reply(msg, { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
}

export async function handleSettingAction(ctx: Context, admin: any, subAction: string, text?: string): Promise<void> {
  const telegramId = ctx.from!.id;
  const state = getAdminState(telegramId);

  if (text && state.state.startsWith('SETTING_INPUT_')) {
    const key = state.state.replace('SETTING_INPUT_', '');
    await setSetting(key, text.trim(), admin.id);
    await db.query(`INSERT INTO audit_logs (admin_id,action,target_type,new_value) VALUES ($1,'UPDATE_SETTING','setting',$2)`, [admin.id, JSON.stringify({ key, value: text.trim() })]);
    clearAdminState(telegramId);
    await ctx.reply(`✅ <b>${key}</b> updated to: <code>${text.trim()}</code>`, { parse_mode: 'HTML' });
    return;
  }

  if (subAction.startsWith('edit_')) {
    const key = subAction.replace('edit_', '');
    const s = EDITABLE_SETTINGS.find(x => x.key === key);
    if (!s) return;

    if (s.type === 'bool') {
      const { rows } = await db.query(`SELECT value FROM admin_settings WHERE key=$1`, [key]);
      const current = rows[0]?.value === 'true';
      await setSetting(key, (!current).toString(), admin.id);
      await ctx.reply(`✅ <b>${s.label}</b> set to: <code>${!current}</code>`, { parse_mode: 'HTML' });
      await handleSettingsMenu(ctx, admin);
      return;
    }

    setAdminState(telegramId, `SETTING_INPUT_${key}`, { key });
    await ctx.reply(`✏️ Enter new value for <b>${s.label}</b>:`, { parse_mode: 'HTML' });
  }
}

// ============================================================
// FRAUD
// ============================================================

export async function handleFraudMenu(ctx: Context, admin: any): Promise<void> {
  const summary = await getFraudSummary();

  const msg =
    `🛡 <b>Fraud & Risk</b>\n\n` +
    `⚠️ High Risk Users: <code>${summary.highRiskUsers.length}</code>\n` +
    `🚩 Open Fraud Flags: <code>${summary.fraudFlags.length}</code>\n` +
    `📱 Multi-Account Groups: <code>${summary.multipleAccounts.length}</code>`;

  await ctx.reply(msg, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '⚠️ High Risk Users', callback_data: 'admin:fraud_action:high_risk' }],
        [{ text: '🚩 Fraud Flags', callback_data: 'admin:fraud_action:flags' }],
        [{ text: '📱 Multi-Account Groups', callback_data: 'admin:fraud_action:multi' }],
        [{ text: '◀️ Menu', callback_data: 'admin:menu' }],
      ],
    },
  });
}

export async function handleFraudAction(ctx: Context, admin: any, subAction: string): Promise<void> {
  switch (subAction) {
    case 'high_risk': {
      const summary = await getFraudSummary();
      let msg = `⚠️ <b>High Risk Users</b>\n\n`;
      for (const u of summary.highRiskUsers.slice(0, 15)) {
        msg += `• <code>${u.telegram_id}</code> ${u.first_name}: ${u.risk_level} (${u.device_account_type})\n`;
      }
      await ctx.reply(msg, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin:fraud' }]] } });
      break;
    }
    case 'flags': {
      const summary = await getFraudSummary();
      let msg = `🚩 <b>Open Fraud Flags</b>\n\n`;
      for (const f of summary.fraudFlags.slice(0, 15)) {
        msg += `• <code>${f.telegram_id}</code> ${f.first_name}: ${f.flag_type}\n`;
      }
      await ctx.reply(msg, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin:fraud' }]] } });
      break;
    }
    case 'multi': {
      const summary = await getFraudSummary();
      let msg = `📱 <b>Multi-Account Groups</b>\n\n`;
      for (const g of summary.multipleAccounts.slice(0, 15)) {
        msg += `• Group: ${g.account_count} accounts — Risk: ${g.risk_level}\n`;
      }
      await ctx.reply(msg, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin:fraud' }]] } });
      break;
    }
  }
}

// ============================================================
// AUDIT LOGS
// ============================================================

export async function handleAuditLogs(ctx: Context, admin: any, subAction: string): Promise<void> {
  const { rows } = await db.query(
    `SELECT al.action, al.target_type, al.reason, al.created_at, au.first_name as admin_name
     FROM audit_logs al
     LEFT JOIN admin_users au ON au.id=al.admin_id
     ORDER BY al.created_at DESC LIMIT 20`
  );

  let msg = `📋 <b>Audit Logs</b> (last 20)\n\n`;
  for (const log of rows) {
    msg += `• [${new Date(log.created_at).toLocaleDateString()}] ${log.admin_name || 'System'}: <code>${log.action}</code>`;
    if (log.target_type) msg += ` on ${log.target_type}`;
    if (log.reason) msg += ` — ${log.reason}`;
    msg += '\n';
  }

  await ctx.reply(msg, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '◀️ Menu', callback_data: 'admin:menu' }]] } });
}

// ============================================================
// SYSTEM HEALTH
// ============================================================

export async function handleSystemHealth(ctx: Context, admin: any): Promise<void> {
  const { db: dbConn } = await import('../../db');
  const dbHealthy = await dbConn.healthCheck();

  const { rows: jobStats } = await db.query(
    `SELECT status, COUNT(*) as count FROM scheduled_jobs GROUP BY status`
  );
  const jobs: Record<string, number> = {};
  for (const j of jobStats) jobs[j.status] = parseInt(j.count);

  const { rows: pendingNotifs } = await db.query(`SELECT COUNT(*) as c FROM notifications WHERE is_sent=FALSE AND created_at > NOW()-INTERVAL '1 hour'`);

  const msg =
    `❤️ <b>System Health</b>\n\n` +
    `🗄 Database: ${dbHealthy ? '🟢 ONLINE' : '🔴 OFFLINE'}\n` +
    `🤖 Web Service: 🟢 ONLINE\n\n` +
    `<b>Scheduled Jobs</b>\n` +
    `Pending: <code>${jobs.PENDING || 0}</code>\n` +
    `Running: <code>${jobs.RUNNING || 0}</code>\n` +
    `Failed: <code>${jobs.FAILED || 0}</code>\n` +
    `Completed: <code>${jobs.COMPLETED || 0}</code>\n\n` +
    `<b>Notifications</b>\n` +
    `Unsent (1h): <code>${pendingNotifs.rows[0].c}</code>`;

  await ctx.reply(msg, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🔄 Refresh', callback_data: 'admin:health' }, { text: '◀️ Menu', callback_data: 'admin:menu' }]] } });
}

// ============================================================
// ADMINS
// ============================================================

export async function handleAdminsMenu(ctx: Context, admin: any): Promise<void> {
  if (admin.role !== 'SUPER_ADMIN') { await ctx.reply('❌ Unauthorized.'); return; }

  const { rows: admins } = await db.query(
    `SELECT id, telegram_id, username, first_name, role, is_active, last_active_at FROM admin_users ORDER BY created_at`
  );

  let msg = `👮 <b>Admin Users</b>\n\n`;
  const buttons: any[][] = [];
  for (const a of admins) {
    const status = a.is_active ? '🟢' : '🔴';
    msg += `${status} <code>${a.telegram_id}</code> ${a.first_name || ''} — <b>${a.role}</b>\n`;
    if (a.telegram_id !== admin.telegram_id) {
      buttons.push([{ text: `${status} ${a.first_name} (${a.role})`, callback_data: `admin:admin_action:view_${a.id}` }]);
    }
  }

  buttons.push([{ text: '➕ Add Admin', callback_data: 'admin:admin_action:add' }]);
  buttons.push([{ text: '◀️ Menu', callback_data: 'admin:menu' }]);

  await ctx.reply(msg, { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
}

export async function handleAdminAction(ctx: Context, admin: any, subAction: string, text?: string): Promise<void> {
  if (admin.role !== 'SUPER_ADMIN') { await ctx.reply('❌ Unauthorized.'); return; }
  const telegramId = ctx.from!.id;
  const state = getAdminState(telegramId);

  if (text && state.state.startsWith('ADMIN_INPUT_')) {
    if (state.state === 'ADMIN_INPUT_TG_ID') {
      const tgId = parseInt(text);
      if (isNaN(tgId)) { await ctx.reply('❌ Invalid Telegram ID.'); return; }
      setAdminState(telegramId, 'ADMIN_INPUT_ROLE', { telegram_id: tgId });
      await ctx.reply('Select role:', {
        reply_markup: { inline_keyboard: [
          [{ text: 'ADMIN', callback_data: 'admin:admin_action:set_role_ADMIN' }],
          [{ text: 'FINANCE', callback_data: 'admin:admin_action:set_role_FINANCE' }],
          [{ text: 'SUPPORT', callback_data: 'admin:admin_action:set_role_SUPPORT' }],
          [{ text: 'ANALYST', callback_data: 'admin:admin_action:set_role_ANALYST' }],
        ] }
      });
    }
    return;
  }

  if (subAction === 'add') {
    setAdminState(telegramId, 'ADMIN_INPUT_TG_ID', {});
    await ctx.reply('Enter new admin\'s <b>Telegram ID</b>:', { parse_mode: 'HTML' });
    return;
  }

  if (subAction.startsWith('set_role_')) {
    const role = subAction.replace('set_role_', '') as any;
    const data = state.data || {};
    const { telegram_id } = data;

    if (!telegram_id) { clearAdminState(telegramId); return; }

    await db.query(
      `INSERT INTO admin_users (telegram_id, role, is_active, created_by)
       VALUES ($1, $2, TRUE, $3)
       ON CONFLICT (telegram_id) DO UPDATE SET role=$2, is_active=TRUE, updated_at=NOW()`,
      [telegram_id, role, admin.id]
    );
    await db.query(`INSERT INTO audit_logs (admin_id,action,new_value) VALUES ($1,'ADD_ADMIN',$2)`, [admin.id, JSON.stringify({ telegram_id, role })]);
    clearAdminState(telegramId);
    await ctx.reply(`✅ Admin added: <code>${telegram_id}</code> as <b>${role}</b>`, { parse_mode: 'HTML' });
    return;
  }

  if (subAction.startsWith('view_')) {
    const aId = subAction.replace('view_', '');
    const { rows } = await db.query(`SELECT * FROM admin_users WHERE id=$1`, [aId]);
    if (!rows[0]) return;
    const a = rows[0];
    await ctx.reply(
      `👮 <b>${a.first_name || 'Admin'}</b>\nTelegram: <code>${a.telegram_id}</code>\nRole: ${a.role}\nStatus: ${a.is_active ? '🟢 Active' : '🔴 Inactive'}`,
      {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [
          [{ text: a.is_active ? '🔴 Deactivate' : '🟢 Activate', callback_data: `admin:admin_action:toggle_${a.id}` }],
          [{ text: '◀️ Back', callback_data: 'admin:admins' }],
        ] }
      }
    );
    return;
  }

  if (subAction.startsWith('toggle_')) {
    const aId = subAction.replace('toggle_', '');
    const { rows } = await db.query(`SELECT is_active FROM admin_users WHERE id=$1`, [aId]);
    const current = rows[0]?.is_active;
    await db.query(`UPDATE admin_users SET is_active=$1, updated_at=NOW() WHERE id=$2`, [!current, aId]);
    await ctx.reply(`✅ Admin ${!current ? 'activated' : 'deactivated'}.`);
  }
}

// ============================================================
// BROADCAST
// ============================================================

export async function handleBroadcastMenu(ctx: Context, admin: any, type: 'BOT' | 'CHANNEL'): Promise<void> {
  const msg = type === 'BOT'
    ? `📢 <b>Bot Broadcast</b>\n\nSend a message to your users.`
    : `📣 <b>Channel Broadcast</b>\n\nSend a message to your channels.`;

  const keyboard = [
    [{ text: '✉️ New Broadcast', callback_data: `admin:broadcast_action:new_${type}` }],
    [{ text: '📋 Broadcast History', callback_data: `admin:broadcast_action:history_${type}` }],
    [{ text: '◀️ Menu', callback_data: 'admin:menu' }],
  ];

  await ctx.reply(msg, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
}

export async function handleBroadcastAction(ctx: Context, admin: any, subAction: string, text?: string): Promise<void> {
  const telegramId = ctx.from!.id;
  const state = getAdminState(telegramId);

  if (text && state.state === 'BROADCAST_INPUT_MESSAGE') {
    const { type, audience } = state.data;
    const broadcastId = await createBroadcast(admin.id, audience, { type: 'text', text });
    setAdminState(telegramId, 'BROADCAST_PREVIEW', { broadcastId, type, text });

    await ctx.reply(
      `📋 <b>Broadcast Preview</b>\n\n${text}\n\n<i>Audience: ${audience}</i>`,
      {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [
          [{ text: '✅ CONFIRM & SEND', callback_data: `admin:broadcast_action:confirm_${broadcastId}` }],
          [{ text: '❌ CANCEL', callback_data: `admin:broadcast_action:cancel_${broadcastId}` }],
        ] }
      }
    );
    return;
  }

  if (subAction.startsWith('new_')) {
    const type = subAction.replace('new_', '') as 'BOT' | 'CHANNEL';
    if (type === 'BOT') {
      await ctx.reply('Select audience:', {
        reply_markup: { inline_keyboard: [
          [{ text: '👥 All Users', callback_data: 'admin:broadcast_action:audience_ALL' }],
          [{ text: '✅ Active Users (30d)', callback_data: 'admin:broadcast_action:audience_ACTIVE' }],
          [{ text: '💰 Users With Balance', callback_data: 'admin:broadcast_action:audience_WITH_BALANCE' }],
          [{ text: '🎯 Task Users', callback_data: 'admin:broadcast_action:audience_TASK_USERS' }],
          [{ text: '◀️ Back', callback_data: 'admin:broadcast_bot' }],
        ] }
      });
    }
    return;
  }

  if (subAction.startsWith('audience_')) {
    const audience = subAction.replace('audience_', '') as any;
    setAdminState(telegramId, 'BROADCAST_INPUT_MESSAGE', { type: 'BOT', audience });
    await ctx.reply('✉️ Type your broadcast message:');
    return;
  }

  if (subAction.startsWith('confirm_')) {
    const broadcastId = subAction.replace('confirm_', '');
    await ctx.reply('📢 Sending broadcast...');
    try {
      const result = await sendBroadcast(broadcastId, admin.id);
      clearAdminState(telegramId);
      await ctx.reply(
        `✅ <b>Broadcast Complete!</b>\n\nTotal: <code>${result.total}</code>\nSuccessful: <code>${result.successful}</code>\nFailed: <code>${result.failed}</code>`,
        { parse_mode: 'HTML' }
      );
    } catch (err: any) {
      await ctx.reply(`❌ Broadcast failed: ${err.message}`);
    }
    return;
  }

  if (subAction.startsWith('cancel_')) {
    clearAdminState(telegramId);
    const broadcastId = subAction.replace('cancel_', '');
    await db.query(`UPDATE broadcasts SET status='CANCELLED' WHERE id=$1`, [broadcastId]);
    await ctx.reply('❌ Broadcast cancelled.');
    return;
  }

  if (subAction.startsWith('history_')) {
    const { rows } = await db.query(
      `SELECT id, type, audience_type, status, successful_count, failed_count, created_at
       FROM broadcasts ORDER BY created_at DESC LIMIT 10`
    );
    let msg = `📋 <b>Broadcast History</b>\n\n`;
    for (const b of rows) {
      msg += `• [${new Date(b.created_at).toLocaleDateString()}] ${b.type} → ${b.audience_type || b.status}: ✅${b.successful_count} ❌${b.failed_count}\n`;
    }
    await ctx.reply(msg, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin:broadcast_bot' }]] } });
  }
}

// ============================================================
// CHANNELS
// ============================================================

export async function handleChannelsMenu(ctx: Context, admin: any): Promise<void> {
  const { rows: channels } = await db.query(`SELECT * FROM required_channels ORDER BY created_at`);

  let msg = `📢 <b>Channels</b>\n\n`;
  const buttons: any[][] = [];

  for (const ch of channels) {
    const status = ch.is_active ? '🟢' : '🔴';
    msg += `${status} ${ch.name}`;
    if (ch.telegram_username) msg += ` (@${ch.telegram_username})`;
    msg += '\n';
    buttons.push([{ text: `${status} ${ch.name}`, callback_data: `admin:channel_action:view_${ch.id}` }]);
  }

  buttons.push([{ text: '➕ Add Channel', callback_data: 'admin:channel_action:add' }]);
  buttons.push([{ text: '◀️ Menu', callback_data: 'admin:menu' }]);

  await ctx.reply(msg || '📢 No channels configured.', { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
}

export async function handleChannelAction(ctx: Context, admin: any, subAction: string, text?: string): Promise<void> {
  const telegramId = ctx.from!.id;
  const state = getAdminState(telegramId);

  if (text && state.state === 'CHANNEL_INPUT_NAME') {
    setAdminState(telegramId, 'CHANNEL_INPUT_USERNAME', { name: text });
    await ctx.reply('Enter Telegram @username (without @):');
    return;
  }
  if (text && state.state === 'CHANNEL_INPUT_USERNAME') {
    setAdminState(telegramId, 'CHANNEL_INPUT_CHATID', { ...state.data, username: text });
    await ctx.reply('Enter Telegram Chat ID (e.g. -1001234567890):');
    return;
  }
  if (text && state.state === 'CHANNEL_INPUT_CHATID') {
    const chatId = parseInt(text);
    if (isNaN(chatId)) { await ctx.reply('❌ Invalid Chat ID.'); return; }
    const d = state.data;
    await db.query(
      `INSERT INTO required_channels (name, telegram_username, telegram_chat_id, is_active, broadcast_enabled)
       VALUES ($1, $2, $3, TRUE, TRUE)`,
      [d.name, d.username, chatId]
    );
    clearAdminState(telegramId);
    await ctx.reply(`✅ Channel <b>${d.name}</b> added!`, { parse_mode: 'HTML' });
    await handleChannelsMenu(ctx, admin);
    return;
  }

  if (subAction === 'add') {
    setAdminState(telegramId, 'CHANNEL_INPUT_NAME', {});
    await ctx.reply('Enter channel <b>display name</b>:', { parse_mode: 'HTML' });
    return;
  }

  if (subAction.startsWith('view_')) {
    const chId = subAction.replace('view_', '');
    const { rows } = await db.query(`SELECT * FROM required_channels WHERE id=$1`, [chId]);
    if (!rows[0]) return;
    const ch = rows[0];
    await ctx.reply(
      `📢 <b>${ch.name}</b>\nUsername: @${ch.telegram_username || 'N/A'}\nChat ID: <code>${ch.telegram_chat_id || 'N/A'}</code>\nActive: ${ch.is_active ? '🟢' : '🔴'}`,
      {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [
          [{ text: ch.is_active ? '🔴 Deactivate' : '🟢 Activate', callback_data: `admin:channel_action:toggle_${ch.id}` }],
          [{ text: '🗑 Delete', callback_data: `admin:channel_action:delete_${ch.id}` }],
          [{ text: '◀️ Back', callback_data: 'admin:channels' }],
        ] }
      }
    );
  }

  if (subAction.startsWith('toggle_')) {
    const chId = subAction.replace('toggle_', '');
    const { rows } = await db.query(`SELECT is_active FROM required_channels WHERE id=$1`, [chId]);
    await db.query(`UPDATE required_channels SET is_active=$1 WHERE id=$2`, [!rows[0]?.is_active, chId]);
    await ctx.reply('✅ Channel status updated.');
  }

  if (subAction.startsWith('delete_')) {
    const chId = subAction.replace('delete_', '');
    await db.query(`DELETE FROM required_channels WHERE id=$1`, [chId]);
    await ctx.reply('🗑 Channel deleted.');
    await handleChannelsMenu(ctx, admin);
  }
}
