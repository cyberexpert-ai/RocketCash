import { Context } from 'telegraf';
import { validateAdmin } from '../../services/auth';
import { logger } from '../../utils/logger';
import { sendMainAdminMenu } from '../admin/index';

export async function handleSuperadmin(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  // Verify admin
  const admin = await validateAdmin(telegramId);

  if (!admin) {
    // Do NOT reveal admin existence or details
    await ctx.reply('❌ Unauthorized access.');
    logger.warn('Unauthorized /Superadmin attempt', { telegramId });
    return;
  }

  // Update last active
  const { db } = await import('../../db');
  await db.query(`UPDATE admin_users SET last_active_at=NOW() WHERE telegram_id=$1`, [telegramId]);

  logger.info('Admin accessed panel', { telegramId, adminId: admin.id, role: admin.role });
  await sendMainAdminMenu(ctx, admin);
}
