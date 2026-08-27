import { db } from '../db';
import { logger } from '../utils/logger';
import { reverseWithdrawal } from './withdrawal';
import { createPayout, createContact, createBankFundAccount, createUpiFundAccount } from '../providers/razorpayx';
import { decrypt } from '../utils/crypto';
import { notifyWithdrawalProcessing, notifyWithdrawalSuccess, notifyWithdrawalFailed } from './notification';

const JOB_LOCK_TTL_MINUTES = 5;
const POLL_INTERVAL_MS = 15000; // 15s

async function acquireJob(): Promise<any | null> {
  const { rows } = await db.query(
    `UPDATE scheduled_jobs
     SET status = 'RUNNING', locked_at = NOW(), locked_by = $1, attempts = attempts + 1, updated_at = NOW()
     WHERE id = (
       SELECT id FROM scheduled_jobs
       WHERE status = 'PENDING'
         AND next_run_at <= NOW()
         AND (locked_at IS NULL OR locked_at < NOW() - INTERVAL '${JOB_LOCK_TTL_MINUTES} minutes')
       ORDER BY next_run_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`,
    [`worker_${process.pid}`]
  );
  return rows[0] || null;
}

async function completeJob(jobId: string): Promise<void> {
  await db.query(
    `UPDATE scheduled_jobs SET status='COMPLETED', completed_at=NOW(), updated_at=NOW() WHERE id=$1`,
    [jobId]
  );
}

async function failJob(jobId: string, error: string, maxAttempts: number, attempts: number): Promise<void> {
  if (attempts >= maxAttempts) {
    await db.query(
      `UPDATE scheduled_jobs SET status='FAILED', error=$1, updated_at=NOW() WHERE id=$2`,
      [error, jobId]
    );
  } else {
    await db.query(
      `UPDATE scheduled_jobs SET status='PENDING', error=$1, next_run_at=NOW()+INTERVAL '60 seconds', locked_at=NULL, updated_at=NOW() WHERE id=$2`,
      [error, jobId]
    );
  }
}

async function processPayoutJob(payload: { withdrawalId: string }): Promise<void> {
  const { withdrawalId } = payload;

  const { rows } = await db.query(
    `SELECT w.*, ba.account_number_encrypted, ba.account_number_last4, ba.ifsc_code, ba.holder_name, ba.bank_name,
            ua.upi_id, u.first_name, u.id as user_id, u.telegram_id
     FROM withdrawals w
     LEFT JOIN bank_accounts ba ON ba.id = w.bank_account_id
     LEFT JOIN upi_accounts ua ON ua.id = w.upi_account_id
     JOIN users u ON u.id = w.user_id
     WHERE w.id = $1 AND w.status = 'PENDING'`,
    [withdrawalId]
  );

  if (!rows[0]) { logger.warn('Payout job: withdrawal not found or not pending', { withdrawalId }); return; }
  const wd = rows[0];

  await db.query(`UPDATE withdrawals SET status='PROCESSING', updated_at=NOW() WHERE id=$1`, [withdrawalId]);
  await notifyWithdrawalProcessing(wd.user_id, parseInt(wd.amount_paise));

  try {
    const contactId = await createContact(wd.first_name);
    let fundAccountId: string;
    let mode: 'NEFT' | 'IMPS' | 'UPI';

    if (wd.method === 'BANK') {
      const accountNumber = decrypt(wd.account_number_encrypted);
      fundAccountId = await createBankFundAccount(contactId, wd.holder_name, accountNumber, wd.ifsc_code);
      mode = 'IMPS';
    } else {
      fundAccountId = await createUpiFundAccount(contactId, wd.upi_id);
      mode = 'UPI';
    }

    const idempotencyKey = `payout_${withdrawalId}`;
    const result = await createPayout(fundAccountId, parseInt(wd.amount_paise), 'INR', mode, idempotencyKey);

    const { rows: ptRows } = await db.query(
      `INSERT INTO payout_transactions (withdrawal_id, provider_name, provider_payout_id, status, idempotency_key, amount_paise)
       VALUES ($1, 'razorpayx', $2, $3, $4, $5) RETURNING id`,
      [withdrawalId, result.payoutId, result.status, idempotencyKey, wd.amount_paise]
    );

    await db.query(
      `UPDATE withdrawals SET payout_tx_id=$1, updated_at=NOW() WHERE id=$2`,
      [ptRows[0].id, withdrawalId]
    );

    if (result.status === 'processed') {
      await db.query(`UPDATE withdrawals SET status='SUCCESS', updated_at=NOW() WHERE id=$1`, [withdrawalId]);
      const dest = wd.method === 'BANK' ? wd.account_number_last4 : wd.upi_id;
      const wallet = await db.query(`SELECT balance_paise FROM wallet_accounts WHERE user_id=$1`, [wd.user_id]);
      await notifyWithdrawalSuccess(wd.user_id, parseInt(wd.amount_paise), wd.method, dest, parseInt(wallet.rows[0].balance_paise));
    }

  } catch (err: any) {
    logger.error('Payout job failed', { withdrawalId, err: err.message });
    await reverseWithdrawal(withdrawalId, err.message);
    await notifyWithdrawalFailed(wd.user_id, parseInt(wd.amount_paise), err.message);
  }
}

async function processNotificationJob(payload: any): Promise<void> {
  logger.info('Processing notification job', { payload });
}

async function runNextJob(): Promise<boolean> {
  const job = await acquireJob();
  if (!job) return false;

  logger.info('Processing job', { jobId: job.id, type: job.job_type });

  try {
    const payload = job.payload;
    switch (job.job_type) {
      case 'PROCESS_PAYOUT': await processPayoutJob(payload); break;
      case 'SEND_NOTIFICATION': await processNotificationJob(payload); break;
      default: logger.warn('Unknown job type', { type: job.job_type });
    }
    await completeJob(job.id);
    return true;
  } catch (err: any) {
    logger.error('Job failed', { jobId: job.id, err: err.message });
    await failJob(job.id, err.message, job.max_attempts, job.attempts);
    return false;
  }
}

export function startJobRunner(): NodeJS.Timeout {
  logger.info('Job runner started');
  const interval = setInterval(async () => {
    try {
      let ran = true;
      while (ran) {
        ran = await runNextJob();
      }
    } catch (err: any) {
      logger.error('Job runner error', { err: err.message });
    }
  }, POLL_INTERVAL_MS);
  return interval;
}
