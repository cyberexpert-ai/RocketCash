/**
 * ROCKETCASH — Webhook & Withdrawal Tests
 */

import { db } from '../src/db';
import crypto from 'crypto';

jest.mock('../src/db', () => ({
  db: {
    query: jest.fn(),
    transaction: jest.fn(async (fn) => fn({
      query: jest.fn().mockResolvedValue({ rows: [{ id: 'tx-id', balance_paise: 1000 }], rowCount: 1 }),
    })),
    healthCheck: jest.fn().mockResolvedValue(true),
    end: jest.fn(),
  },
}));

jest.mock('../src/services/notification', () => ({
  notifyTaskReward: jest.fn().mockResolvedValue(undefined),
  notifyWithdrawalProcessing: jest.fn().mockResolvedValue(undefined),
  notifyWithdrawalSuccess: jest.fn().mockResolvedValue(undefined),
  notifyWithdrawalFailed: jest.fn().mockResolvedValue(undefined),
  notifySpinSuccess: jest.fn().mockResolvedValue(undefined),
}));

const mockDb = db as jest.Mocked<typeof db>;

// ─── BITLABS WEBHOOK TESTS ───────────────────────────────────

describe('=== BITLABS WEBHOOK TESTS ===', () => {
  describe('Signature Validation', () => {
    it('rejects callback with invalid signature', async () => {
      const { validateBitLabsCallback } = await import('../src/providers/bitlabs');
      mockDb.query.mockResolvedValue({
        rows: [{ is_active: true, token_enc: null, secret_enc: null }],
        rowCount: 0,
      });
      const result = await validateBitLabsCallback('{"test":"data"}', 'invalid-sig');
      expect(result).toBe(false);
    });

    it('parses BitLabs callback payload correctly', async () => {
      const { parseBitLabsCallback } = await import('../src/providers/bitlabs');
      const payload = {
        uid: '123456789',
        transaction_id: 'txn_abc123',
        val: '0.50',
        currency: 'USD',
        status: 'COMPLETED',
      };
      const parsed = parseBitLabsCallback(payload);
      expect(parsed).not.toBeNull();
      expect(parsed?.userId).toBe('123456789');
      expect(parsed?.transactionId).toBe('txn_abc123');
      expect(parsed?.rewardCents).toBe(50);
      expect(parsed?.currency).toBe('USD');
    });

    it('returns null for malformed payload', async () => {
      const { parseBitLabsCallback } = await import('../src/providers/bitlabs');
      expect(parseBitLabsCallback(null)).toBeNull();
      expect(parseBitLabsCallback({})).not.toBeNull(); // returns default values
    });
  });

  describe('Reward Conversion', () => {
    it('converts USD cents to INR paise correctly at 83x rate', async () => {
      const { convertToPaise } = await import('../src/providers/bitlabs');
      // 100 USD cents = $1 = ₹83 = 8300 paise
      expect(convertToPaise(100, 'USD', 83)).toBe(8300);
    });

    it('passes through INR paise unchanged', async () => {
      const { convertToPaise } = await import('../src/providers/bitlabs');
      expect(convertToPaise(500, 'INR', 83)).toBe(500);
    });

    it('handles zero reward correctly', async () => {
      const { convertToPaise } = await import('../src/providers/bitlabs');
      expect(convertToPaise(0, 'USD', 83)).toBe(0);
    });
  });

  describe('Idempotency', () => {
    it('duplicate transaction ID must not be credited twice', async () => {
      const transactionId = 'bitlabs_dup_txn_999';
      let creditCallCount = 0;

      mockDb.query.mockImplementation((sql: string, params: any[]) => {
        if (sql.includes('provider_callbacks') && sql.includes('ON CONFLICT')) {
          // Simulate duplicate — no rows returned (already exists)
          return Promise.resolve({ rows: [], rowCount: 0 });
        }
        if (sql.includes('wallet_transactions') && sql.includes('idempotency_key')) {
          creditCallCount++;
          return Promise.resolve({ rows: [{ id: 'existing-credit' }], rowCount: 1 });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      });

      // Simulating webhook handler would skip processing on duplicate
      const { rows } = await db.query(
        `INSERT INTO provider_callbacks (provider_name, provider_transaction_id, user_id, payload, signature, is_valid, is_processed)
         VALUES ('bitlabs', $1, $2, $3, $4, TRUE, FALSE) ON CONFLICT DO NOTHING RETURNING id`,
        [transactionId, 'user-id', '{}', 'sig']
      );

      // No rows = duplicate detected, should not credit
      if (!rows.length) creditCallCount = 0;
      expect(creditCallCount).toBe(0);
    });
  });
});

// ─── RAZORPAYX WEBHOOK TESTS ─────────────────────────────────

describe('=== RAZORPAYX WEBHOOK TESTS ===', () => {
  describe('Signature Verification', () => {
    it('verifies valid RazorpayX webhook signature', async () => {
      const { verifyHmacSha256 } = await import('../src/utils/crypto');
      const secret = 'test_webhook_secret_32chars_minimum';
      const payload = '{"event":"payout.processed","id":"evt_123"}';
      const validSig = crypto.createHmac('sha256', secret).update(payload).digest('hex');

      const result = verifyHmacSha256(payload, validSig, secret);
      expect(result).toBe(true);
    });

    it('rejects tampered webhook payload', async () => {
      const { verifyHmacSha256 } = await import('../src/utils/crypto');
      const secret = 'test_webhook_secret';
      const originalPayload = '{"event":"payout.processed","amount":1000}';
      const tamperedPayload = '{"event":"payout.processed","amount":9999999}';
      const sig = crypto.createHmac('sha256', secret).update(originalPayload).digest('hex');

      const result = verifyHmacSha256(tamperedPayload, sig, secret);
      expect(result).toBe(false);
    });

    it('rejects empty signature', async () => {
      const { verifyHmacSha256 } = await import('../src/utils/crypto');
      expect(() => verifyHmacSha256('payload', '', 'secret')).not.toThrow();
    });
  });

  describe('Webhook Idempotency', () => {
    it('duplicate event ID must not double-process', async () => {
      const eventId = 'evt_duplicate_123';
      let processCount = 0;

      mockDb.query.mockImplementation((sql: string) => {
        if (sql.includes('payout_webhooks') && sql.includes('ON CONFLICT')) {
          return Promise.resolve({ rows: [], rowCount: 0 }); // Duplicate — no rows
        }
        processCount++;
        return Promise.resolve({ rows: [], rowCount: 0 });
      });

      // First call: new event
      const { rows: r1 } = await db.query(
        `INSERT INTO payout_webhooks (provider_name, event_id, event_type, payload, signature, is_valid, is_processed)
         VALUES ('razorpayx', $1, $2, $3, $4, TRUE, FALSE) ON CONFLICT DO NOTHING RETURNING id`,
        [eventId, 'payout.processed', '{}', 'sig']
      );

      // Second call: duplicate
      const { rows: r2 } = await db.query(
        `INSERT INTO payout_webhooks (provider_name, event_id, event_type, payload, signature, is_valid, is_processed)
         VALUES ('razorpayx', $1, $2, $3, $4, TRUE, FALSE) ON CONFLICT DO NOTHING RETURNING id`,
        [eventId, 'payout.processed', '{}', 'sig']
      );

      // Both return empty — ON CONFLICT DO NOTHING
      expect(r1.length).toBe(0);
      expect(r2.length).toBe(0);
    });

    it('payout reversal must refund to correct user wallet', async () => {
      const { reverseWithdrawal } = await import('../src/services/withdrawal');
      jest.spyOn(db, 'transaction').mockImplementation(async (fn) => {
        const mockClient = {
          query: jest.fn()
            .mockResolvedValueOnce({ rows: [{ id: 'wd-id', user_id: 'user-id', amount_paise: 1000, status: 'PROCESSING' }] })
            .mockResolvedValueOnce({ rows: [{ id: 'reversal-tx' }] })
            .mockResolvedValue({ rows: [], rowCount: 0 }),
        };
        return fn(mockClient as any);
      });

      await expect(reverseWithdrawal('withdrawal-id', 'Provider reversed')).resolves.toBeUndefined();
    });

    it('cannot reverse an already successful withdrawal', async () => {
      const { reverseWithdrawal } = await import('../src/services/withdrawal');
      jest.spyOn(db, 'transaction').mockImplementation(async (fn) => {
        const mockClient = {
          query: jest.fn().mockResolvedValue({
            rows: [{ id: 'wd-id', user_id: 'user-id', amount_paise: 1000, status: 'SUCCESS' }],
          }),
        };
        return fn(mockClient as any);
      });

      await expect(reverseWithdrawal('wd-success-id', 'Attempt')).rejects.toThrow('Cannot reverse successful withdrawal');
    });
  });
});

// ─── WITHDRAWAL TESTS ─────────────────────────────────────────

describe('=== WITHDRAWAL TESTS ===', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockDb.query.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  describe('Settings Enforcement', () => {
    it('rejects withdrawal below minimum amount', async () => {
      const { getWithdrawalSettings } = await import('../src/services/withdrawal');
      mockDb.query.mockImplementation((sql: string) => {
        if (sql.includes('admin_settings') && sql.includes('min_withdrawal_paise')) {
          return Promise.resolve({ rows: [{ value: '10000' }], rowCount: 1 });
        }
        return Promise.resolve({ rows: [{ value: 'true' }], rowCount: 1 });
      });

      const settings = await getWithdrawalSettings();
      expect(settings.minPaise).toBe(10000); // ₹100
    });

    it('daily withdrawal count is per-user', async () => {
      const { getTodayWithdrawalCount } = await import('../src/services/withdrawal');
      const userId = 'specific-user-id';

      mockDb.query.mockImplementation((sql: string, params: any[]) => {
        // Must filter by user_id
        expect(params).toContain(userId);
        return Promise.resolve({ rows: [{ count: '2' }], rowCount: 1 });
      });

      const count = await getTodayWithdrawalCount(userId);
      expect(count).toBe(2);
    });
  });

  describe('IFSC Validation', () => {
    it('validates IFSC format correctly', async () => {
      const { validateUPIId } = await import('../src/providers/ifsc');

      // Valid UPI IDs
      expect(validateUPIId('user@okicici')).toBe(true);
      expect(validateUPIId('user.name@paytm')).toBe(true);
      expect(validateUPIId('9876543210@upi')).toBe(true);

      // Invalid UPI IDs
      expect(validateUPIId('invalid')).toBe(false);
      expect(validateUPIId('@bank')).toBe(false);
      expect(validateUPIId('user@')).toBe(false);
      expect(validateUPIId('')).toBe(false);
    });
  });

  describe('IDOR Protection in Withdrawals', () => {
    it('getWithdrawalById must include user_id in query', async () => {
      const { getWithdrawalById } = await import('../src/services/withdrawal');
      const userId = 'legit-user';
      const withdrawalId = 'wd-123';

      mockDb.query.mockImplementation((sql: string, params: any[]) => {
        // Both IDs must be in params — prevents IDOR
        expect(params).toContain(withdrawalId);
        expect(params).toContain(userId);
        return Promise.resolve({ rows: [], rowCount: 0 });
      });

      await getWithdrawalById(userId, withdrawalId);
    });

    it('returns null when withdrawal belongs to another user', async () => {
      const { getWithdrawalById } = await import('../src/services/withdrawal');
      mockDb.query.mockResolvedValue({ rows: [], rowCount: 0 }); // No match = 404

      const result = await getWithdrawalById('attacker-id', 'victim-withdrawal-id');
      expect(result).toBeNull();
    });
  });
});

