import axios from 'axios';
import { db } from '../db';
import { decrypt } from '../utils/crypto';
import { logger } from '../utils/logger';
import { verifyHmacSha256 } from '../utils/crypto';

export interface PayoutRequest {
  withdrawalId: string;
  method: 'BANK' | 'UPI';
  amountPaise: number;
  accountHolderName?: string;
  accountNumber?: string;
  ifscCode?: string;
  upiId?: string;
  idempotencyKey: string;
}

export interface PayoutResult {
  payoutId: string;
  status: string;
  reference?: string;
  utr?: string;
  failureReason?: string;
}

async function getCredentials(): Promise<{ keyId: string; keySecret: string; environment: string } | null> {
  const { rows } = await db.query(
    `SELECT pc.environment,
            (SELECT encrypted_value FROM encrypted_secrets WHERE provider_name='razorpayx' AND key_name='key_id') as key_id_enc,
            (SELECT encrypted_value FROM encrypted_secrets WHERE provider_name='razorpayx' AND key_name='key_secret') as key_secret_enc
     FROM provider_configs pc WHERE pc.provider_name = 'razorpayx' AND pc.is_active = TRUE`
  );

  if (!rows[0] || !rows[0].key_id_enc || !rows[0].key_secret_enc) return null;

  try {
    return {
      keyId: decrypt(rows[0].key_id_enc),
      keySecret: decrypt(rows[0].key_secret_enc),
      environment: rows[0].environment,
    };
  } catch {
    return null;
  }
}

export async function getRazorpayXProvider() {
  return await getCredentials();
}

function getBaseUrl(environment: string): string {
  return environment === 'production'
    ? 'https://api.razorpay.com/v1'
    : 'https://api.razorpay.com/v1'; // RazorpayX uses same endpoint, different keys
}

async function razorpayRequest(method: string, path: string, data?: any): Promise<any> {
  const creds = await getCredentials();
  if (!creds) throw new Error('RazorpayX not configured');

  const baseUrl = getBaseUrl(creds.environment);
  const auth = Buffer.from(`${creds.keyId}:${creds.keySecret}`).toString('base64');

  const response = await axios({
    method,
    url: `${baseUrl}${path}`,
    data,
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    timeout: 30000,
  });

  return response.data;
}

/**
 * Create a RazorpayX contact.
 * https://razorpay.com/docs/razorpayx/api/contacts/
 */
export async function createContact(name: string, email?: string, phone?: string): Promise<string> {
  const data = await razorpayRequest('POST', '/contacts', {
    name,
    type: 'customer',
    ...(email && { email }),
    ...(phone && { contact: phone }),
  });
  return data.id;
}

/**
 * Create a fund account for bank payout.
 */
export async function createBankFundAccount(
  contactId: string,
  holderName: string,
  accountNumber: string,
  ifscCode: string
): Promise<string> {
  const data = await razorpayRequest('POST', '/fund_accounts', {
    contact_id: contactId,
    account_type: 'bank_account',
    bank_account: {
      name: holderName,
      ifsc: ifscCode,
      account_number: accountNumber,
    },
  });
  return data.id;
}

/**
 * Create a fund account for UPI payout.
 */
export async function createUpiFundAccount(contactId: string, upiId: string): Promise<string> {
  const data = await razorpayRequest('POST', '/fund_accounts', {
    contact_id: contactId,
    account_type: 'vpa',
    vpa: { address: upiId },
  });
  return data.id;
}

/**
 * Create a RazorpayX payout.
 */
export async function createPayout(
  fundAccountId: string,
  amountPaise: number,
  currency: string = 'INR',
  mode: 'NEFT' | 'IMPS' | 'UPI',
  idempotencyKey: string,
  narration: string = 'RocketCash Payout'
): Promise<PayoutResult> {
  try {
    const data = await razorpayRequest('POST', '/payouts', {
      account_number: await getRazorpayXAccountNumber(),
      fund_account_id: fundAccountId,
      amount: amountPaise,
      currency,
      mode,
      purpose: 'payout',
      queue_if_low_balance: false,
      reference_id: idempotencyKey,
      narration,
    });

    return {
      payoutId: data.id,
      status: data.status,
      reference: data.reference_id,
      utr: data.utr,
    };
  } catch (err: any) {
    const errorData = err.response?.data;
    logger.error('RazorpayX payout creation failed', { err: errorData || err.message });
    return {
      payoutId: '',
      status: 'failed',
      failureReason: errorData?.error?.description || err.message,
    };
  }
}

/**
 * Get payout status from RazorpayX.
 */
export async function getPayoutStatus(payoutId: string): Promise<any> {
  return razorpayRequest('GET', `/payouts/${payoutId}`);
}

async function getRazorpayXAccountNumber(): Promise<string> {
  const { rows } = await db.query(
    `SELECT config->>'account_number' as account_number FROM provider_configs WHERE provider_name = 'razorpayx'`
  );
  return rows[0]?.account_number || '';
}

/**
 * Verify RazorpayX webhook signature.
 */
export async function verifyWebhookSignature(payload: string, signature: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT encrypted_value FROM encrypted_secrets WHERE provider_name='razorpayx' AND key_name='webhook_secret'`
  );
  if (!rows[0]) return false;

  try {
    const webhookSecret = decrypt(rows[0].encrypted_value);
    return verifyHmacSha256(payload, signature, webhookSecret);
  } catch {
    return false;
  }
}

/**
 * Test RazorpayX connection.
 */
export async function testConnection(): Promise<{ connected: boolean; message: string }> {
  try {
    await razorpayRequest('GET', '/contacts?count=1');
    return { connected: true, message: 'Connected successfully' };
  } catch (err: any) {
    const msg = err.response?.data?.error?.description || err.message;
    return { connected: false, message: msg };
  }
}
