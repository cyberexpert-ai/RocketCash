import { Context } from 'telegraf';
import { validateAdmin } from '../../services/auth';
import { logger } from '../../utils/logger';
import { handleDashboard } from './dashboard';
import { handleUsers, handleUserSearch, handleUserAction } from './users';
import { handleSpinMenu, handleSpinAction } from './spin';
import { handleReferralMenu, handleReferralAction } from './referrals';
import { handleWithdrawalMenu, handleWithdrawalAction } from './withdrawals';
import { handleProvidersMenu, handleProviderAction } from './providers';
import { handleBroadcastMenu, handleBroadcastAction } from './broadcast';
import { handleChannelsMenu, handleChannelAction } from './channels';
import { handleSettingsMenu, handleSettingAction } from './settings';
import { handleFraudMenu, handleFraudAction } from './fraud';
import { handleAuditLogs } from './audit';
import { handleSystemHealth } from './health';
import { handleAdminsMenu, handleAdminAction } from './admins';

// Admin conversation state stored in session
const adminStates: Map<number, { state: string; data: any }> = new Map();

export function getAdminState(telegramId: number) {
  return adminStates.get(telegramId) || { state: 'MENU', data: {} };
}

export function setAdminState(telegramId: number, state: string, data: any = {}) {
  adminStates.set(telegramId, { state, data });
}

export function clearAdminState(telegramId: number) {
  adminStates.delete(telegramId);
}

export async function sendMainAdminMenu(ctx: Context, admin: any): Promise<void> {
  clearAdminState(ctx.from!.id);

  const hasPermission = (perm: string) =>
    admin.role === 'SUPER_ADMIN' || (admin.permissions || []).includes(perm);

  const rows: any[][] = [];

  if (hasPermission('VIEW_DASHBOARD'))
    rows.push([{ text: '📊 Dashboard', callback_data: 'admin:dashboard' }]);

  const row2 = [];
  if (hasPermission('VIEW_USERS')) row2.push({ text: '👥 Users', callback_data: 'admin:users' });
  if (hasPermission('MANAGE_TASKS')) row2.push({ text: '🎯 Tasks', callback_data: 'admin:tasks' });
  if (row2.length) rows.push(row2);

  const row3 = [];
  if (hasPermission('MANAGE_SPINS')) row3.push({ text: '🎡 Spin', callback_data: 'admin:spin' });
  if (hasPermission('MANAGE_REFERRALS')) row3.push({ text: '👥 Referrals', callback_data: 'admin:referrals' });
  if (row3.length) rows.push(row3);

  const row4 = [];
  if (hasPermission('MANAGE_WITHDRAWALS')) row4.push({ text: '💰 Withdrawals', callback_data: 'admin:withdrawals' });
  if (hasPermission('MANAGE_PAYOUTS')) row4.push({ text: '💳 Payouts', callback_data: 'admin:payouts' });
  if (row4.length) rows.push(row4);

  if (hasPermission('MANAGE_CHANNELS'))
    rows.push([{ text: '🛡 Fraud/Risk', callback_data: 'admin:fraud' }, { text: '📢 Channels', callback_data: 'admin:channels' }]);

  const row6 = [];
  if (hasPermission('SEND_BOT_BROADCAST')) row6.push({ text: '📢 Bot Broadcast', callback_data: 'admin:broadcast_bot' });
  if (hasPermission('SEND_CHANNEL_BROADCAST')) row6.push({ text: '📣 Channel Broadcast', callback_data: 'admin:broadcast_channel' });
  if (row6.length) rows.push(row6);

  const row7 = [];
  if (hasPermission('MANAGE_PROVIDER_SETTINGS')) row7.push({ text: '🔌 API / Providers', callback_data: 'admin:providers' });
  if (hasPermission('MANAGE_SYSTEM_SETTINGS')) row7.push({ text: '⚙️ Settings', callback_data: 'admin:settings' });
  if (row7.length) rows.push(row7);

  const row8 = [];
  if (hasPermission('IMPORT_DATA')) row8.push({ text: '📥 Import', callback_data: 'admin:import' });
  if (hasPermission('EXPORT_DATA')) row8.push({ text: '📤 Export', callback_data: 'admin:export' });
  if (row8.length) rows.push(row8);

  if (hasPermission('VIEW_AUDIT_LOGS'))
    rows.push([{ text: '📋 Audit Logs', callback_data: 'admin:audit' }, { text: '❤️ System Health', callback_data: 'admin:health' }]);

  if (admin.role === 'SUPER_ADMIN')
    rows.push([{ text: '👮 Admins', callback_data: 'admin:admins' }]);

  await ctx.reply(
    `🔐 <b>RocketCash Admin Panel</b>\n\nWelcome, ${admin.first_name || 'Admin'}!\nRole: <code>${admin.role}</code>`,
    {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: rows },
    }
  );
}

