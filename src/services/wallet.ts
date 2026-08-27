import { db, DbClient } from '../db';
import { logger } from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';

export type TxType =
  | 'TASK_REWARD' | 'SURVEY_REWARD' | 'OFFER_REWARD' | 'SPIN_REWARD'
  | 'REFERRAL_REWARD' | 'SIGNUP_BONUS' | 'WITHDRAWAL_HOLD' | 'WITHDRAWAL_DEBIT'
  | 'WITHDRAWAL_REVERSAL' | 'ADMIN_CREDIT' | 'ADMIN_DEBIT' | 'REFUND' | 'ADJUSTMENT';

export interface CreditOptions {
  userId: string;
  amountPaise: number;
  type: TxType;
  referenceId?: string;
  referenceType?: string;
  idempotencyKey?: string;
  description?: string;
  metadata?: Record<string, any>;
  client?: DbClient;
}

export interface DebitOptions {
  userId: string;
  amountPaise: number;
  type: TxType;
  referenceId?: string;
  referenceType?: string;
  idempotencyKey?: string;
  description?: string;
  metadata?: Record<string, any>;
  client?: DbClient;
}

/**
 * Get wallet for authenticated user only.
 * NEVER accept userId from frontend — always pass authenticatedUserId.
 */
export async function getWallet(userId: string): Promise<any | null> {
  const { rows } = await db.query(
    `SELECT wa.*, u.first_name
     FROM wallet_accounts wa
     JOIN users u ON u.id = wa.user_id
     WHERE wa.user_id = $1`,
    [userId]
  );
  return rows[0] || null;
}

/**
 * Credit a user's wallet — immutable ledger entry.
 * Handles idempotency: if same key exists, returns existing tx.
 */
export async function creditWallet(opts: CreditOptions): Promise<any> {
  const {
    userId, amountPaise, type, referenceId, referenceType,
    idempotencyKey, description, metadata, client
  } = opts;

  if (amountPaise <= 0) throw new Error('Credit amount must be positive');

  const run = async (c: DbClient) => {
    // Idempotency check
    if (idempotencyKey) {
      const { rows: existing } = await c.query(
        `SELECT * FROM wallet_transactions WHERE idempotency_key = $1`,
        [idempotencyKey]
      );
      if (existing.length > 0) {
        logger.info('Duplicate credit skipped', { idempotencyKey });
        return existing[0];
      }
    }

    // Lock wallet row
    const { rows: wallets } = await c.query(
      `SELECT * FROM wallet_accounts WHERE user_id = $1 FOR UPDATE`,
      [userId]
    );
    if (wallets.length === 0) throw new Error('Wallet not found');
    const wallet = wallets[0];

    const balanceBefore = parseInt(wallet.balance_paise, 10);
    const balanceAfter = balanceBefore + amountPaise;

    await c.query(
      `UPDATE wallet_accounts
       SET balance_paise = $1, total_earned_paise = total_earned_paise + $2, updated_at = NOW()
       WHERE user_id = $3`,
      [balanceAfter, amountPaise, userId]
    );

    const txId = uuidv4();
    const { rows: txRows } = await c.query(
      `INSERT INTO wallet_transactions
       (id, user_id, wallet_id, type, amount_paise, balance_before_paise, balance_after_paise,
        status, reference_id, reference_type, idempotency_key, description, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'COMPLETED',$8,$9,$10,$11,$12)
       RETURNING *`,
      [txId, userId, wallet.id, type, amountPaise, balanceBefore, balanceAfter,
       referenceId || null, referenceType || null,
       idempotencyKey || null, description || null,
       metadata ? JSON.stringify(metadata) : null]
    );

    logger.info('Wallet credited', { userId, amountPaise, type, txId });
    return txRows[0];
  };

  return client ? run(client) : db.transaction(run);
}

/**
 * Debit a user's wallet — prevents negative balance.
 */
export async function debitWallet(opts: DebitOptions): Promise<any> {
  const {
    userId, amountPaise, type, referenceId, referenceType,
    idempotencyKey, description, metadata, client
  } = opts;

  if (amountPaise <= 0) throw new Error('Debit amount must be positive');

  const run = async (c: DbClient) => {
    if (idempotencyKey) {
      const { rows: existing } = await c.query(
        `SELECT * FROM wallet_transactions WHERE idempotency_key = $1`,
        [idempotencyKey]
      );
      if (existing.length > 0) return existing[0];
    }

    const { rows: wallets } = await c.query(
      `SELECT * FROM wallet_accounts WHERE user_id = $1 FOR UPDATE`,
      [userId]
    );
    if (wallets.length === 0) throw new Error('Wallet not found');
    const wallet = wallets[0];

    if (wallet.is_frozen) throw new Error('Wallet is frozen');
    const balanceBefore = parseInt(wallet.balance_paise, 10);
    if (balanceBefore < amountPaise) throw new Error('Insufficient balance');

    const balanceAfter = balanceBefore - amountPaise;

    await c.query(
      `UPDATE wallet_accounts
       SET balance_paise = $1, total_withdrawn_paise = total_withdrawn_paise + $2, updated_at = NOW()
       WHERE user_id = $3`,
      [balanceAfter, amountPaise, userId]
    );

    const txId = uuidv4();
    const { rows: txRows } = await c.query(
      `INSERT INTO wallet_transactions
       (id, user_id, wallet_id, type, amount_paise, balance_before_paise, balance_after_paise,
        status, reference_id, reference_type, idempotency_key, description, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'COMPLETED',$8,$9,$10,$11,$12)
       RETURNING *`,
      [txId, userId, wallet.id, type, amountPaise, balanceBefore, balanceAfter,
       referenceId || null, referenceType || null,
       idempotencyKey || null, description || null,
       metadata ? JSON.stringify(metadata) : null]
    );

    logger.info('Wallet debited', { userId, amountPaise, type, txId });
    return txRows[0];
  };

  return client ? run(client) : db.transaction(run);
}

/**
 * Get transaction history — only for the authenticated user.
 */
export async function getTransactionHistory(userId: string, limit = 20, offset = 0): Promise<any[]> {
  const { rows } = await db.query(
    `SELECT id, type, amount_paise, balance_after_paise, description, status, created_at
     FROM wallet_transactions
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );
  return rows;
}

/**
 * Admin: Credit wallet with audit.
 */
export async function adminCreditWallet(
  adminId: string,
  userId: string,
  amountPaise: number,
  reason: string
): Promise<any> {
  const tx = await creditWallet({
    userId,
    amountPaise,
    type: 'ADMIN_CREDIT',
    description: `Admin credit: ${reason}`,
    idempotencyKey: `admin_credit_${adminId}_${userId}_${Date.now()}`,
  });

  await db.query(
    `INSERT INTO audit_logs (admin_id, action, target_type, target_id, new_value, reason)
     VALUES ($1, 'ADMIN_CREDIT_WALLET', 'user', $2, $3, $4)`,
    [adminId, userId, JSON.stringify({ amountPaise }), reason]
  );

  return tx;
}
