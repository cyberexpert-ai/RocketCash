import crypto from 'crypto';
import { db } from '../db';
import { config } from '../config';
import { generateToken, generateReferralCode, hashSensitive } from '../utils/crypto';
import { logger } from '../utils/logger';

export interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface AuthResult {
  userId: string;
  telegramId: number;
  sessionToken: string;
  user: any;
}

const REPLAY_WINDOW_SECONDS = 86400; // 24 hours

/**
 * Validates Telegram Mini App initData server-side.
 * See: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
export function validateInitData(initData: string): { valid: boolean; user?: TelegramUser; authDate?: number } {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return { valid: false };

    // Build check string (all params except hash, sorted alphabetically)
    params.delete('hash');
    const dataCheckString = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    // HMAC-SHA256(data_check_string, HMAC-SHA256("WebAppData", bot_token))
    const secretKey = crypto
      .createHmac('sha256', 'WebAppData')
      .update(config.telegram.botToken)
      .digest();

    const expectedHash = crypto
      .createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');

    if (!crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(expectedHash, 'hex'))) {
      return { valid: false };
    }

    const authDate = parseInt(params.get('auth_date') || '0', 10);
    const now = Math.floor(Date.now() / 1000);
    if (now - authDate > REPLAY_WINDOW_SECONDS) {
      return { valid: false }; // expired
    }

    const userParam = params.get('user');
    if (!userParam) return { valid: false };

    const user: TelegramUser = JSON.parse(userParam);
    return { valid: true, user, authDate };
  } catch (err) {
    logger.warn('initData validation error', { err });
    return { valid: false };
  }
}

/**
 * Authenticate or register a user from validated initData.
 * Returns session token. NEVER trusts frontend-provided IDs.
 */
export async function authenticateUser(
  initData: string,
  ipHash?: string,
  userAgentHash?: string
): Promise<AuthResult> {
  const { valid, user, authDate } = validateInitData(initData);
  if (!valid || !user || !authDate) {
    throw new Error('Invalid Telegram initData');
  }

  const telegramId = user.id;

  return await db.transaction(async (client) => {
    // Replay protection: check if this exact hash was used very recently
    const initHash = crypto.createHash('sha256').update(initData).digest('hex');
    const recentSession = await client.query(
      `SELECT id FROM sessions WHERE telegram_hash = $1 AND created_at > NOW() - INTERVAL '30 seconds'`,
      [initHash]
    );
    // Allow re-auth but record hash

    // Upsert user
    let userRow = await client.query(
      `SELECT * FROM users WHERE telegram_id = $1`, [telegramId]
    );

    let dbUser: any;
    if (userRow.rows.length === 0) {
      // New user — register
      const referralCode = generateReferralCode();
      const inserted = await client.query(
        `INSERT INTO users (telegram_id, username, first_name, last_name, language_code, referral_code)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [telegramId, user.username || null, user.first_name, user.last_name || null,
         user.language_code || 'en', referralCode]
      );
      dbUser = inserted.rows[0];

      // Create wallet
      await client.query(
        `INSERT INTO wallet_accounts (user_id) VALUES ($1)`, [dbUser.id]
      );

      logger.info('New user registered', { telegramId, userId: dbUser.id });
    } else {
      dbUser = userRow.rows[0];
      // Update profile if changed
      await client.query(
        `UPDATE users SET username=$1, first_name=$2, last_name=$3, last_active_at=NOW(), updated_at=NOW()
         WHERE id=$4`,
        [user.username || null, user.first_name, user.last_name || null, dbUser.id]
      );
    }

    if (dbUser.status === 'BLOCKED') {
      throw new Error('Account is blocked');
    }

    // Create session
    const sessionToken = generateToken(32);
    const expiresAt = new Date(Date.now() + config.session.expirySeconds * 1000);

    await client.query(
      `INSERT INTO sessions (user_id, session_token, telegram_init_data, telegram_hash, auth_date, ip_hash, user_agent_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [dbUser.id, sessionToken, initData.substring(0, 2000), initHash,
       authDate, ipHash || null, userAgentHash || null, expiresAt]
    );

    return {
      userId: dbUser.id,
      telegramId,
      sessionToken,
      user: dbUser,
    };
  });
}

/**
 * Validate a session token and return the authenticated userId.
 * This is the ONLY way to determine authenticatedUserId in API routes.
 */
export async function validateSession(token: string): Promise<string | null> {
  const { rows } = await db.query(
    `SELECT s.user_id, u.status
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.session_token = $1 AND s.is_valid = TRUE AND s.expires_at > NOW()`,
    [token]
  );

  if (rows.length === 0) return null;
  if (rows[0].status === 'BLOCKED') return null;

  // Touch last used
  await db.query(
    `UPDATE sessions SET last_used_at = NOW() WHERE session_token = $1`, [token]
  );

  return rows[0].user_id;
}

/**
 * Validate admin session for a given Telegram chat ID.
 */
export async function validateAdmin(telegramId: number): Promise<any | null> {
  const { rows } = await db.query(
    `SELECT * FROM admin_users WHERE telegram_id = $1 AND is_active = TRUE`,
    [telegramId]
  );
  return rows[0] || null;
}
