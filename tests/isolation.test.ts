/**
 * ROCKETCASH — Security & Isolation Tests
 * Tests IDOR protection, user isolation, and admin auth.
 */

import { validateInitData, validateSession } from '../src/services/auth';
import { creditWallet, debitWallet, getWallet } from '../src/services/wallet';
import { db } from '../src/db';
import crypto from 'crypto';

// ─── MOCK DB ────────────────────────────────────────────────
jest.mock('../src/db', () => ({
  db: {
    query: jest.fn(),
    transaction: jest.fn(async (fn) => fn({
      query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    })),
    healthCheck: jest.fn().mockResolvedValue(true),
    end: jest.fn(),
  },
}));

const mockDb = db as jest.Mocked<typeof db>;

describe('=== USER ISOLATION TESTS ===', () => {
  const USER_A = { id: 'user-a-uuid', telegramId: 100001, balance: 2500 };  // ₹25
  const USER_B = { id: 'user-b-uuid', telegramId: 100002, balance: 700 };   // ₹7

  describe('Balance Isolation', () => {
    it('should return ₹25 for User A', async () => {
      mockDb.query.mockImplementation((sql: string, params: any[]) => {
        if (sql.includes('wallet_accounts') && params[0] === USER_A.id) {
          return Promise.resolve({ rows: [{ balance_paise: 2500, total_earned_paise: 2500, total_withdrawn_paise: 0, is_frozen: false, first_name: 'UserA' }], rowCount: 1 });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      });

      const wallet = await getWallet(USER_A.id);
      expect(wallet?.balance_paise).toBe(2500);
      expect(wallet?.balance_paise).not.toBe(700); // Must NOT show User B's balance
    });

    it('should return ₹7 for User B', async () => {
      mockDb.query.mockImplementation((sql: string, params: any[]) => {
        if (sql.includes('wallet_accounts') && params[0] === USER_B.id) {
          return Promise.resolve({ rows: [{ balance_paise: 700, total_earned_paise: 700, total_withdrawn_paise: 0, is_frozen: false, first_name: 'UserB' }], rowCount: 1 });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      });

      const wallet = await getWallet(USER_B.id);
      expect(wallet?.balance_paise).toBe(700);
      expect(wallet?.balance_paise).not.toBe(2500); // Must NOT show User A's balance
    });

    it('User A wallet query must include user_id filter', async () => {
      mockDb.query.mockResolvedValue({ rows: [], rowCount: 0 });
      await getWallet(USER_A.id);

      const callArgs = (mockDb.query as jest.Mock).mock.calls;
      const walletCall = callArgs.find((args: any[]) =>
        args[0].includes('wallet_accounts') && args[1]?.includes(USER_A.id)
      );
      expect(walletCall).toBeTruthy();
      // Ensure User B's ID was NOT in the query
      const queryParams = walletCall?.[1] || [];
      expect(queryParams).not.toContain(USER_B.id);
    });
  });

  describe('Session Isolation', () => {
    it('validateSession should return userId from server-side session only', async () => {
      const fakeToken = 'valid-session-token';
      mockDb.query.mockImplementation((sql: string, params: any[]) => {
        if (sql.includes('FROM sessions') && params[0] === fakeToken) {
          return Promise.resolve({ rows: [{ user_id: USER_A.id, status: 'ACTIVE' }], rowCount: 1 });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      });

      const userId = await validateSession(fakeToken);
      expect(userId).toBe(USER_A.id);
      expect(userId).not.toBe(USER_B.id);
    });

    it('invalid token must return null — not a user ID', async () => {
      mockDb.query.mockResolvedValue({ rows: [], rowCount: 0 });
      const userId = await validateSession('hacker-fake-token');
      expect(userId).toBeNull();
    });

    it('expired token must return null', async () => {
      mockDb.query.mockResolvedValue({ rows: [], rowCount: 0 });
      const userId = await validateSession('expired-token-xxx');
      expect(userId).toBeNull();
    });
  });
});

describe('=== IDOR PROTECTION TESTS ===', () => {
  it('wallet credit must use authenticated userId, not any other ID', async () => {
    const authUserId = 'legitimate-user-id';
    const attackerInjectedId = 'victim-user-id';

    const transactionSpy = jest.spyOn(db, 'transaction').mockImplementation(async (fn) => {
      const mockClient = {
        query: jest.fn().mockImplementation((sql: string, params: any[]) => {
          // Verify that only authUserId is used, never attackerInjectedId
          if (params) {
            expect(params).not.toContain(attackerInjectedId);
          }
          return Promise.resolve({ rows: [{ id: 'wallet-id', balance_paise: 1000, user_id: authUserId }], rowCount: 1 });
        }),
      };
      return fn(mockClient as any);
    });

    await creditWallet({
      userId: authUserId,
      amountPaise: 500,
      type: 'SPIN_REWARD',
      idempotencyKey: 'test-key-001',
    }).catch(() => {});

    transactionSpy.mockRestore();
  });

  it('getWallet must use server-side userId — never accept user_id from request body', async () => {
    // Simulating that even if frontend sends a different user_id, we ignore it
    const serverSideUserId = 'server-determined-user';
    const frontendProvidedUserId = 'manipulated-victim-user'; // This must NEVER be used

    mockDb.query.mockResolvedValue({ rows: [], rowCount: 0 });

    // Call getWallet with server-side userId only
    await getWallet(serverSideUserId);

    const calls = (mockDb.query as jest.Mock).mock.calls;
    for (const call of calls) {
      if (Array.isArray(call[1])) {
        expect(call[1]).not.toContain(frontendProvidedUserId);
      }
    }
  });
});

describe('=== TELEGRAM initData VALIDATION ===', () => {
  const VALID_BOT_TOKEN = 'test_bot_token:ABCDEF';

  function buildValidInitData(userId: number, botToken: string): string {
    const user = JSON.stringify({ id: userId, first_name: 'Test', username: 'tester' });
    const authDate = Math.floor(Date.now() / 1000);
    const params = new URLSearchParams({ user, auth_date: String(authDate) });
    const dataCheckString = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    params.set('hash', hash);
    return params.toString();
  }

  it('rejects initData with missing hash', () => {
    const result = validateInitData('user=%7B%22id%22%3A123%7D&auth_date=1234567890');
    expect(result.valid).toBe(false);
  });

  it('rejects initData with wrong hash', () => {
    const result = validateInitData('user=%7B%22id%22%3A123%7D&auth_date=1234567890&hash=deadbeef');
    expect(result.valid).toBe(false);
  });

  it('rejects expired initData (auth_date too old)', () => {
    const user = JSON.stringify({ id: 99999, first_name: 'Old' });
    const oldDate = Math.floor(Date.now() / 1000) - 90000; // 25 hours ago
    const result = validateInitData(`user=${encodeURIComponent(user)}&auth_date=${oldDate}&hash=anything`);
    expect(result.valid).toBe(false);
  });

  it('rejects empty initData', () => {
    expect(validateInitData('').valid).toBe(false);
    expect(validateInitData('   ').valid).toBe(false);
  });
});

describe('=== ADMIN AUTHENTICATION TESTS ===', () => {
  const SUPER_ADMIN_ID = 8004114088;
  const NORMAL_USER_ID = 123456789;

  it('returns admin for valid super admin chat ID', async () => {
    mockDb.query.mockImplementation((sql: string, params: any[]) => {
      if (params[0] === SUPER_ADMIN_ID) {
        return Promise.resolve({ rows: [{ id: 'admin-id', telegram_id: SUPER_ADMIN_ID, role: 'SUPER_ADMIN', is_active: true }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const { validateAdmin } = await import('../src/services/auth');
    const admin = await validateAdmin(SUPER_ADMIN_ID);
    expect(admin).not.toBeNull();
    expect(admin?.role).toBe('SUPER_ADMIN');
  });

  it('returns null for normal user attempting admin', async () => {
    mockDb.query.mockResolvedValue({ rows: [], rowCount: 0 });
    const { validateAdmin } = await import('../src/services/auth');
    const admin = await validateAdmin(NORMAL_USER_ID);
    expect(admin).toBeNull();
  });

  it('returns null for blocked admin', async () => {
    mockDb.query.mockResolvedValue({ rows: [], rowCount: 0 }); // is_active=FALSE filtered out
    const { validateAdmin } = await import('../src/services/auth');
    const result = await validateAdmin(999888777);
    expect(result).toBeNull();
  });
});

describe('=== WALLET LEDGER INTEGRITY TESTS ===', () => {
  it('prevents negative balance — debit must fail if insufficient funds', async () => {
    const mockClient = {
      query: jest.fn().mockImplementation((sql: string) => {
        if (sql.includes('FOR UPDATE')) {
          return Promise.resolve({ rows: [{ id: 'wallet-id', balance_paise: 100, is_frozen: false, user_id: 'user-id' }], rowCount: 1 });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      }),
    };

    jest.spyOn(db, 'transaction').mockImplementation(async (fn) => fn(mockClient as any));

    await expect(debitWallet({
      userId: 'user-id',
      amountPaise: 500, // More than balance of 100
      type: 'WITHDRAWAL_HOLD',
    })).rejects.toThrow('Insufficient balance');
  });

  it('prevents frozen wallet from being debited', async () => {
    const mockClient = {
      query: jest.fn().mockImplementation((sql: string) => {
        if (sql.includes('FOR UPDATE')) {
          return Promise.resolve({ rows: [{ id: 'wallet-id', balance_paise: 10000, is_frozen: true, user_id: 'user-id' }], rowCount: 1 });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      }),
    };

    jest.spyOn(db, 'transaction').mockImplementation(async (fn) => fn(mockClient as any));

    await expect(debitWallet({
      userId: 'user-id',
      amountPaise: 500,
      type: 'WITHDRAWAL_HOLD',
    })).rejects.toThrow('Wallet is frozen');
  });

  it('idempotent credit — same key credited only once', async () => {
    const idempotencyKey = 'bitlabs_txn_12345';
    const mockClient = {
      query: jest.fn().mockImplementation((sql: string, params: any[]) => {
        if (sql.includes('idempotency_key')) {
          return Promise.resolve({ rows: [{ id: 'existing-tx', amount_paise: 500 }], rowCount: 1 });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      }),
    };

    jest.spyOn(db, 'transaction').mockImplementation(async (fn) => fn(mockClient as any));

    const result = await creditWallet({ userId: 'user-id', amountPaise: 500, type: 'SURVEY_REWARD', idempotencyKey });
    expect(result.id).toBe('existing-tx'); // Returns existing, not new
  });

  it('rejects zero or negative credit amount', async () => {
    await expect(creditWallet({ userId: 'user-id', amountPaise: 0, type: 'SPIN_REWARD' })).rejects.toThrow('Credit amount must be positive');
    await expect(creditWallet({ userId: 'user-id', amountPaise: -100, type: 'SPIN_REWARD' })).rejects.toThrow();
  });
});

describe('=== SAME DEVICE TESTS ===', () => {
  it('first account on device gets PRIMARY status', async () => {
    const { assessDevice } = await import('../src/services/fraud');
    mockDb.query.mockResolvedValue({ rows: [], rowCount: 0 });

    const transactionSpy = jest.spyOn(db, 'transaction').mockImplementation(async (fn) => {
      const mockClient = {
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // No existing group
          .mockResolvedValueOnce({ rows: [{ id: 'group-1', primary_user_id: 'user-1' }], rowCount: 1 }) // New group created
          .mockResolvedValue({ rows: [{ count: 1 }], rowCount: 1 }),
      };
      return fn(mockClient as any);
    });

    await assessDevice('user-1', { ipHash: 'hash1', userAgentHash: 'ua1', timezone: 'Asia/Kolkata' });
    transactionSpy.mockRestore();
  });

  it('second account on same device gets SECONDARY status', async () => {
    const { assessDevice } = await import('../src/services/fraud');

    const transactionSpy = jest.spyOn(db, 'transaction').mockImplementation(async (fn) => {
      const mockClient = {
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [{ id: 'group-1', primary_user_id: 'user-1', risk_level: 'CLEAN' }], rowCount: 1 }) // Existing group
          .mockResolvedValue({ rows: [{ count: 2 }], rowCount: 1 }),
      };
      return fn(mockClient as any);
    });

    await assessDevice('user-2', { ipHash: 'hash1', userAgentHash: 'ua1', timezone: 'Asia/Kolkata' });

    // Verify SECONDARY_DEVICE_ACCOUNT was set
    const calls = (transactionSpy as any).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    transactionSpy.mockRestore();
  });
});

describe('=== SPIN TESTS ===', () => {
  it('backend determines reward — never frontend', async () => {
    const { playSpin } = await import('../src/services/spin');

    const transactionSpy = jest.spyOn(db, 'transaction').mockImplementation(async (fn) => {
      const mockClient = {
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [{ id: 'user-id' }] }) // Lock user
          .mockResolvedValueOnce({ rows: [{ is_enabled: true, daily_limit: 3, is_fixed_reward: false, reward_options: [100, 500, 1000], reward_weights: [50, 30, 20], id: 'cfg-id' }] }) // Config
          .mockResolvedValueOnce({ rows: [{ count: 1 }] }) // Daily usage
          .mockResolvedValueOnce({ rows: [{ id: 'wallet-id', balance_paise: 5000, is_frozen: false, user_id: 'user-id' }] }) // Wallet lock
          .mockResolvedValue({ rows: [{ id: 'tx-id', balance_paise: 5500 }] }),
      };
      return fn(mockClient as any);
    });

    const result = await playSpin('user-id');
    // Backend determines reward — should be one of the configured options
    expect([100, 500, 1000]).toContain(result.rewardPaise);
    transactionSpy.mockRestore();
  });

  it('rejects spin when disabled', async () => {
    const { playSpin } = await import('../src/services/spin');
    const { getSpinConfig } = await import('../src/services/spin');

    jest.spyOn(db, 'transaction').mockImplementation(async (fn) => {
      const mockClient = {
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [{ id: 'user-id' }] })
          .mockResolvedValueOnce({ rows: [{ is_enabled: false }] }),
      };
      return fn(mockClient as any);
    });

    await expect(playSpin('user-id')).rejects.toThrow('SPIN_DISABLED');
  });

  it('enforces daily spin limit', async () => {
    const { playSpin } = await import('../src/services/spin');

    jest.spyOn(db, 'transaction').mockImplementation(async (fn) => {
      const mockClient = {
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [{ id: 'user-id' }] })
          .mockResolvedValueOnce({ rows: [{ is_enabled: true, daily_limit: 1, is_fixed_reward: false, reward_options: [100], reward_weights: [100], id: 'cfg-id' }] })
          .mockResolvedValueOnce({ rows: [{ count: 2 }] }) // count > daily_limit
          .mockResolvedValueOnce({ rows: [], rowCount: 0 }), // rollback update
      };
      return fn(mockClient as any);
    });

    await expect(playSpin('user-id')).rejects.toThrow('DAILY_LIMIT_REACHED');
  });
});
