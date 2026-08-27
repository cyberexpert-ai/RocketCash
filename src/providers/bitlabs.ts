import axios from 'axios';
import { db } from '../db';
import { decrypt } from '../utils/crypto';
import { verifyHmacSha256 } from '../utils/crypto';
import { logger } from '../utils/logger';

async function getBitLabsCredentials(): Promise<{ apiToken: string; appId: string; callbackSecret: string } | null> {
  const { rows } = await db.query(
    `SELECT
      (SELECT encrypted_value FROM encrypted_secrets WHERE provider_name='bitlabs' AND key_name='api_token') as token_enc,
      (SELECT encrypted_value FROM encrypted_secrets WHERE provider_name='bitlabs' AND key_name='app_id') as app_id_enc,
      (SELECT encrypted_value FROM encrypted_secrets WHERE provider_name='bitlabs' AND key_name='callback_secret') as secret_enc,
      pc.is_active
     FROM provider_configs pc WHERE pc.provider_name = 'bitlabs'`
  );

  if (!rows[0] || !rows[0].is_active || !rows[0].token_enc) return null;

  try {
    return {
      apiToken: decrypt(rows[0].token_enc),
      appId: rows[0].app_id_enc ? decrypt(rows[0].app_id_enc) : '',
      callbackSecret: rows[0].secret_enc ? decrypt(rows[0].secret_enc) : '',
    };
  } catch {
    return null;
  }
}

/**
 * Get survey/task offers for a user from BitLabs.
 * https://api.bitlabs.ai/docs
 */
export async function getBitLabsTasks(userId: string, userTelegramId: number): Promise<any[]> {
  const creds = await getBitLabsCredentials();
  if (!creds) return [];

  try {
    const response = await axios.get('https://api.bitlabs.ai/v2/client/offers', {
      headers: {
        'X-Api-Token': creds.apiToken,
        'X-User-Id': userTelegramId.toString(),
      },
      timeout: 10000,
    });

    return response.data?.data?.offers || [];
  } catch (err: any) {
    logger.error('BitLabs task fetch failed', { err: err.message });
    return [];
  }
}

/**
 * Get BitLabs survey URL for a user.
 */
export async function getBitLabsSurveyUrl(userTelegramId: number): Promise<string | null> {
  const creds = await getBitLabsCredentials();
  if (!creds) return null;
  return `https://web.bitlabs.ai?token=${creds.apiToken}&uid=${userTelegramId}`;
}

/**
 * Validate BitLabs callback/webhook signature.
 * Uses HMAC-SHA256 of the payload with the callback secret.
 */
export async function validateBitLabsCallback(payload: string, signature: string): Promise<boolean> {
  const creds = await getBitLabsCredentials();
  if (!creds || !creds.callbackSecret) return false;
  return verifyHmacSha256(payload, signature, creds.callbackSecret);
}

/**
 * Process a BitLabs reward callback.
 * Returns the user's telegram ID and reward amount.
 */
export function parseBitLabsCallback(body: any): {
  userId: string;
  transactionId: string;
  rewardCents: number;
  currency: string;
  status: string;
} | null {
  try {
    // BitLabs sends: uid (our user ID), val (reward), currency, transaction_id, status
    return {
      userId: body.uid?.toString(),
      transactionId: body.transaction_id?.toString(),
      rewardCents: Math.round(parseFloat(body.val || '0') * 100),
      currency: body.currency || 'INR',
      status: body.status || 'COMPLETED',
    };
  } catch {
    return null;
  }
}

/**
 * Convert BitLabs reward to paise.
 * BitLabs typically pays in USD cents; convert to INR paise.
 */
export function convertToPaise(valueCents: number, currency: string, exchangeRate = 83): number {
  if (currency === 'INR') return valueCents;
  if (currency === 'USD') return Math.round(valueCents * exchangeRate);
  return valueCents;
}

/**
 * Test BitLabs connection.
 */
export async function testBitLabsConnection(): Promise<{ connected: boolean; message: string }> {
  const creds = await getBitLabsCredentials();
  if (!creds) return { connected: false, message: 'BitLabs not configured' };

  try {
    const response = await axios.get('https://api.bitlabs.ai/v2/client/offers', {
      headers: {
        'X-Api-Token': creds.apiToken,
        'X-User-Id': 'test',
      },
      timeout: 10000,
    });
    return { connected: true, message: `Connected — ${response.status}` };
  } catch (err: any) {
    return { connected: false, message: err.response?.data?.message || err.message };
  }
}
