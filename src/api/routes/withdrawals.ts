import { Router, Response } from 'express';
import { z } from 'zod';
import { requireAuth, AuthRequest } from '../middleware/auth';
import {
  createBankWithdrawal,
  createUPIWithdrawal,
  getUserWithdrawals,
  getWithdrawalById,
  getWithdrawalSettings,
  getTodayWithdrawalCount,
} from '../../services/withdrawal';
import { validateIFSC, validateUPIId } from '../../providers/ifsc';
import { paiseToRupees } from '../../utils/money';
import { withdrawLimiter } from '../middleware/rateLimit';
import { notifyWithdrawalProcessing } from '../../services/notification';
import { triggerReferralReward } from '../../services/referral';

const router = Router();

const BankWithdrawalSchema = z.object({
  holderName: z.string().min(2).max(100),
  accountNumber: z.string().min(9).max(18).regex(/^\d+$/),
  confirmAccountNumber: z.string(),
  ifscCode: z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/i),
  bankName: z.string().max(100).optional(),
  branchName: z.string().max(100).optional(),
  accountType: z.enum(['SAVINGS', 'CURRENT']).optional(),
  amountPaise: z.number().int().positive(),
}).refine(d => d.accountNumber === d.confirmAccountNumber, {
  message: 'Account numbers do not match',
  path: ['confirmAccountNumber'],
});

const UPIWithdrawalSchema = z.object({
  upiId: z.string().min(5).max(100),
  amountPaise: z.number().int().positive(),
});

/**
 * GET /api/withdrawals
 * List authenticated user's withdrawals only.
 */
router.get('/', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.userId!;
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);
  const offset = parseInt(req.query.offset as string) || 0;

  const settings = await getWithdrawalSettings();
  const todayCount = await getTodayWithdrawalCount(userId);
  const withdrawals = await getUserWithdrawals(userId, limit, offset);

  res.json({
    settings: {
      minPaise: settings.minPaise,
      maxPaise: settings.maxPaise,
      dailyLimit: settings.dailyLimit,
      todayCount,
      spaceLeft: Math.max(0, settings.dailyLimit - todayCount),
      withdrawalEnabled: settings.withdrawalEnabled,
      bankEnabled: settings.bankEnabled,
      upiEnabled: settings.upiEnabled,
    },
    withdrawals: withdrawals.map(w => ({
      id: w.id,
      method: w.method,
      amountPaise: parseInt(w.amount_paise),
      amountFormatted: paiseToRupees(parseInt(w.amount_paise)),
      status: w.status,
      failureReason: w.failure_reason,
      accountLast4: w.account_number_last4,
      ifscCode: w.ifsc_code,
      bankName: w.bank_name,
      upiId: w.upi_id,
      createdAt: w.created_at,
      updatedAt: w.updated_at,
    })),
    hasMore: withdrawals.length === limit,
  });
});

/**
 * GET /api/withdrawals/:id
 * Get a specific withdrawal — IDOR protected: only own withdrawals.
 */
router.get('/:id', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.userId!;
  const withdrawalId = req.params.id;

  const wd = await getWithdrawalById(userId, withdrawalId);
  if (!wd) {
    // Return 404 not 403 to avoid leaking existence
    res.status(404).json({ error: 'Not found' });
    return;
  }

  res.json({
    id: wd.id,
    method: wd.method,
    amountPaise: parseInt(wd.amount_paise),
    amountFormatted: paiseToRupees(parseInt(wd.amount_paise)),
    status: wd.status,
    failureReason: wd.failure_reason,
    accountLast4: wd.account_number_last4,
    ifscCode: wd.ifsc_code,
    bankName: wd.bank_name,
    upiId: wd.upi_id,
    createdAt: wd.created_at,
    updatedAt: wd.updated_at,
  });
});

/**
 * POST /api/withdrawals
 * Create a new withdrawal — uses authenticated user only.
 */
router.post('/', requireAuth, withdrawLimiter, async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.userId!;
  const { method } = req.body;

  if (!method) {
    res.status(400).json({ error: 'method is required (BANK or UPI)' });
    return;
  }

  try {
    let withdrawal: any;

    if (method === 'BANK') {
      const parsed = BankWithdrawalSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
        return;
      }
      const data = parsed.data;

      // Validate IFSC
      const ifscResult = await validateIFSC(data.ifscCode);
      if (!ifscResult.valid) {
        res.status(400).json({ error: 'Invalid IFSC code' });
        return;
      }

      withdrawal = await createBankWithdrawal(userId, {
        holderName: data.holderName,
        accountNumber: data.accountNumber,
        ifscCode: data.ifscCode,
        bankName: ifscResult.bank || data.bankName,
        branchName: ifscResult.branch || data.branchName,
        accountType: data.accountType,
        amountPaise: data.amountPaise,
      });

    } else if (method === 'UPI') {
      const parsed = UPIWithdrawalSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
        return;
      }
      const data = parsed.data;

      if (!validateUPIId(data.upiId)) {
        res.status(400).json({ error: 'Invalid UPI ID format' });
        return;
      }

      withdrawal = await createUPIWithdrawal(userId, {
        upiId: data.upiId,
        amountPaise: data.amountPaise,
      });

    } else {
      res.status(400).json({ error: 'Invalid method. Use BANK or UPI' });
      return;
    }

    // Trigger referral reward for first withdrawal
    triggerReferralReward(userId, 'FIRST_WITHDRAWAL').catch(() => {});
    notifyWithdrawalProcessing(userId, withdrawal.amount_paise).catch(() => {});

    res.status(201).json({
      success: true,
      withdrawalId: withdrawal.id,
      status: withdrawal.status,
      amountPaise: parseInt(withdrawal.amount_paise),
      amountFormatted: paiseToRupees(parseInt(withdrawal.amount_paise)),
      message: '⏳ Withdrawal Processing — Your payout is being processed.',
    });

  } catch (err: any) {
    const errorMap: Record<string, [number, string]> = {
      WITHDRAWAL_DISABLED: [403, 'Withdrawals are currently disabled.'],
      BANK_DISABLED: [403, 'Bank withdrawals are currently disabled.'],
      UPI_DISABLED: [403, 'UPI withdrawals are currently disabled.'],
      BELOW_MINIMUM: [400, `Minimum withdrawal amount not met.`],
      ABOVE_MAXIMUM: [400, `Maximum withdrawal amount exceeded.`],
      DAILY_LIMIT_REACHED: [429, 'Daily withdrawal limit reached.'],
      INSUFFICIENT_BALANCE: [400, 'Insufficient balance.'],
    };

    const mapped = errorMap[err.message];
    if (mapped) {
      res.status(mapped[0]).json({ error: err.message, message: mapped[1] });
      return;
    }

    res.status(500).json({ error: 'Withdrawal failed', message: err.message });
  }
});

export default router;
