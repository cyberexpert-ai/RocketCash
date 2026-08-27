import dotenv from 'dotenv';
dotenv.config();

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env: ${key}`);
  return val;
}

function optional(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

export const config = {
  nodeEnv: optional('NODE_ENV', 'development'),
  port: parseInt(optional('PORT', '3000'), 10),
  appUrl: optional('APP_URL', 'http://localhost:3000'),
  miniAppUrl: optional('MINI_APP_URL', 'http://localhost:3000/miniapp'),

  telegram: {
    botToken: required('TELEGRAM_BOT_TOKEN'),
    webhookSecret: optional('TELEGRAM_WEBHOOK_SECRET', 'webhook_secret'),
    superAdminChatId: parseInt(required('SUPER_ADMIN_CHAT_ID'), 10),
  },

  db: {
    url: required('DATABASE_URL'),
  },

  session: {
    secret: optional('SESSION_SECRET', 'session_secret_change_me'),
    jwtSecret: optional('JWT_SECRET', 'jwt_secret_change_me'),
    expirySeconds: 86400 * 7, // 7 days
  },

  encryption: {
    key: optional('ENCRYPTION_KEY', '0'.repeat(64)),
  },

  rateLimit: {
    windowMs: parseInt(optional('RATE_LIMIT_WINDOW_MS', '60000'), 10),
    max: parseInt(optional('RATE_LIMIT_MAX_REQUESTS', '100'), 10),
  },

  log: {
    level: optional('LOG_LEVEL', 'info'),
  },
};
