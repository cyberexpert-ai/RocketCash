import { db } from '../db';
import { hashSensitive } from '../utils/crypto';
import { logger } from '../utils/logger';

export interface DeviceSignals {
  ipHash?: string;
  userAgentHash?: string;
  timezone?: string;
  language?: string;
  screenInfo?: string;
  installationId?: string;
}

/**
 * Assess device risk and assign PRIMARY/SECONDARY status.
 */
export async function assessDevice(userId: string, signals: DeviceSignals): Promise<void> {
  try {
    // Build group key from available stable signals
    const parts = [signals.ipHash, signals.userAgentHash, signals.timezone, signals.screenInfo]
      .filter(Boolean).join('|');

    if (!parts) return; // not enough signals

    const groupKey = hashSensitive(parts);

    await db.transaction(async (client) => {
      // Upsert device risk group
      let { rows: groups } = await client.query(
        `SELECT * FROM device_risk_groups WHERE group_key = $1 FOR UPDATE`,
        [groupKey]
      );

      let group: any;
      if (groups.length === 0) {
        const { rows: newGroup } = await client.query(
          `INSERT INTO device_risk_groups (group_key, primary_user_id) VALUES ($1, $2) RETURNING *`,
          [groupKey, userId]
        );
        group = newGroup[0];
      } else {
        group = groups[0];
      }

      // Determine account type
      const isPrimary = group.primary_user_id === userId;
      const accountType = isPrimary ? 'PRIMARY_DEVICE_ACCOUNT' : 'SECONDARY_DEVICE_ACCOUNT';

      await client.query(
        `UPDATE users SET device_account_type = $1 WHERE id = $2 AND device_account_type = 'UNKNOWN'`,
        [accountType, userId]
      );

      // Record signals
      await client.query(
        `INSERT INTO device_signals (user_id, device_risk_group_id, ip_hash, user_agent_hash, timezone, language, screen_info, installation_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [userId, group.id, signals.ipHash || null, signals.userAgentHash || null,
         signals.timezone || null, signals.language || null,
         signals.screenInfo || null, signals.installationId || null]
      );

      // Risk scoring
      if (!isPrimary) {
        // Check how many accounts on this device
        const { rows: groupUsers } = await client.query(
          `SELECT COUNT(DISTINCT user_id) as count FROM device_signals WHERE device_risk_group_id = $1`,
          [group.id]
        );
        const count = parseInt(groupUsers[0].count);

        if (count >= 5) {
          await client.query(
            `UPDATE device_risk_groups SET risk_level = 'HIGH_RISK' WHERE id = $1`, [group.id]
          );
          await flagRisk(userId, 'MULTIPLE_ACCOUNTS_HIGH', 'MEDIUM_RISK',
            `${count} accounts on same device`, client);
        } else if (count >= 3) {
          await flagRisk(userId, 'MULTIPLE_ACCOUNTS', 'LOW_RISK',
            `${count} accounts on same device`, client);
        }
      }
    });
  } catch (err: any) {
    logger.error('Device assessment error', { userId, err: err.message });
  }
}

async function flagRisk(
  userId: string, flagType: string, severity: string, description: string, client: any
): Promise<void> {
  await client.query(
    `INSERT INTO account_risk_flags (user_id, flag_type, severity, description)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING`,
    [userId, flagType, severity, description]
  );
}

export async function getFraudSummary(): Promise<any> {
  const { rows: multipleAccounts } = await db.query(
    `SELECT drg.group_key, drg.risk_level, COUNT(DISTINCT ds.user_id) as account_count
     FROM device_risk_groups drg
     JOIN device_signals ds ON ds.device_risk_group_id = drg.id
     GROUP BY drg.id, drg.group_key, drg.risk_level
     HAVING COUNT(DISTINCT ds.user_id) > 1
     ORDER BY account_count DESC LIMIT 50`
  );

  const { rows: highRiskUsers } = await db.query(
    `SELECT u.id, u.telegram_id, u.username, u.first_name, u.risk_level, u.device_account_type
     FROM users u WHERE u.risk_level IN ('MEDIUM_RISK', 'HIGH_RISK', 'BLOCKED')
     ORDER BY u.created_at DESC LIMIT 50`
  );

  const { rows: fraudFlags } = await db.query(
    `SELECT ff.*, u.telegram_id, u.username, u.first_name
     FROM fraud_flags ff JOIN users u ON u.id = ff.user_id
     WHERE ff.admin_reviewed = FALSE
     ORDER BY ff.created_at DESC LIMIT 50`
  );

  return { multipleAccounts, highRiskUsers, fraudFlags };
}

export async function blockUser(adminId: string, userId: string, reason: string): Promise<void> {
  await db.query(`UPDATE users SET status = 'BLOCKED', updated_at = NOW() WHERE id = $1`, [userId]);
  await db.query(
    `INSERT INTO fraud_flags (user_id, flag_type, details, action_taken, admin_reviewed)
     VALUES ($1, 'ADMIN_BLOCK', $2, 'BLOCKED', TRUE)`,
    [userId, JSON.stringify({ reason })]
  );
  await db.query(
    `INSERT INTO audit_logs (admin_id, action, target_type, target_id, reason)
     VALUES ($1, 'BLOCK_USER', 'user', $2, $3)`,
    [adminId, userId, reason]
  );
}

export async function unblockUser(adminId: string, userId: string): Promise<void> {
  await db.query(`UPDATE users SET status = 'ACTIVE', updated_at = NOW() WHERE id = $1`, [userId]);
  await db.query(
    `INSERT INTO audit_logs (admin_id, action, target_type, target_id)
     VALUES ($1, 'UNBLOCK_USER', 'user', $2)`,
    [adminId, userId]
  );
}
