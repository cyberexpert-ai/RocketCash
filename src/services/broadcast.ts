import { db } from '../db';
import { logger } from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';

let _bot: any = null;
export function setBot(bot: any) { _bot = bot; }

export interface BroadcastMessage {
  type: 'text' | 'photo' | 'video' | 'document';
  text?: string;
  mediaId?: string;
  buttons?: { text: string; url?: string; callback?: string }[][];
}

export type AudienceType = 'ALL' | 'ACTIVE' | 'WITH_BALANCE' | 'TASK_USERS' | 'WITHDREW';

async function getAudienceUserIds(audienceType: AudienceType): Promise<string[]> {
  let query = '';
  switch (audienceType) {
    case 'ALL':
      query = `SELECT DISTINCT u.id FROM users u WHERE u.status = 'ACTIVE' AND u.is_bot_blocked = FALSE`;
      break;
    case 'ACTIVE':
      query = `SELECT DISTINCT u.id FROM users u WHERE u.status = 'ACTIVE' AND u.is_bot_blocked = FALSE AND u.last_active_at > NOW() - INTERVAL '30 days'`;
      break;
    case 'WITH_BALANCE':
      query = `SELECT DISTINCT u.id FROM users u JOIN wallet_accounts wa ON wa.user_id = u.id WHERE u.status = 'ACTIVE' AND u.is_bot_blocked = FALSE AND wa.balance_paise > 0`;
      break;
    case 'TASK_USERS':
      query = `SELECT DISTINCT u.id FROM users u JOIN task_sessions ts ON ts.user_id = u.id WHERE u.status = 'ACTIVE' AND u.is_bot_blocked = FALSE`;
      break;
    case 'WITHDREW':
      query = `SELECT DISTINCT u.id FROM users u JOIN withdrawals w ON w.user_id = u.id WHERE u.status = 'ACTIVE' AND u.is_bot_blocked = FALSE AND w.status = 'SUCCESS'`;
      break;
    default:
      query = `SELECT id FROM users WHERE status = 'ACTIVE' AND is_bot_blocked = FALSE`;
  }
  const { rows } = await db.query(query);
  return rows.map((r: any) => r.id);
}

export async function createBroadcast(
  adminId: string,
  audienceType: AudienceType,
  message: BroadcastMessage
): Promise<string> {
  const broadcastId = uuidv4();
  await db.query(
    `INSERT INTO broadcasts (id, type, created_by, audience_type, message_type, message_text, message_media_id, message_buttons, status)
     VALUES ($1, 'BOT', $2, $3, $4, $5, $6, $7, 'DRAFT')`,
    [broadcastId, adminId, audienceType, message.type, message.text || null,
     message.mediaId || null, message.buttons ? JSON.stringify(message.buttons) : null]
  );
  return broadcastId;
}

export async function sendBroadcast(broadcastId: string, adminId: string): Promise<{
  total: number; successful: number; failed: number;
}> {
  if (!_bot) throw new Error('Bot not initialized');

  const { rows: broadcasts } = await db.query(`SELECT * FROM broadcasts WHERE id=$1`, [broadcastId]);
  if (!broadcasts[0]) throw new Error('Broadcast not found');
  const broadcast = broadcasts[0];

  const userIds = await getAudienceUserIds(broadcast.audience_type as AudienceType);

  await db.query(
    `UPDATE broadcasts SET status='SENDING', total_recipients=$1, updated_at=NOW() WHERE id=$2`,
    [userIds.length, broadcastId]
  );

  let successful = 0, failed = 0;

  // Get telegram IDs
  for (const userId of userIds) {
    const { rows: users } = await db.query(`SELECT telegram_id FROM users WHERE id=$1`, [userId]);
    if (!users[0]) continue;

    try {
      const extra: any = { parse_mode: 'HTML' };
      if (broadcast.message_buttons) {
        extra.reply_markup = {
          inline_keyboard: broadcast.message_buttons.map((row: any[]) =>
            row.map(btn => ({ text: btn.text, ...(btn.url ? { url: btn.url } : { callback_data: btn.callback }) }))
          ),
        };
      }

      if (broadcast.message_type === 'text') {
        await _bot.telegram.sendMessage(users[0].telegram_id, broadcast.message_text, extra);
      } else if (broadcast.message_type === 'photo') {
        await _bot.telegram.sendPhoto(users[0].telegram_id, broadcast.message_media_id, { caption: broadcast.message_text, ...extra });
      }

      await db.query(
        `INSERT INTO broadcast_recipients (broadcast_id, user_id, status, sent_at) VALUES ($1,$2,'SENT',NOW())
         ON CONFLICT DO NOTHING`,
        [broadcastId, userId]
      );
      successful++;
    } catch (err: any) {
      failed++;
      if (err.message?.includes('bot was blocked')) {
        await db.query(`UPDATE users SET is_bot_blocked=TRUE WHERE id=$1`, [userId]);
      }
    }

    // Rate limit protection
    await new Promise(r => setTimeout(r, 50));
  }

  await db.query(
    `UPDATE broadcasts SET status='COMPLETED', successful_count=$1, failed_count=$2, sent_at=NOW(), updated_at=NOW() WHERE id=$3`,
    [successful, failed, broadcastId]
  );

  logger.info('Broadcast completed', { broadcastId, successful, failed });
  return { total: userIds.length, successful, failed };
}

export async function sendChannelBroadcast(
  channelIds: string[],
  message: BroadcastMessage,
  adminId: string
): Promise<{ channelId: string; status: string; error?: string }[]> {
  if (!_bot) throw new Error('Bot not initialized');

  const results = [];
  for (const channelId of channelIds) {
    const { rows: channels } = await db.query(
      `SELECT * FROM required_channels WHERE id=$1 AND is_active=TRUE AND broadcast_enabled=TRUE`,
      [channelId]
    );
    if (!channels[0]) {
      results.push({ channelId, status: 'FAILED', error: 'Channel not found or not active' });
      continue;
    }

    const channel = channels[0];
    if (!channel.telegram_chat_id) {
      results.push({ channelId, status: 'FAILED', error: 'No chat ID configured' });
      continue;
    }

    try {
      // Check permission first
      const member = await _bot.telegram.getChatMember(channel.telegram_chat_id, _bot.botInfo.id);
      if (!['administrator', 'creator'].includes(member.status)) {
        results.push({ channelId, status: 'FAILED', error: 'Bot is not admin in channel' });
        continue;
      }

      await _bot.telegram.sendMessage(channel.telegram_chat_id, message.text || '', { parse_mode: 'HTML' });
      results.push({ channelId, status: 'SUCCESS' });
    } catch (err: any) {
      results.push({ channelId, status: 'FAILED', error: err.message });
    }
  }

  return results;
}
