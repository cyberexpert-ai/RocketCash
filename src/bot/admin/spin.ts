import { Context } from 'telegraf';
import { db } from '../../db';
import { paiseToRupees } from '../../utils/money';
import { getAdminState, setAdminState, clearAdminState } from './index';
import { setSetting } from '../../services/settings';

export async function handleSpinMenu(ctx: Context, admin: any): Promise<void> {
  const { rows } = await db.query(`SELECT * FROM spin_configs ORDER BY updated_at DESC LIMIT 1`);
  const cfg = rows[0];

  const rewardOptions = cfg?.reward_options?.join(', ') || 'Not set';
  const status = cfg?.is_enabled ? '🟢 Enabled' : '🔴 Disabled';

  const msg =
    `🎡 <b>Spin Configuration</b>\n\n` +
    `Status: ${status}\n` +
    `Daily Limit: <code>${cfg?.daily_limit || 1}</code>\n` +
    `Signup Spins: <code>${cfg?.signup_spins || 1}</code>\n` +
    `Fixed Reward: <code>${cfg?.is_fixed_reward ? '✅ Yes' : '❌ No'}</code>\n` +
    (cfg?.is_fixed_reward ? `Fixed Amount: <code>${paiseToRupees(cfg?.fixed_reward_paise || 0)}</code>\n` : '') +
    `Reward Options (paise): <code>${rewardOptions}</code>\n` +
    `Weights: <code>${cfg?.reward_weights?.join(', ') || 'Not set'}</code>`;

  await ctx.reply(msg, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [
          { text: cfg?.is_enabled ? '🔴 Disable Spin' : '🟢 Enable Spin', callback_data: 'admin:spin_action:toggle' },
        ],
        [{ text: '⚙️ Edit Settings', callback_data: 'admin:spin_action:edit' }],
        [{ text: '◀️ Menu', callback_data: 'admin:menu' }],
      ],
    },
  });
}

export async function handleSpinAction(ctx: Context, admin: any, subAction: string, text?: string): Promise<void> {
  const telegramId = ctx.from!.id;
  const state = getAdminState(telegramId);

  if (text && state.state.startsWith('SPIN_INPUT_')) {
    await handleSpinTextInput(ctx, admin, state, text);
    return;
  }

  switch (subAction) {
    case 'toggle': {
      const { rows } = await db.query(`SELECT is_enabled FROM spin_configs ORDER BY updated_at DESC LIMIT 1`);
      const current = rows[0]?.is_enabled;
      await db.query(
        `UPDATE spin_configs SET is_enabled=$1, updated_at=NOW() WHERE id=(SELECT id FROM spin_configs ORDER BY updated_at DESC LIMIT 1)`,
        [!current]
      );
      await db.query(
        `INSERT INTO audit_logs (admin_id, action, new_value) VALUES ($1, 'TOGGLE_SPIN', $2)`,
        [admin.id, JSON.stringify({ is_enabled: !current })]
      );
      await ctx.reply(`✅ Spin is now ${!current ? '🟢 Enabled' : '🔴 Disabled'}`);
      await handleSpinMenu(ctx, admin);
      break;
    }
    case 'edit':
      setAdminState(telegramId, 'SPIN_INPUT_DAILY_LIMIT', { step: 'daily_limit' });
      await ctx.reply(
        `⚙️ <b>Edit Spin Settings</b>\n\nStep 1 — Enter <b>Daily Spin Limit</b> (number):`,
        { parse_mode: 'HTML' }
      );
      break;
  }
}

async function handleSpinTextInput(ctx: Context, admin: any, state: any, text: string): Promise<void> {
  const telegramId = ctx.from!.id;
  const step = state.data?.step || state.state.replace('SPIN_INPUT_', '').toLowerCase();

  switch (step) {
    case 'daily_limit': {
      const val = parseInt(text);
      if (isNaN(val) || val < 1) { await ctx.reply('❌ Invalid number. Enter daily limit (e.g. 1):'); return; }
      setAdminState(telegramId, 'SPIN_INPUT_SIGNUP_SPINS', { ...state.data, daily_limit: val, step: 'signup_spins' });
      await ctx.reply(`Step 2 — Enter <b>Signup Spins</b> (number):`, { parse_mode: 'HTML' });
      break;
    }
    case 'signup_spins': {
      const val = parseInt(text);
      if (isNaN(val) || val < 0) { await ctx.reply('❌ Invalid. Enter signup spins (e.g. 1):'); return; }
      setAdminState(telegramId, 'SPIN_INPUT_REWARDS', { ...state.data, signup_spins: val, step: 'rewards' });
      await ctx.reply(`Step 3 — Enter <b>Reward Options</b> in paise, comma-separated:\n(e.g. 100,200,500,1000,2000,5000)`, { parse_mode: 'HTML' });
      break;
    }
    case 'rewards': {
      const options = text.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n) && n > 0);
      if (options.length < 2) { await ctx.reply('❌ Enter at least 2 values, comma-separated:'); return; }
      setAdminState(telegramId, 'SPIN_INPUT_WEIGHTS', { ...state.data, reward_options: options, step: 'weights' });
      await ctx.reply(`Step 4 — Enter <b>Reward Weights</b> (must match count above = ${options.length}), comma-separated:\n(e.g. 30,25,20,15,8,2)`, { parse_mode: 'HTML' });
      break;
    }
    case 'weights': {
      const weights = text.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n) && n > 0);
      const data = state.data;
      if (weights.length !== data.reward_options.length) {
        await ctx.reply(`❌ Weights count must match options count (${data.reward_options.length})`);
        return;
      }
      await db.query(
        `UPDATE spin_configs SET daily_limit=$1, signup_spins=$2, reward_options=$3, reward_weights=$4, updated_at=NOW()
         WHERE id=(SELECT id FROM spin_configs ORDER BY updated_at DESC LIMIT 1)`,
        [data.daily_limit, data.signup_spins, JSON.stringify(data.reward_options), JSON.stringify(weights)]
      );
      await db.query(
        `INSERT INTO audit_logs (admin_id, action, new_value) VALUES ($1, 'UPDATE_SPIN_CONFIG', $2)`,
        [admin.id, JSON.stringify({ daily_limit: data.daily_limit, reward_options: data.reward_options })]
      );
      clearAdminState(telegramId);
      await ctx.reply(`✅ <b>Spin settings updated!</b>`, { parse_mode: 'HTML' });
      await handleSpinMenu(ctx, admin);
      break;
    }
  }
}
