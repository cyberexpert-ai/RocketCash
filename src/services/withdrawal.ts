import { db } from '../db';
import { debitWallet, creditWallet } from './wallet';
import { getRazorpayXProvider } from '../providers/razorpayx';
import { getSetting } from './settings';
import { logger } from '../utils/logger';
import { encrypt, decrypt } from '../utils/crypto';
import { v4 as uuidv4 } from 'uuid';

export async function getWithdrawalSettings(): Promise<{
  minPaise: number; maxPaise: number; dailyLimit: number;
  withdrawalEnabled: boolean; bankEnabled: boolean; upiEnabled: boolean;
  autoPayoutEnabled: boolean; manualApprovalRequired: boolean;
}> {
  return {
    minPaise: parseInt(await getSetting('min_withdrawal_paise') || '10000'),
    maxPaise: parseInt(await getSetting('max_withdrawal_paise') || '500000'),
    dailyLimit: parseInt(await getSetting('daily_withdrawal_limit') || '3'),
    withdrawalEnabled: (await getSetting('withdrawal_enabled')) === 'true',
    bankEnabled: (await getSetting('bank_enabled')) === 'true',
    upiEnabled: (await getSetting('upi_enabled')) === 'true',
    autoPayoutEnabled: (await getSetting('auto_payout_enabled')) === 'true',
    manualApprovalRequired: (await getSetting('manual_approval_required')) === 'true',
  };
}

export async function getTodayWithdrawalCount(userId: string): Promise<number> {
  const { rows } = await db.query(
    `SELECT COUNT(*) as count FROM withdrawals
     WHERE user_id = $1
       AND status NOT IN ('CANCELLED', 'REJECTED')
       AND created_at >= CURRENT_DATE AT TIME ZONE 'Asia/Kolkata'`,
    [userId]
  );
  return parseInt(rows[0].count, 10);
}

