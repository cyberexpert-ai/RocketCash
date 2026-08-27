import { db } from '../db';
import { creditWallet } from './wallet';
import { logger } from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';

export async function getSpinConfig(): Promise<any> {
  const { rows } = await db.query(`SELECT * FROM spin_configs ORDER BY updated_at DESC LIMIT 1`);
  return rows[0];
}

function weightedRandom(options: number[], weights: number[]): number {
  const total = weights.reduce((a, b) => a + b, 0);
  let rand = Math.random() * total;
  for (let i = 0; i < options.length; i++) {
    rand -= weights[i];
    if (rand <= 0) return options[i];
  }
  return options[options.length - 1];
}

/**
 * Get today's spin date in IST timezone.
 */
function getISTDate(): string {
  const now = new Date();
  const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  return ist.toISOString().split('T')[0];
}

/**
 * Perform a spin for the authenticated user.
 * Backend determines the reward — never the frontend.
 */
export async function playSpin(userId: string): Promise<{ rewardPaise: number; txId: string; spinId: string }> {
  return db.transaction(async (client) => {
    // Lock user row to prevent concurrent spins
    await client.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [userId]);

    const config = await getSpinConfig();
    if (!config || !config.is_enabled) {
      throw new Error('SPIN_DISABLED');
    }

    const today = getISTDate();

    // Check/update daily spin usage
    const { rows: usageRows } = await client.query(
      `INSERT INTO daily_spin_usage (user_id, spin_date, count)
       VALUES ($1, $2, 1)
       ON CONFLICT (user_id, spin_date)
       DO UPDATE SET count = daily_spin_usage.count + 1, updated_at = NOW()
       RETURNING count`,
      [userId, today]
    );

    const count = usageRows[0].count;
    if (count > config.daily_limit) {
      // Rollback by decrementing
      await client.query(
        `UPDATE daily_spin_usage SET count = count - 1 WHERE user_id = $1 AND spin_date = $2`,
        [userId, today]
      );
      throw new Error('DAILY_LIMIT_REACHED');
    }

    // Determine reward (backend only)
    let rewardPaise: number;
    if (config.is_fixed_reward) {
      rewardPaise = parseInt(config.fixed_reward_paise, 10);
    } else {
      const options: number[] = config.reward_options;
      const weights: number[] = config.reward_weights;
      rewardPaise = weightedRandom(options, weights);
    }

    const idempotencyKey = `spin_${userId}_${today}_${count}`;
    const spinId = uuidv4();

    // Credit wallet
    const tx = await creditWallet({
      userId,
      amountPaise: rewardPaise,
      type: 'SPIN_REWARD',
      idempotencyKey,
      description: `Spin reward`,
      referenceId: spinId,
      referenceType: 'spin',
      client,
    });

    // Record spin result
    await client.query(
      `INSERT INTO spin_results (id, user_id, reward_paise, spin_config_id, wallet_tx_id, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [spinId, userId, rewardPaise, config.id, tx.id, idempotencyKey]
    );

    logger.info('Spin completed', { userId, rewardPaise, spinId });
    return { rewardPaise, txId: tx.id, spinId };
  });
}

export async function getSpinStatus(userId: string): Promise<{
  enabled: boolean;
  spinsToday: number;
  dailyLimit: number;
  spinsLeft: number;
}> {
  const config = await getSpinConfig();
  if (!config) return { enabled: false, spinsToday: 0, dailyLimit: 0, spinsLeft: 0 };

  const today = getISTDate();
  const { rows } = await db.query(
    `SELECT count FROM daily_spin_usage WHERE user_id = $1 AND spin_date = $2`,
    [userId, today]
  );

  const spinsToday = rows[0]?.count || 0;
  const dailyLimit = config.daily_limit;
  return {
    enabled: config.is_enabled,
    spinsToday,
    dailyLimit,
    spinsLeft: Math.max(0, dailyLimit - spinsToday),
  };
}
