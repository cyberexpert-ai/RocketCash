-- ============================================================
-- ROCKETCASH — DATABASE SCHEMA
-- Migration: 001_initial
-- ============================================================

BEGIN;

-- ============================================================
-- EXTENSIONS
-- ============================================================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- ENUMS
-- ============================================================

CREATE TYPE user_status AS ENUM ('ACTIVE', 'BLOCKED', 'SUSPENDED', 'DELETED');
CREATE TYPE device_account_type AS ENUM ('PRIMARY_DEVICE_ACCOUNT', 'SECONDARY_DEVICE_ACCOUNT', 'UNKNOWN');
CREATE TYPE risk_level AS ENUM ('CLEAN', 'LOW_RISK', 'MEDIUM_RISK', 'HIGH_RISK', 'BLOCKED');
CREATE TYPE wallet_tx_type AS ENUM (
  'TASK_REWARD', 'SURVEY_REWARD', 'OFFER_REWARD', 'SPIN_REWARD',
  'REFERRAL_REWARD', 'SIGNUP_BONUS', 'WITHDRAWAL_HOLD', 'WITHDRAWAL_DEBIT',
  'WITHDRAWAL_REVERSAL', 'ADMIN_CREDIT', 'ADMIN_DEBIT', 'REFUND', 'ADJUSTMENT'
);
CREATE TYPE wallet_tx_status AS ENUM ('PENDING', 'COMPLETED', 'FAILED', 'REVERSED');
CREATE TYPE withdrawal_status AS ENUM ('PENDING', 'PROCESSING', 'SUCCESS', 'FAILED', 'REVERSED', 'REJECTED', 'CANCELLED');
CREATE TYPE withdrawal_method AS ENUM ('BANK', 'UPI');
CREATE TYPE payout_status AS ENUM ('PENDING', 'PROCESSING', 'SUCCESS', 'FAILED', 'REVERSED', 'CANCELLED');
CREATE TYPE task_status AS ENUM ('AVAILABLE', 'STARTED', 'COMPLETED', 'EXPIRED', 'FAILED');
CREATE TYPE admin_role AS ENUM ('SUPER_ADMIN', 'ADMIN', 'FINANCE', 'SUPPORT', 'ANALYST');
CREATE TYPE broadcast_type AS ENUM ('BOT', 'CHANNEL');
CREATE TYPE broadcast_status AS ENUM ('DRAFT', 'PENDING', 'SENDING', 'COMPLETED', 'FAILED', 'CANCELLED');
CREATE TYPE job_status AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');
CREATE TYPE upi_status AS ENUM ('VALID', 'INVALID', 'UNVERIFIED');

-- ============================================================
-- USERS
-- ============================================================

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  telegram_id BIGINT NOT NULL UNIQUE,
  username VARCHAR(255),
  first_name VARCHAR(255) NOT NULL,
  last_name VARCHAR(255),
  language_code VARCHAR(10) DEFAULT 'en',
  status user_status NOT NULL DEFAULT 'ACTIVE',
  device_account_type device_account_type NOT NULL DEFAULT 'UNKNOWN',
  risk_level risk_level NOT NULL DEFAULT 'CLEAN',
  is_bot_blocked BOOLEAN DEFAULT FALSE,
  referral_code VARCHAR(32) UNIQUE,
  referred_by_user_id UUID REFERENCES users(id),
  referral_eligible BOOLEAN DEFAULT TRUE,
  withdrawal_eligible BOOLEAN DEFAULT TRUE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_active_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_users_telegram_id ON users(telegram_id);
CREATE INDEX idx_users_status ON users(status);
CREATE INDEX idx_users_risk_level ON users(risk_level);
CREATE INDEX idx_users_created_at ON users(created_at);
CREATE INDEX idx_users_referral_code ON users(referral_code);

-- ============================================================
-- SESSIONS
-- ============================================================

CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_token VARCHAR(255) NOT NULL UNIQUE,
  telegram_init_data TEXT NOT NULL,
  telegram_hash VARCHAR(255) NOT NULL,
  auth_date BIGINT NOT NULL,
  ip_hash VARCHAR(255),
  user_agent_hash VARCHAR(255),
  is_valid BOOLEAN DEFAULT TRUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_sessions_token ON sessions(session_token);
CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);

-- ============================================================
-- DEVICE RISK GROUPS
-- ============================================================

CREATE TABLE device_risk_groups (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_key VARCHAR(255) NOT NULL UNIQUE,
  primary_user_id UUID REFERENCES users(id),
  risk_level risk_level NOT NULL DEFAULT 'CLEAN',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE device_signals (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_risk_group_id UUID REFERENCES device_risk_groups(id),
  ip_hash VARCHAR(255),
  user_agent_hash VARCHAR(255),
  timezone VARCHAR(100),
  language VARCHAR(20),
  screen_info VARCHAR(255),
  installation_id VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_device_signals_user_id ON device_signals(user_id);
CREATE INDEX idx_device_signals_ip_hash ON device_signals(ip_hash);

CREATE TABLE account_risk_flags (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  flag_type VARCHAR(100) NOT NULL,
  description TEXT,
  severity risk_level NOT NULL DEFAULT 'LOW_RISK',
  resolved BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_account_risk_flags_user_id ON account_risk_flags(user_id);

CREATE TABLE fraud_flags (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  flag_type VARCHAR(100) NOT NULL,
  details JSONB,
  action_taken VARCHAR(255),
  admin_reviewed BOOLEAN DEFAULT FALSE,
  admin_user_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_fraud_flags_user_id ON fraud_flags(user_id);

-- ============================================================
-- WALLET
-- ============================================================

CREATE TABLE wallet_accounts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  balance_paise BIGINT NOT NULL DEFAULT 0 CHECK (balance_paise >= 0),
  total_earned_paise BIGINT NOT NULL DEFAULT 0,
  total_withdrawn_paise BIGINT NOT NULL DEFAULT 0,
  is_frozen BOOLEAN DEFAULT FALSE,
  frozen_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_wallet_accounts_user_id ON wallet_accounts(user_id);

CREATE TABLE wallet_transactions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wallet_id UUID NOT NULL REFERENCES wallet_accounts(id),
  type wallet_tx_type NOT NULL,
  amount_paise BIGINT NOT NULL,
  balance_before_paise BIGINT NOT NULL,
  balance_after_paise BIGINT NOT NULL,
  status wallet_tx_status NOT NULL DEFAULT 'COMPLETED',
  reference_id UUID,
  reference_type VARCHAR(100),
  idempotency_key VARCHAR(255) UNIQUE,
  description TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_wallet_tx_user_id ON wallet_transactions(user_id);
CREATE INDEX idx_wallet_tx_wallet_id ON wallet_transactions(wallet_id);
CREATE INDEX idx_wallet_tx_type ON wallet_transactions(type);
CREATE INDEX idx_wallet_tx_created_at ON wallet_transactions(created_at);
CREATE INDEX idx_wallet_tx_idempotency ON wallet_transactions(idempotency_key);
CREATE INDEX idx_wallet_tx_reference ON wallet_transactions(reference_id, reference_type);

-- ============================================================
-- TASK PROVIDERS & TASKS
-- ============================================================

CREATE TABLE task_providers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(100) NOT NULL UNIQUE,
  display_name VARCHAR(255) NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  config JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE tasks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  provider_id UUID NOT NULL REFERENCES task_providers(id),
  external_id VARCHAR(255),
  title VARCHAR(500),
  description TEXT,
  reward_paise BIGINT,
  category VARCHAR(100),
  country_code VARCHAR(10),
  is_active BOOLEAN DEFAULT TRUE,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE task_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id UUID REFERENCES tasks(id),
  provider_id UUID NOT NULL REFERENCES task_providers(id),
  external_task_id VARCHAR(255),
  status task_status NOT NULL DEFAULT 'STARTED',
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  reward_paise BIGINT,
  wallet_tx_id UUID REFERENCES wallet_transactions(id),
  metadata JSONB
);

CREATE INDEX idx_task_sessions_user_id ON task_sessions(user_id);
CREATE INDEX idx_task_sessions_status ON task_sessions(status);

CREATE TABLE provider_callbacks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  provider_name VARCHAR(100) NOT NULL,
  provider_transaction_id VARCHAR(255) NOT NULL,
  user_id UUID REFERENCES users(id),
  payload JSONB NOT NULL,
  signature VARCHAR(500),
  is_valid BOOLEAN DEFAULT FALSE,
  is_processed BOOLEAN DEFAULT FALSE,
  processed_at TIMESTAMPTZ,
  wallet_tx_id UUID REFERENCES wallet_transactions(id),
  error TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(provider_name, provider_transaction_id)
);

CREATE INDEX idx_provider_callbacks_tx_id ON provider_callbacks(provider_transaction_id);
CREATE INDEX idx_provider_callbacks_user_id ON provider_callbacks(user_id);
CREATE INDEX idx_provider_callbacks_processed ON provider_callbacks(is_processed);

-- ============================================================
-- SPIN SYSTEM
-- ============================================================

CREATE TABLE spin_configs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  is_enabled BOOLEAN DEFAULT TRUE,
  daily_limit INT NOT NULL DEFAULT 1,
  signup_spins INT NOT NULL DEFAULT 1,
  is_fixed_reward BOOLEAN DEFAULT FALSE,
  fixed_reward_paise BIGINT DEFAULT 0,
  reward_options JSONB NOT NULL DEFAULT '[]',
  reward_weights JSONB NOT NULL DEFAULT '[]',
  timezone VARCHAR(50) DEFAULT 'Asia/Kolkata',
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE spin_results (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reward_paise BIGINT NOT NULL,
  spin_config_id UUID REFERENCES spin_configs(id),
  wallet_tx_id UUID REFERENCES wallet_transactions(id),
  idempotency_key VARCHAR(255) UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_spin_results_user_id ON spin_results(user_id);
CREATE INDEX idx_spin_results_created_at ON spin_results(created_at);

CREATE TABLE daily_spin_usage (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  spin_date DATE NOT NULL,
  count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, spin_date)
);

CREATE INDEX idx_daily_spin_usage_user_date ON daily_spin_usage(user_id, spin_date);

-- ============================================================
-- REFERRAL SYSTEM
-- ============================================================

CREATE TABLE referrals (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  referrer_user_id UUID NOT NULL REFERENCES users(id),
  referred_user_id UUID NOT NULL UNIQUE REFERENCES users(id),
  status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
  is_valid BOOLEAN DEFAULT FALSE,
  qualifying_activity_at TIMESTAMPTZ,
  reward_paise BIGINT DEFAULT 0,
  referrer_wallet_tx_id UUID REFERENCES wallet_transactions(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_referrals_referrer ON referrals(referrer_user_id);
CREATE INDEX idx_referrals_referred ON referrals(referred_user_id);

CREATE TABLE referral_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  referral_id UUID NOT NULL REFERENCES referrals(id),
  event_type VARCHAR(100) NOT NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- WITHDRAWALS
-- ============================================================

CREATE TABLE bank_accounts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  holder_name VARCHAR(255) NOT NULL,
  account_number_encrypted TEXT NOT NULL,
  account_number_last4 VARCHAR(4) NOT NULL,
  ifsc_code VARCHAR(20) NOT NULL,
  bank_name VARCHAR(255),
  branch_name VARCHAR(255),
  account_type VARCHAR(50),
  is_verified BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_bank_accounts_user_id ON bank_accounts(user_id);

CREATE TABLE upi_accounts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  upi_id VARCHAR(255) NOT NULL,
  status upi_status NOT NULL DEFAULT 'UNVERIFIED',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_upi_accounts_user_id ON upi_accounts(user_id);

CREATE TABLE withdrawals (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wallet_id UUID NOT NULL REFERENCES wallet_accounts(id),
  method withdrawal_method NOT NULL,
  amount_paise BIGINT NOT NULL,
  status withdrawal_status NOT NULL DEFAULT 'PENDING',
  bank_account_id UUID REFERENCES bank_accounts(id),
  upi_account_id UUID REFERENCES upi_accounts(id),
  hold_tx_id UUID REFERENCES wallet_transactions(id),
  debit_tx_id UUID REFERENCES wallet_transactions(id),
  reversal_tx_id UUID REFERENCES wallet_transactions(id),
  payout_tx_id UUID,
  idempotency_key VARCHAR(255) NOT NULL UNIQUE,
  failure_reason TEXT,
  admin_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_withdrawals_user_id ON withdrawals(user_id);
CREATE INDEX idx_withdrawals_status ON withdrawals(status);
CREATE INDEX idx_withdrawals_created_at ON withdrawals(created_at);

-- ============================================================
-- PAYOUT PROVIDERS & TRANSACTIONS
-- ============================================================

CREATE TABLE payout_providers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(100) NOT NULL UNIQUE,
  display_name VARCHAR(255),
  is_active BOOLEAN DEFAULT FALSE,
  environment VARCHAR(20) DEFAULT 'test',
  config JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE payout_transactions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  withdrawal_id UUID NOT NULL REFERENCES withdrawals(id),
  provider_name VARCHAR(100) NOT NULL,
  provider_payout_id VARCHAR(255),
  provider_reference VARCHAR(255),
  utr VARCHAR(255),
  status payout_status NOT NULL DEFAULT 'PENDING',
  idempotency_key VARCHAR(255) NOT NULL UNIQUE,
  amount_paise BIGINT NOT NULL,
  failure_reason TEXT,
  provider_response JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_payout_tx_withdrawal ON payout_transactions(withdrawal_id);
CREATE INDEX idx_payout_tx_provider_id ON payout_transactions(provider_payout_id);
CREATE INDEX idx_payout_tx_status ON payout_transactions(status);

CREATE TABLE payout_webhooks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  provider_name VARCHAR(100) NOT NULL,
  event_id VARCHAR(255),
  event_type VARCHAR(255),
  payload JSONB NOT NULL,
  signature VARCHAR(500),
  is_valid BOOLEAN DEFAULT FALSE,
  is_processed BOOLEAN DEFAULT FALSE,
  processed_at TIMESTAMPTZ,
  payout_tx_id UUID REFERENCES payout_transactions(id),
  error TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(provider_name, event_id)
);

CREATE INDEX idx_payout_webhooks_event ON payout_webhooks(event_id);
CREATE INDEX idx_payout_webhooks_processed ON payout_webhooks(is_processed);

-- ============================================================
-- CHANNELS
-- ============================================================

CREATE TABLE required_channels (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  telegram_username VARCHAR(255),
  telegram_chat_id BIGINT,
  invite_url VARCHAR(500),
  channel_type VARCHAR(50) DEFAULT 'PUBLIC',
  is_active BOOLEAN DEFAULT TRUE,
  broadcast_enabled BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE channel_permissions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  channel_id UUID NOT NULL REFERENCES required_channels(id),
  bot_is_member BOOLEAN DEFAULT FALSE,
  bot_is_admin BOOLEAN DEFAULT FALSE,
  can_post BOOLEAN DEFAULT FALSE,
  last_checked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- BROADCASTS
-- ============================================================

CREATE TABLE broadcasts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  type broadcast_type NOT NULL,
  created_by UUID NOT NULL,
  audience_type VARCHAR(100),
  message_type VARCHAR(50) NOT NULL DEFAULT 'text',
  message_text TEXT,
  message_media_id VARCHAR(255),
  message_buttons JSONB,
  status broadcast_status NOT NULL DEFAULT 'DRAFT',
  total_recipients INT DEFAULT 0,
  successful_count INT DEFAULT 0,
  failed_count INT DEFAULT 0,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE broadcast_recipients (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  broadcast_id UUID NOT NULL REFERENCES broadcasts(id),
  user_id UUID NOT NULL REFERENCES users(id),
  status VARCHAR(50) DEFAULT 'PENDING',
  sent_at TIMESTAMPTZ,
  error TEXT
);

CREATE INDEX idx_broadcast_recipients_broadcast ON broadcast_recipients(broadcast_id);
CREATE INDEX idx_broadcast_recipients_user ON broadcast_recipients(user_id);

CREATE TABLE channel_broadcasts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  broadcast_id UUID NOT NULL REFERENCES broadcasts(id),
  created_by UUID NOT NULL,
  status broadcast_status NOT NULL DEFAULT 'DRAFT',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE channel_broadcast_targets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  channel_broadcast_id UUID NOT NULL REFERENCES channel_broadcasts(id),
  channel_id UUID NOT NULL REFERENCES required_channels(id)
);

CREATE TABLE channel_broadcast_results (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  channel_broadcast_id UUID NOT NULL REFERENCES channel_broadcasts(id),
  channel_id UUID NOT NULL REFERENCES required_channels(id),
  status VARCHAR(50),
  message_id BIGINT,
  error TEXT,
  sent_at TIMESTAMPTZ
);

-- ============================================================
-- ADMIN
-- ============================================================

CREATE TABLE admin_users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  telegram_id BIGINT NOT NULL UNIQUE,
  username VARCHAR(255),
  first_name VARCHAR(255),
  role admin_role NOT NULL DEFAULT 'SUPPORT',
  is_active BOOLEAN DEFAULT TRUE,
  permissions JSONB DEFAULT '[]',
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_active_at TIMESTAMPTZ
);

CREATE INDEX idx_admin_users_telegram ON admin_users(telegram_id);

CREATE TABLE admin_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  admin_id UUID NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  session_token VARCHAR(255) NOT NULL UNIQUE,
  state VARCHAR(100),
  state_data JSONB,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_admin_sessions_token ON admin_sessions(session_token);
CREATE INDEX idx_admin_sessions_admin ON admin_sessions(admin_id);

-- ============================================================
-- PROVIDER CONFIG & SECRETS
-- ============================================================

CREATE TABLE provider_configs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  provider_name VARCHAR(100) NOT NULL UNIQUE,
  environment VARCHAR(20) DEFAULT 'test',
  is_active BOOLEAN DEFAULT FALSE,
  config JSONB DEFAULT '{}',
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE encrypted_secrets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  provider_name VARCHAR(100) NOT NULL,
  key_name VARCHAR(100) NOT NULL,
  encrypted_value TEXT NOT NULL,
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(provider_name, key_name)
);

-- ============================================================
-- SYSTEM SETTINGS
-- ============================================================

CREATE TABLE admin_settings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  key VARCHAR(255) NOT NULL UNIQUE,
  value TEXT NOT NULL,
  description TEXT,
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- NOTIFICATIONS
-- ============================================================

CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(100) NOT NULL,
  title VARCHAR(500),
  message TEXT NOT NULL,
  is_sent BOOLEAN DEFAULT FALSE,
  sent_at TIMESTAMPTZ,
  error TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notifications_user_id ON notifications(user_id);
CREATE INDEX idx_notifications_sent ON notifications(is_sent);

-- ============================================================
-- AUDIT LOGS
-- ============================================================

CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  admin_id UUID REFERENCES admin_users(id),
  action VARCHAR(255) NOT NULL,
  target_type VARCHAR(100),
  target_id UUID,
  old_value JSONB,
  new_value JSONB,
  reason TEXT,
  ip_hash VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_logs_admin ON audit_logs(admin_id);
CREATE INDEX idx_audit_logs_action ON audit_logs(action);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at);

-- ============================================================
-- IMPORTS / EXPORTS
-- ============================================================

CREATE TABLE imports (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  admin_id UUID NOT NULL REFERENCES admin_users(id),
  type VARCHAR(100) NOT NULL,
  filename VARCHAR(255),
  status VARCHAR(50) DEFAULT 'PENDING',
  total_rows INT DEFAULT 0,
  successful_rows INT DEFAULT 0,
  failed_rows INT DEFAULT 0,
  errors JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE exports (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  admin_id UUID NOT NULL REFERENCES admin_users(id),
  type VARCHAR(100) NOT NULL,
  format VARCHAR(20) NOT NULL DEFAULT 'csv',
  filename VARCHAR(255),
  status VARCHAR(50) DEFAULT 'PENDING',
  row_count INT DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- ============================================================
-- SCHEDULED JOBS
-- ============================================================

CREATE TABLE scheduled_jobs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_type VARCHAR(100) NOT NULL,
  payload JSONB,
  status job_status NOT NULL DEFAULT 'PENDING',
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 3,
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at TIMESTAMPTZ,
  locked_by VARCHAR(255),
  completed_at TIMESTAMPTZ,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_scheduled_jobs_status_next ON scheduled_jobs(status, next_run_at);
CREATE INDEX idx_scheduled_jobs_type ON scheduled_jobs(job_type);

-- ============================================================
-- RECONCILIATION
-- ============================================================

CREATE TABLE reconciliation_records (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  type VARCHAR(100) NOT NULL,
  reference_id UUID,
  issue_type VARCHAR(100) NOT NULL,
  description TEXT,
  status VARCHAR(50) DEFAULT 'OPEN',
  resolved_by UUID,
  resolved_at TIMESTAMPTZ,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_reconciliation_status ON reconciliation_records(status);
CREATE INDEX idx_reconciliation_type ON reconciliation_records(type);

-- ============================================================
-- SEED INITIAL DATA
-- ============================================================

-- Default spin config
INSERT INTO spin_configs (is_enabled, daily_limit, signup_spins, is_fixed_reward, fixed_reward_paise, reward_options, reward_weights)
VALUES (TRUE, 1, 1, FALSE, 0, '[100, 200, 500, 1000, 2000, 5000]', '[30, 25, 20, 15, 8, 2]');

-- Default system settings
INSERT INTO admin_settings (key, value, description) VALUES
  ('min_withdrawal_paise', '10000', 'Minimum withdrawal amount in paise (₹100)'),
  ('max_withdrawal_paise', '500000', 'Maximum withdrawal amount in paise (₹5000)'),
  ('daily_withdrawal_limit', '3', 'Maximum withdrawals per user per day'),
  ('withdrawal_enabled', 'true', 'Global withdrawal on/off'),
  ('bank_enabled', 'true', 'Bank withdrawal enabled'),
  ('upi_enabled', 'true', 'UPI withdrawal enabled'),
  ('auto_payout_enabled', 'false', 'Automatic payout via RazorpayX'),
  ('manual_approval_required', 'true', 'Require manual approval for withdrawals'),
  ('referral_enabled', 'true', 'Referral system enabled'),
  ('referral_reward_paise', '5000', 'Referral reward in paise (₹50)'),
  ('daily_referral_limit', '10', 'Max referrals per day'),
  ('referral_qualifying_activity', 'FIRST_WITHDRAWAL', 'What qualifies a referral'),
  ('task_system_enabled', 'true', 'Task system enabled'),
  ('maintenance_mode', 'false', 'Maintenance mode'),
  ('support_username', 'RocketCashSupport', 'Support Telegram username'),
  ('signup_bonus_paise', '0', 'Signup bonus amount (0 = disabled)');

-- Default task provider
INSERT INTO task_providers (name, display_name, is_active, config)
VALUES ('bitlabs', 'BitLabs', FALSE, '{"api_token": "", "app_id": ""}');

-- Default payout provider
INSERT INTO payout_providers (name, display_name, is_active, environment)
VALUES ('razorpayx', 'RazorpayX', FALSE, 'test');

-- Default provider configs
INSERT INTO provider_configs (provider_name, environment, is_active, config)
VALUES
  ('bitlabs', 'production', FALSE, '{}'),
  ('razorpayx', 'test', FALSE, '{}'),
  ('ifsc', 'production', TRUE, '{"provider_url": "https://ifsc.razorpay.com"}');

-- Insert Super Admin
INSERT INTO admin_users (telegram_id, username, first_name, role, is_active, permissions)
VALUES (
  8004114088,
  'superadmin',
  'Super Admin',
  'SUPER_ADMIN',
  TRUE,
  '["VIEW_DASHBOARD","VIEW_USERS","EDIT_USERS","MANAGE_TASKS","MANAGE_SPINS","MANAGE_REFERRALS","MANAGE_WITHDRAWALS","MANAGE_PAYOUTS","MANAGE_CHANNELS","SEND_BOT_BROADCAST","SEND_CHANNEL_BROADCAST","MANAGE_PROVIDER_SETTINGS","MANAGE_SYSTEM_SETTINGS","IMPORT_DATA","EXPORT_DATA","VIEW_AUDIT_LOGS","MANAGE_ADMINS"]'
);

COMMIT;
