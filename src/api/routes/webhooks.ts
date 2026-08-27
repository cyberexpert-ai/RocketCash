import { Router, Request, Response } from 'express';
import { db } from '../../db';
import { creditWallet } from '../../services/wallet';
import { reverseWithdrawal } from '../../services/withdrawal';
import { notifyTaskReward, notifyWithdrawalSuccess, notifyWithdrawalFailed } from '../../services/notification';
import { validateBitLabsCallback, parseBitLabsCallback, convertToPaise } from '../../providers/bitlabs';
import { verifyWebhookSignature } from '../../providers/razorpayx';
import { webhookLimiter } from '../middleware/rateLimit';
import { paiseToRupees } from '../../utils/money';
import { logger } from '../../utils/logger';

const router = Router();

/**
 * POST /api/webhooks/bitlabs
 * Receives task completion callbacks from BitLabs.
 * Validates signature, checks idempotency, credits correct user's wallet.
 */
router.post('/bitlabs', webhookLimiter, async (req: Request, res: Response): Promise<void> => {
  const rawBody = JSON.stringify(req.body);
  const signature = req.headers['x-bitlabs-signature'] as string || '';

  // Always respond 200 quickly to provider
  res.status(200).json({ status: 'received' });

  try {
    // Validate signature
    const isValid = await validateBitLabsCallback(rawBody, signature);
    if (!isValid) {
      logger.warn('BitLabs callback invalid signature', { signature });
      await storeCallback('bitlabs', 'unknown', req.body, signature, false, false);
      return;
    }

    const parsed = parseBitLabsCallback(req.body);
    if (!parsed) {
      logger.warn('BitLabs callback parse failed', { body: req.body });
      return;
    }

    const { userId: telegramIdStr, transactionId, rewardCents, currency, status } = parsed;
    if (!telegramIdStr || !transactionId) return;

    const telegramId = parseInt(telegramIdStr);
    if (isNaN(telegramId)) return;

    // Find user by telegram ID
    const { rows: users } = await db.query(
      `SELECT id FROM users WHERE telegram_id = $1 AND status = 'ACTIVE'`,
      [telegramId]
    );
    if (!users[0]) {
      logger.warn('BitLabs callback: user not found', { telegramId });
      await storeCallback('bitlabs', transactionId, req.body, signature, true, false);
      return;
    }
    const userId = users[0].id;

    // Idempotency — check if already processed
    const { rows: existing } = await db.query(
      `SELECT id FROM provider_callbacks WHERE provider_name='bitlabs' AND provider_transaction_id=$1`,
      [transactionId]
    );
    if (existing.length > 0) {
      logger.info('BitLabs duplicate callback ignored', { transactionId });
      return;
    }

    // Store callback record
    const { rows: cbRows } = await db.query(
      `INSERT INTO provider_callbacks (provider_name, provider_transaction_id, user_id, payload, signature, is_valid, is_processed)
       VALUES ('bitlabs', $1, $2, $3, $4, TRUE, FALSE)
       ON CONFLICT (provider_name, provider_transaction_id) DO NOTHING
       RETURNING id`,
      [transactionId, userId, JSON.stringify(req.body), signature]
    );
    if (!cbRows[0]) return; // Already processed by concurrent request

    if (status !== 'COMPLETED' && status !== 'complete' && status !== '1') {
      logger.info('BitLabs callback non-complete status', { transactionId, status });
      return;
    }

    // Convert reward to paise
    const rewardPaise = convertToPaise(rewardCents, currency);
    if (rewardPaise <= 0) return;

    // Credit wallet — idempotent
    const tx = await creditWallet({
      userId,
      amountPaise: rewardPaise,
      type: 'SURVEY_REWARD',
      idempotencyKey: `bitlabs_${transactionId}`,
      description: `BitLabs task reward`,
      referenceId: cbRows[0].id,
      referenceType: 'provider_callback',
      metadata: { transactionId, currency, rewardCents },
    });

    // Mark callback as processed
    await db.query(
      `UPDATE provider_callbacks SET is_processed=TRUE, processed_at=NOW(), wallet_tx_id=$1 WHERE id=$2`,
      [tx.id, cbRows[0].id]
    );

    // Notify user
    await notifyTaskReward(userId, rewardPaise);
    logger.info('BitLabs reward credited', { userId, rewardPaise, transactionId });

  } catch (err: any) {
    logger.error('BitLabs webhook error', { err: err.message });
  }
});

/**
 * POST /api/webhooks/razorpayx
 * Receives payout status updates from RazorpayX.
 */