async function verifyCallback(ctx: Context): Promise<any | null> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return null;
  const admin = await validateAdmin(telegramId);
  if (!admin) {
    await ctx.answerCbQuery('❌ Unauthorized');
    return null;
  }
  return admin;
}

export async function handleAdminCallback(ctx: Context): Promise<void> {
  const cbData = (ctx.callbackQuery as any)?.data;
  if (!cbData || !cbData.startsWith('admin:')) return;

  const admin = await verifyCallback(ctx);
  if (!admin) return;

  await ctx.answerCbQuery();

  const [, action, ...parts] = cbData.split(':');
  const subAction = parts.join(':');

  try {
    switch (action) {
      case 'menu': await sendMainAdminMenu(ctx, admin); break;
      case 'dashboard': await handleDashboard(ctx, admin); break;
      case 'users': await handleUsers(ctx, admin, subAction); break;
      case 'user_action': await handleUserAction(ctx, admin, subAction); break;
      case 'spin': await handleSpinMenu(ctx, admin); break;
      case 'spin_action': await handleSpinAction(ctx, admin, subAction); break;
      case 'referrals': await handleReferralMenu(ctx, admin); break;
      case 'referral_action': await handleReferralAction(ctx, admin, subAction); break;
      case 'withdrawals': await handleWithdrawalMenu(ctx, admin, subAction); break;
      case 'withdrawal_action': await handleWithdrawalAction(ctx, admin, subAction); break;
      case 'payouts': await handleWithdrawalMenu(ctx, admin, 'payouts'); break;
      case 'providers': await handleProvidersMenu(ctx, admin); break;
      case 'provider_action': await handleProviderAction(ctx, admin, subAction); break;
      case 'broadcast_bot': await handleBroadcastMenu(ctx, admin, 'BOT'); break;
      case 'broadcast_channel': await handleBroadcastMenu(ctx, admin, 'CHANNEL'); break;
      case 'broadcast_action': await handleBroadcastAction(ctx, admin, subAction); break;
      case 'channels': await handleChannelsMenu(ctx, admin); break;
      case 'channel_action': await handleChannelAction(ctx, admin, subAction); break;
      case 'settings': await handleSettingsMenu(ctx, admin); break;
      case 'setting_action': await handleSettingAction(ctx, admin, subAction); break;
      case 'fraud': await handleFraudMenu(ctx, admin); break;
      case 'fraud_action': await handleFraudAction(ctx, admin, subAction); break;
      case 'audit': await handleAuditLogs(ctx, admin, subAction); break;
      case 'health': await handleSystemHealth(ctx, admin); break;
      case 'admins': await handleAdminsMenu(ctx, admin); break;
      case 'admin_action': await handleAdminAction(ctx, admin, subAction); break;
      default: await ctx.reply('Unknown action'); break;
    }
  } catch (err: any) {
    logger.error('Admin callback error', { action, err: err.message });
    await ctx.reply(`⚠️ Error: ${err.message}`);
  }
}

export async function handleAdminText(ctx: Context, admin: any): Promise<void> {
  const telegramId = ctx.from!.id;
  const state = getAdminState(telegramId);
  const text = (ctx.message as any)?.text;

  if (!text || text.startsWith('/')) return;

  try {
    switch (true) {
      case state.state.startsWith('PROVIDER_INPUT_'):
        await handleProviderAction(ctx, admin, state.state, text);
        break;
      case state.state.startsWith('SPIN_INPUT_'):
        await handleSpinAction(ctx, admin, state.state, text);
        break;
      case state.state.startsWith('SETTING_INPUT_'):
        await handleSettingAction(ctx, admin, state.state, text);
        break;
      case state.state.startsWith('BROADCAST_INPUT_'):
        await handleBroadcastAction(ctx, admin, state.state, text);
        break;
      case state.state.startsWith('USER_SEARCH'):
        await handleUserSearch(ctx, admin, text);
        break;
      case state.state.startsWith('ADMIN_INPUT_'):
        await handleAdminAction(ctx, admin, state.state, text);
        break;
      case state.state.startsWith('CHANNEL_INPUT_'):
        await handleChannelAction(ctx, admin, state.state, text);
        break;
      default:
        break;
    }
  } catch (err: any) {
    logger.error('Admin text handler error', { state: state.state, err: err.message });
    await ctx.reply(`⚠️ Error: ${err.message}`);
  }
}
