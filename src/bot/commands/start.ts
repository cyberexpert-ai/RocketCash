import { Context } from 'telegraf';
import { config } from '../../config';
import { db } from '../../db';
import { processReferralCode } from '../../services/referral';
import { logger } from '../../utils/logger';

export async function handleStart(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id;
  const firstName = ctx.from?.first_name || 'User';

  if (!telegramId) return;

  // Handle referral code from deep link: /start ref_XXXXX
  const text = (ctx.message as any)?.text || '';
  const match = text.match(/\/start ref_([A-Z0-9]+)/i);
  if (match) {
    const referralCode = match[1].toUpperCase();
    try {
      // Find user by telegram ID if they exist
      const { rows } = await db.query(`SELECT id FROM users WHERE telegram_id=$1`, [telegramId]);
      if (rows[0]) {
        await processReferralCode(rows[0].id, referralCode);
      }
    } catch (err: any) {
      logger.warn('Referral code processing failed', { err: err.message });
    }
  }

  await ctx.reply(
    `🔥 Hey and welcome to RocketCash, ${firstName}!\n\n` +
    `🎯 Complete genuine tasks and surveys to earn rewards.\n\n` +
    `📢 Join our official channels for announcements and updates.`,
    {
      reply_markup: {
        inline_keyboard: [[{
          text: '🎁 OPEN REWARD APP',
          web_app: { url: config.miniAppUrl },
        }]],
      },
    }
  );

  // Log the start event
  logger.info('User started bot', { telegramId });
}
