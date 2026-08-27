import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import path from 'path';
import { config } from './config';
import { logger } from './utils/logger';
import { db } from './db';
import { bot, initBot, setupWebhook } from './bot';
import { startJobRunner } from './services/jobs';

// API Routes
import authRouter from './api/routes/auth';
import userRouter from './api/routes/user';
import withdrawalsRouter from './api/routes/withdrawals';
import webhooksRouter from './api/routes/webhooks';
import {
  spinRouter, tasksRouter, walletRouter,
  historyRouter, referralRouter,
} from './api/routes/tasks';
import { ifscRouter, healthRouter } from './api/routes/ifsc';
import { generalLimiter } from './api/middleware/rateLimit';

const app = express();

// ─── SECURITY MIDDLEWARE ──────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false, // Mini App needs flexibility
  crossOriginEmbedderPolicy: false,
}));

app.use(cors({
  origin: (origin, cb) => {
    // Allow Telegram web app origins and our own
    const allowed = [
      'https://web.telegram.org',
      'https://k.web.telegram.org',
      'https://z.web.telegram.org',
      config.appUrl,
    ];
    if (!origin || allowed.some(a => origin.startsWith(a)) || config.nodeEnv !== 'production') {
      cb(null, true);
    } else {
      cb(new Error('CORS: origin not allowed'));
    }
  },
  credentials: true,
}));

// ─── BODY PARSING ─────────────────────────────────────────────
// Raw body needed for webhook signature verification
app.use('/api/webhooks', express.raw({ type: 'application/json', limit: '1mb' }), (req, _res, next) => {
  if (Buffer.isBuffer(req.body)) {
    (req as any).rawBody = req.body.toString();
    req.body = JSON.parse((req as any).rawBody);
  }
  next();
});

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── MINI APP STATIC FILES ─────────────────────────────────────
app.use('/miniapp', express.static(path.join(__dirname, '../miniapp'), {
  maxAge: '1h',
  setHeaders: (res, filePath) => {
    // Required for Telegram Mini App
    res.setHeader('X-Frame-Options', 'ALLOWALL');
    res.setHeader('Access-Control-Allow-Origin', '*');
  },
}));

// Serve Mini App index for all /miniapp/* routes (SPA)
app.get('/miniapp/*', (_req, res) => {
  res.sendFile(path.join(__dirname, '../miniapp/index.html'));
});

// ─── TELEGRAM WEBHOOK ─────────────────────────────────────────
app.post('/api/telegram/webhook', (req, res) => {
  const secretToken = req.headers['x-telegram-bot-api-secret-token'];
  if (secretToken !== config.telegram.webhookSecret) {
    logger.warn('Invalid Telegram webhook secret');
    res.status(403).send('Forbidden');
    return;
  }
  bot.handleUpdate(req.body, res);
});

// ─── API ROUTES ───────────────────────────────────────────────
app.use('/api', generalLimiter);
app.use('/api/auth', authRouter);
app.use('/api/me', userRouter);
app.use('/api/config', userRouter);
app.use('/api/wallet', walletRouter);
app.use('/api/spins', spinRouter);
app.use('/api/tasks', tasksRouter);
app.use('/api/history', historyRouter);
app.use('/api/referral', referralRouter);
app.use('/api/withdrawals', withdrawalsRouter);
app.use('/api/webhooks', webhooksRouter);
app.use('/api/ifsc', ifscRouter);
app.use('/api/payment', ifscRouter);
app.use('/api/health', healthRouter);

// ─── 404 ──────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ─── ERROR HANDLER ────────────────────────────────────────────
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error('Unhandled error', { err: err.message });
  res.status(500).json({ error: 'Internal server error' });
});

// ─── START ────────────────────────────────────────────────────
async function start(): Promise<void> {
  // Verify DB connection
  const dbOk = await db.healthCheck();
  if (!dbOk) {
    logger.error('Cannot connect to database. Exiting.');
    process.exit(1);
  }
  logger.info('Database connected');

  // Initialize bot
  initBot();

  if (config.nodeEnv === 'production') {
    const webhookUrl = `${config.appUrl}/api/telegram/webhook`;
    await setupWebhook(webhookUrl);
    logger.info('Webhook configured', { webhookUrl });
  } else {
    // Dev mode: use long polling
    bot.launch();
    logger.info('Bot started in polling mode');
  }

  // Start background job runner
  startJobRunner();

  // Start HTTP server
  const PORT = config.port;
  app.listen(PORT, '0.0.0.0', () => {
    logger.info(`🚀 RocketCash server running on port ${PORT}`);
    logger.info(`📱 Mini App: ${config.miniAppUrl}`);
    logger.info(`🤖 Bot: @RocketCashRobot`);
  });
}

start().catch(err => {
  logger.error('Startup failed', { err: err.message });
  process.exit(1);
});

// ─── GRACEFUL SHUTDOWN ────────────────────────────────────────
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received — shutting down');
  bot.stop('SIGTERM');
  await db.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  bot.stop('SIGINT');
  await db.end();
  process.exit(0);
});

export { app };