export async function createBankWithdrawal(
  userId: string,
  data: {
    holderName: string;
    accountNumber: string;
    ifscCode: string;
    bankName?: string;
    branchName?: string;
    accountType?: string;
    amountPaise: number;
  }
): Promise<any> {
  const settings = await getWithdrawalSettings();
  if (!settings.withdrawalEnabled) throw new Error('WITHDRAWAL_DISABLED');
  if (!settings.bankEnabled) throw new Error('BANK_DISABLED');
  if (data.amountPaise < settings.minPaise) throw new Error('BELOW_MINIMUM');
  if (data.amountPaise > settings.maxPaise) throw new Error('ABOVE_MAXIMUM');

  const todayCount = await getTodayWithdrawalCount(userId);
  if (todayCount >= settings.dailyLimit) throw new Error('DAILY_LIMIT_REACHED');

  return db.transaction(async (client) => {
    // Check balance
    const { rows: wallets } = await client.query(
      `SELECT balance_paise FROM wallet_accounts WHERE user_id = $1 FOR UPDATE`,
      [userId]
    );
    if (!wallets[0] || parseInt(wallets[0].balance_paise) < data.amountPaise) {
      throw new Error('INSUFFICIENT_BALANCE');
    }

    // Save bank account (encrypted)
    const last4 = data.accountNumber.slice(-4);
    const encryptedAccNum = encrypt(data.accountNumber);

    const { rows: bankRows } = await client.query(
      `INSERT INTO bank_accounts (user_id, holder_name, account_number_encrypted, account_number_last4, ifsc_code, bank_name, branch_name, account_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [userId, data.holderName, encryptedAccNum, last4,
       data.ifscCode.toUpperCase(), data.bankName || null,
       data.branchName || null, data.accountType || 'SAVINGS']
    );
    const bankAccountId = bankRows[0].id;

    const withdrawalId = uuidv4();
    const idempotencyKey = `wd_${userId}_${withdrawalId}`;

    // Hold funds
    const holdTx = await debitWallet({
      userId,
      amountPaise: data.amountPaise,
      type: 'WITHDRAWAL_HOLD',
      referenceId: withdrawalId,
      referenceType: 'withdrawal',
      idempotencyKey: `hold_${idempotencyKey}`,
      description: `Withdrawal hold - Bank ••••${last4}`,
      client,
    });

    // Create withdrawal record
    const { rows: wdRows } = await client.query(
      `INSERT INTO withdrawals (id, user_id, wallet_id, method, amount_paise, status, bank_account_id, hold_tx_id, idempotency_key)
       VALUES ($1, $2, (SELECT id FROM wallet_accounts WHERE user_id=$2), 'BANK', $3, 'PENDING', $4, $5, $6)
       RETURNING *`,
      [withdrawalId, userId, data.amountPaise, bankAccountId, holdTx.id, idempotencyKey]
    );

    const withdrawal = wdRows[0];

    // Auto payout if enabled
    if (settings.autoPayoutEnabled && !settings.manualApprovalRequired) {
      await triggerAutoPayout(withdrawalId, client);
    }

    logger.info('Bank withdrawal created', { userId, withdrawalId, amountPaise: data.amountPaise });
    return withdrawal;
  });
}

export async function createUPIWithdrawal(
  userId: string,
  data: { upiId: string; amountPaise: number }
): Promise<any> {
  const settings = await getWithdrawalSettings();
  if (!settings.withdrawalEnabled) throw new Error('WITHDRAWAL_DISABLED');
  if (!settings.upiEnabled) throw new Error('UPI_DISABLED');
  if (data.amountPaise < settings.minPaise) throw new Error('BELOW_MINIMUM');
  if (data.amountPaise > settings.maxPaise) throw new Error('ABOVE_MAXIMUM');

  const todayCount = await getTodayWithdrawalCount(userId);
  if (todayCount >= settings.dailyLimit) throw new Error('DAILY_LIMIT_REACHED');

  return db.transaction(async (client) => {
    const { rows: wallets } = await client.query(
      `SELECT balance_paise FROM wallet_accounts WHERE user_id = $1 FOR UPDATE`,
      [userId]
    );
    if (!wallets[0] || parseInt(wallets[0].balance_paise) < data.amountPaise) {
      throw new Error('INSUFFICIENT_BALANCE');
    }

    const { rows: upiRows } = await client.query(
      `INSERT INTO upi_accounts (user_id, upi_id, status)
       VALUES ($1, $2, 'UNVERIFIED') RETURNING id`,
      [userId, data.upiId]
    );
    const upiAccountId = upiRows[0].id;

    const withdrawalId = uuidv4();
    const idempotencyKey = `wd_${userId}_${withdrawalId}`;

    const holdTx = await debitWallet({
      userId,
      amountPaise: data.amountPaise,
      type: 'WITHDRAWAL_HOLD',
      referenceId: withdrawalId,
      referenceType: 'withdrawal',
      idempotencyKey: `hold_${idempotencyKey}`,
      description: `Withdrawal hold - UPI ${data.upiId}`,
      client,
    });

    const { rows: wdRows } = await client.query(
      `INSERT INTO withdrawals (id, user_id, wallet_id, method, amount_paise, status, upi_account_id, hold_tx_id, idempotency_key)
       VALUES ($1, $2, (SELECT id FROM wallet_accounts WHERE user_id=$2), 'UPI', $3, 'PENDING', $4, $5, $6)
       RETURNING *`,
      [withdrawalId, userId, data.amountPaise, upiAccountId, holdTx.id, idempotencyKey]
    );

    const withdrawal = wdRows[0];

    if (settings.autoPayoutEnabled && !settings.manualApprovalRequired) {
      await triggerAutoPayout(withdrawalId, client);
    }

    logger.info('UPI withdrawal created', { userId, withdrawalId });
    return withdrawal;
  });
}

async function triggerAutoPayout(withdrawalId: string, client: any): Promise<void> {
  try {
    const provider = await getRazorpayXProvider();
    if (!provider) { logger.warn('RazorpayX not configured — skipping auto payout'); return; }
    // Payout logic handled via scheduled job
    await client.query(
      `INSERT INTO scheduled_jobs (job_type, payload, next_run_at)
       VALUES ('PROCESS_PAYOUT', $1, NOW())`,
      [JSON.stringify({ withdrawalId })]
    );
  } catch (err: any) {
    logger.error('Auto payout scheduling failed', { withdrawalId, err: err.message });
  }
}

export async function getUserWithdrawals(userId: string, limit = 20, offset = 0): Promise<any[]> {
  const { rows } = await db.query(
    `SELECT w.id, w.method, w.amount_paise, w.status, w.failure_reason, w.created_at, w.updated_at,
            ba.account_number_last4, ba.ifsc_code, ba.bank_name,
            ua.upi_id
     FROM withdrawals w
     LEFT JOIN bank_accounts ba ON ba.id = w.bank_account_id
     LEFT JOIN upi_accounts ua ON ua.id = w.upi_account_id
     WHERE w.user_id = $1
     ORDER BY w.created_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );
  return rows;
}

export async function getWithdrawalById(userId: string, withdrawalId: string): Promise<any | null> {
  // IDOR protection: must match userId
  const { rows } = await db.query(
    `SELECT w.*, ba.account_number_last4, ba.ifsc_code, ba.bank_name, ua.upi_id
     FROM withdrawals w
     LEFT JOIN bank_accounts ba ON ba.id = w.bank_account_id
     LEFT JOIN upi_accounts ua ON ua.id = w.upi_account_id
     WHERE w.id = $1 AND w.user_id = $2`,
    [withdrawalId, userId]
  );
  return rows[0] || null;
}

/**
 * Reverse a withdrawal — refund held funds to wallet.
 */
export async function reverseWithdrawal(withdrawalId: string, reason: string): Promise<void> {
  await db.transaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM withdrawals WHERE id = $1 FOR UPDATE`,
      [withdrawalId]
    );
    if (!rows[0]) throw new Error('Withdrawal not found');
    const wd = rows[0];

    if (wd.status === 'SUCCESS') throw new Error('Cannot reverse successful withdrawal');

    const reversalTx = await creditWallet({
      userId: wd.user_id,
      amountPaise: parseInt(wd.amount_paise),
      type: 'WITHDRAWAL_REVERSAL',
      referenceId: withdrawalId,
      referenceType: 'withdrawal',
      idempotencyKey: `reversal_${withdrawalId}`,
      description: `Reversal: ${reason}`,
      client,
    });

    await client.query(
      `UPDATE withdrawals SET status='REVERSED', failure_reason=$1, reversal_tx_id=$2, updated_at=NOW()
       WHERE id=$3`,
      [reason, reversalTx.id, withdrawalId]
    );
  });
}