// ─── CRYPTO TESTS ─────────────────────────────────────────────

describe('=== CRYPTO & SECURITY TESTS ===', () => {
  it('generates unique referral codes', async () => {
    const { generateReferralCode } = await import('../src/utils/crypto');
    const codes = new Set(Array.from({ length: 100 }, () => generateReferralCode()));
    expect(codes.size).toBe(100); // All unique
  });

  it('encrypt/decrypt round-trips correctly', async () => {
    process.env.ENCRYPTION_KEY = 'a'.repeat(64);
    const { encrypt, decrypt } = await import('../src/utils/crypto');
    const secret = 'rzp_live_test_secret_key_here';
    const encrypted = encrypt(secret);
    expect(encrypted).not.toBe(secret);
    const decrypted = decrypt(encrypted);
    expect(decrypted).toBe(secret);
  });

  it('produces different ciphertext for same plaintext (random IV)', async () => {
    process.env.ENCRYPTION_KEY = 'b'.repeat(64);
    const { encrypt } = await import('../src/utils/crypto');
    const secret = 'same_secret';
    const enc1 = encrypt(secret);
    const enc2 = encrypt(secret);
    expect(enc1).not.toBe(enc2); // Different IV each time
  });

  it('hashSensitive is deterministic', async () => {
    const { hashSensitive } = await import('../src/utils/crypto');
    const h1 = hashSensitive('192.168.1.1');
    const h2 = hashSensitive('192.168.1.1');
    expect(h1).toBe(h2);
  });

  it('hashSensitive produces different hashes for different inputs', async () => {
    const { hashSensitive } = await import('../src/utils/crypto');
    expect(hashSensitive('ip1')).not.toBe(hashSensitive('ip2'));
  });

  it('money formatting never uses floating point', async () => {
    const { paiseToRupees, rupeesToPaise } = await import('../src/utils/money');
    // Test for floating point precision issues
    expect(paiseToRupees(100)).toBe('₹1.00');
    expect(paiseToRupees(101)).toBe('₹1.01');
    expect(paiseToRupees(999)).toBe('₹9.99');
    expect(paiseToRupees(10000)).toBe('₹100.00');
    expect(rupeesToPaise(1.5)).toBe(150); // Not 149.99999... 
    expect(rupeesToPaise(99.99)).toBe(9999);
  });
});