router.post('/razorpayx', webhookLimiter, async (req: Request, res: Response): Promise<void> => {
  const rawBody = JSON.stringify(req.body);
  const signature = req.headers['x-razorpay-signature'] as string || '';

  res.status(200).json({ status: 'received' });

  try {
    const isValid = await verifyWebhookSignature(rawBody, signature);
    if (!isValid) {
      logger.warn('RazorpayX webhook invalid signature');
      return;
    }

    const event = req.body;
    const eventId = event.id || `rzp_${Date.now()}`;
    const eventType = event.event;

    // Idempotency
    const { rows: existing } = await db.query(
      `SELECT id FROM payout_webhooks WHERE provider_name='razorpayx' AND event_id=$1`,
      [eventId]
    );
    if (existing.length > 0) {
      logger.info('RazorpayX duplicate webhook ignored', { eventId });
      return;
    }

    const { rows: whRows } = await db.query(
      `INSERT INTO payout_webhooks (provider_name, event_id, event_type, payload, signature, is_valid, is_processed)
       VALUES ('razorpayx', $1, $2, $3, $4, TRUE, FALSE)
       ON CONFLICT (provider_name, event_id) DO NOTHING
       RETURNING id`,
      [eventId, eventType, JSON.stringify(event), signature]
    );
    if (!whRows[0]) return;

    const payoutData = event.payload?.payout?.entity;
    if (!payoutData) return;

    const providerPayoutId = payoutData.id;
    const providerStatus = payoutData.status;
    const utr = payoutData.utr;
    const failureReason = payoutData.failure_reason;

    // Find our payout transaction
    const { rows: ptRows } = await db.query(
      `SELECT pt.*, w.user_id, w.amount_paise, w.method,
              ba.account_number_last4, ua.upi_id
       FROM payout_transactions pt
       JOIN withdrawals w ON w.id=pt.withdrawal_id
       LEFT JOIN bank_accounts ba ON ba.id=w.bank_account_id
       LEFT JOIN upi_accounts ua ON ua.id=w.upi_account_id
       WHERE pt.provider_payout_id=$1`,
      [providerPayoutId]
    );

    if (!ptRows[0]) {
      logger.warn('RazorpayX webhook: payout not found', { providerPayoutId });
      return;
    }

    const pt = ptRows[0];

    // Map provider status
    const statusMap: Record<string, string> = {
      processed: 'SUCCESS',
      reversed: 'REVERSED',
      failed: 'FAILED',
      cancelled: 'CANCELLED',
      queued: 'PROCESSING',
      pending: 'PROCESSING',
    };
    const internalStatus = statusMap[providerStatus] || 'PROCESSING';

    await db.query(
      `UPDATE payout_transactions SET status=$1, utr=$2, failure_reason=$3, provider_response=$4, updated_at=NOW() WHERE id=$5`,
      [internalStatus, utr || null, failureReason || null, JSON.stringify(payoutData), pt.id]
    );

    await db.query(
      `UPDATE withdrawals SET status=$1, updated_at=NOW() WHERE id=$2`,
      [internalStatus, pt.withdrawal_id]
    );

    await db.query(
      `UPDATE payout_webhooks SET is_processed=TRUE, processed_at=NOW(), payout_tx_id=$1 WHERE id=$2`,
      [pt.id, whRows[0].id]
    );

    // Notify user
    if (internalStatus === 'SUCCESS') {
      const { rows: wallets } = await db.query(
        `SELECT balance_paise FROM wallet_accounts WHERE user_id=$1`, [pt.user_id]
      );
      const dest = pt.method === 'BANK' ? pt.account_number_last4 : pt.upi_id;
      await notifyWithdrawalSuccess(pt.user_id, parseInt(pt.amount_paise), pt.method, dest, parseInt(wallets[0]?.balance_paise || 0));

    } else if (internalStatus === 'REVERSED' || internalStatus === 'FAILED') {
      // Refund — check not already reversed
      const { rows: wdRows } = await db.query(`SELECT reversal_tx_id FROM withdrawals WHERE id=$1`, [pt.withdrawal_id]);
      if (!wdRows[0]?.reversal_tx_id) {
        await reverseWithdrawal(pt.withdrawal_id, failureReason || 'Provider reversed');
        await notifyWithdrawalFailed(pt.user_id, parseInt(pt.amount_paise), failureReason);
      }
    }

    logger.info('RazorpayX webhook processed', { eventType, providerPayoutId, internalStatus });

  } catch (err: any) {
    logger.error('RazorpayX webhook error', { err: err.message });
  }
});

async function storeCallback(
  provider: string, txId: string, payload: any,
  signature: string, isValid: boolean, isProcessed: boolean
): Promise<void> {
  await db.query(
    `INSERT INTO provider_callbacks (provider_name, provider_transaction_id, payload, signature, is_valid, is_processed)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT DO NOTHING`,
    [provider, txId, JSON.stringify(payload), signature, isValid, isProcessed]
  ).catch(() => {});
}

export default router;
