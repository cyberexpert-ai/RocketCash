import { Telegraf, session } from 'telegraf';
import { config } from '../config';
import { logger } from '../utils/logger';
import { validateAdmin } from '../services/auth';
import { handleStart } from './commands/start';
import { handleSuperadmin } from './commands/superadmin';
import { handleAdminCallback } from './admin/index';
import { setBot as setNotifBot } from '../services/notification';
import { setBot as setBroadcastBot } from '../services/broadcast';

export const bot = new Telegraf(config.telegram.botToken);

// Session middleware
bot.use(session());

// /start command — only user command that opens Mini App
bot.command('start', handleStart);

// /Superadmin — admin-only command
bot.command('Superadmin', handleSuperadmin);
bot.command('superadmin', handleSuperadmin);

// Block all other commands for users
const restrictedCommands = ['balance', 'tasks', 'spin', 'refer', 'referral', 'withdraw', 'cashout', 'history', 'wallet', 'profile', 'settings'];
for (const cmd of restrictedCommands) {
  bot.command(cmd, async (ctx) => {
    await ctx.reply(
      '📱 Please open the RocketCash Mini App to continue.',
      {
        reply_markup: {
          inline_keyboard: [[{
            text: '🎁 OPEN REWARD APP',
            web_app: { url: config.miniAppUrl },
          }]],
        },
      }
    );
  });
}

// Admin callback queries
bot.on('callback_query', handleAdminCallback);

// Admin text input handling (for multi-step flows)
bot.on('text', async (ctx) => {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  // Check if this is an admin in a conversation flow
  const admin = await validateAdmin(telegramId);
  if (admin) {
    const { handleAdminText } = await import('./admin/index');
    await handleAdminText(ctx, admin);
    return;
  }

  // For regular users — no text commands, just guide to Mini App
});

// Error handling
bot.catch((err: any, ctx) => {
  logger.error('Bot error', { err: err.message, updateType: ctx.updateType });
});

export function initBot() {
  setNotifBot(bot);
  setBroadcastBot(bot);
  logger.info('Bot initialized');
}

export async function setupWebhook(webhookUrl: string): Promise<void> {
  await bot.telegram.setWebhook(webhookUrl, {
    secret_token: config.telegram.webhookSecret,
  });
  logger.info('Webhook set', { webhookUrl });
}
