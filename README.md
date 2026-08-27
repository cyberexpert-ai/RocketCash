# 🚀 RocketCash — Telegram Reward Platform

A complete production-ready Telegram Mini App reward platform with:
- Telegram Mini App for users
- Command-based Admin Panel via Telegram Bot
- BitLabs survey integration
- RazorpayX automatic payouts
- Bank & UPI withdrawals
- Spin wheel, referral system, fraud detection

---

## 📋 Prerequisites

- Node.js 20+
- PostgreSQL 16+
- Telegram Bot Token (from [@BotFather](https://t.me/BotFather))
- (Optional) BitLabs account
- (Optional) RazorpayX account

---

## ⚡ Quick Start

```bash
# 1. Clone & install
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your values

# 3. Run database migrations
npm run migrate

# 4. Start development server
npm run dev
```

---

## 🌐 Render Deployment (Production)

### Step 1 — PostgreSQL Database
1. Go to [Render Dashboard](https://dashboard.render.com)
2. New → **PostgreSQL**
3. Name: `rocketcash-db`
4. Region: Singapore (or nearest)
5. Plan: Starter
6. Create Database → copy **Internal Database URL**

### Step 2 — Web Service
1. New → **Web Service**
2. Connect your GitHub repository
3. Settings:
   - Name: `rocketcash`
   - Runtime: **Node**
   - Build Command: `npm install && npm run build && npm run migrate`
   - Start Command: `npm start`
   - Region: Singapore

### Step 3 — Environment Variables
Set these in Render → Environment:

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `TELEGRAM_BOT_TOKEN` | Your bot token |
| `SUPER_ADMIN_CHAT_ID` | `8004114088` |
| `DATABASE_URL` | From Render PostgreSQL |
| `APP_URL` | `https://your-app.onrender.com` |
| `MINI_APP_URL` | `https://your-app.onrender.com/miniapp` |
| `SESSION_SECRET` | Generate 64-char random string |
| `JWT_SECRET` | Generate 64-char random string |
| `ENCRYPTION_KEY` | Generate 64-char hex string |
| `TELEGRAM_WEBHOOK_SECRET` | Generate 32-char random string |

Generate random strings:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Step 4 — Telegram Bot Setup
1. Send `/setmenubutton` to [@BotFather](https://t.me/BotFather)
2. Select your bot
3. Set menu button URL: `https://your-app.onrender.com/miniapp`
4. Send `/setdomain` to BotFather → set your Render domain

### Step 5 — Register Webhook
After deploying, the webhook is auto-set on startup. Verify at:
```
https://api.telegram.org/bot<TOKEN>/getWebhookInfo
```

---

## 🔧 Configuration via Admin Panel

All provider credentials are configured through the Telegram Admin Panel — **never edit code or env files for provider settings**.

### Access Admin Panel
1. Open [@RocketCashRobot](https://t.me/RocketCashRobot)
2. Send `/Superadmin`
3. Telegram Chat ID `8004114088` has SUPER_ADMIN access

### Configure RazorpayX
```
/Superadmin → 🔌 API / Providers → 💳 RazorpayX → ⚙️ Configure
```
Enter: Key ID → Key Secret → Webhook Secret → Environment

### Configure BitLabs
```
/Superadmin → 🔌 API / Providers → 🎯 BitLabs → ⚙️ Configure
```
Enter: API Token → App ID → Callback Secret

### Set Spin Settings
```
/Superadmin → 🎡 Spin → ⚙️ Edit Settings
```

### Manage Withdrawals
```
/Superadmin → 💰 Withdrawals → ⚙️ Withdrawal Settings
```

---

## 🏗 Architecture

```
USER EXPERIENCE:
  Telegram → /start → 🎁 OPEN REWARD APP → Mini App (all features)

ADMIN EXPERIENCE:
  Telegram → /Superadmin → Command-Based Admin Panel (all features)
```

### Key Security Properties
- **User Isolation**: Every API uses server-validated session — never frontend user IDs
- **IDOR Protection**: All resource queries include authenticated `user_id`
- **Wallet Integrity**: Immutable ledger — all balance changes create ledger entries
- **Money**: Integer paise only — no floating point
- **Idempotency**: BitLabs callbacks and RazorpayX payouts are idempotent
- **Encryption**: Provider secrets encrypted at rest with AES-256-GCM

---

## 📂 Project Structure

```
rocketcash/
├── src/
│   ├── app.ts                    # Express + Bot entry point
│   ├── config.ts                 # Environment config
│   ├── bot/
│   │   ├── index.ts              # Telegraf bot setup
│   │   ├── commands/
│   │   │   ├── start.ts          # /start → Mini App
│   │   │   └── superadmin.ts     # /Superadmin → Admin Panel
│   │   └── admin/
│   │       ├── index.ts          # Admin panel router
│   │       ├── dashboard.ts      # Stats dashboard
│   │       ├── users.ts          # User management
│   │       ├── spin.ts           # Spin configuration
│   │       ├── providers.ts      # API/provider config
│   │       └── combined.ts       # Other admin handlers
│   ├── api/
│   │   ├── routes/
│   │   │   ├── auth.ts           # POST /api/auth/telegram
│   │   │   ├── user.ts           # GET /api/me, /api/config
│   │   │   ├── tasks.ts          # Spin, Tasks, Wallet, History, Referral
│   │   │   ├── withdrawals.ts    # Withdrawal CRUD
│   │   │   ├── webhooks.ts       # BitLabs + RazorpayX webhooks
│   │   │   └── ifsc.ts           # IFSC search + Health
│   │   └── middleware/
│   │       ├── auth.ts           # Session validation middleware
│   │       └── rateLimit.ts      # Rate limiters
│   ├── services/
│   │   ├── auth.ts               # initData validation, sessions
│   │   ├── wallet.ts             # Immutable ledger operations
│   │   ├── spin.ts               # Spin logic (backend-only reward)
│   │   ├── withdrawal.ts         # Withdrawal creation/reversal
│   │   ├── referral.ts           # Referral tracking & rewards
│   │   ├── fraud.ts              # Device signals, risk assessment
│   │   ├── notification.ts       # Telegram user notifications
│   │   ├── broadcast.ts          # Bot & channel broadcasts
│   │   ├── settings.ts           # Admin settings with cache
│   │   └── jobs.ts               # PostgreSQL-backed job runner
│   ├── providers/
│   │   ├── bitlabs.ts            # BitLabs task/survey integration
│   │   ├── razorpayx.ts          # RazorpayX payout integration
│   │   └── ifsc.ts               # IFSC validation
│   ├── db/
│   │   ├── index.ts              # PostgreSQL pool
│   │   └── migrate.ts            # Migration runner
│   └── utils/
│       ├── logger.ts             # Winston logger
│       ├── crypto.ts             # AES-256 encryption, HMAC
│       └── money.ts              # Paise/rupee utilities
├── miniapp/
│   ├── index.html                # Telegram Mini App shell
│   ├── css/styles.css            # Complete mobile UI
│   └── js/app.js                 # Mini App logic
├── migrations/
│   └── 001_initial.sql           # Complete DB schema
├── tests/
│   ├── isolation.test.ts         # User isolation, IDOR, admin auth
│   └── security.test.ts          # Webhooks, withdrawals, crypto
├── .env.example
├── render.yaml
├── package.json
├── tsconfig.json
└── README.md
```

---

## 🧪 Running Tests

```bash
npm test

# With coverage
npm run test:coverage
```

---

## 🔌 Webhook Endpoints

| Endpoint | Description |
|---|---|
| `POST /api/telegram/webhook` | Telegram Bot updates |
| `POST /api/webhooks/bitlabs` | BitLabs task completion callbacks |
| `POST /api/webhooks/razorpayx` | RazorpayX payout status updates |

### BitLabs Webhook Setup
In your BitLabs dashboard, set the callback URL to:
```
https://your-app.onrender.com/api/webhooks/bitlabs
```

### RazorpayX Webhook Setup
In RazorpayX dashboard → Webhooks → Add webhook URL:
```
https://your-app.onrender.com/api/webhooks/razorpayx
```
Events: `payout.processed`, `payout.reversed`, `payout.failed`

---

## 💰 Money Handling

All monetary values use **integer paise** (1 INR = 100 paise):
- `₹1.00` = `100 paise`
- `₹100.00` = `10000 paise`
- No floating point anywhere

---

## 👮 Admin Roles

| Role | Permissions |
|---|---|
| `SUPER_ADMIN` | All permissions including managing other admins |
| `ADMIN` | Most permissions except critical financial settings |
| `FINANCE` | Withdrawal and payout management |
| `SUPPORT` | View users, manage tickets |
| `ANALYST` | Dashboard and reports only |

---

## 🛡 Fraud & Risk System

Risk levels: `CLEAN` → `LOW_RISK` → `MEDIUM_RISK` → `HIGH_RISK` → `BLOCKED`

Detection signals:
- Multiple accounts on same device (IP + UA + timezone fingerprint)
- Self-referral attempts
- Rapid registration patterns
- Suspicious withdrawal patterns
- Payment destination reuse

---

## 📊 Database Schema

45+ tables including:
- `users`, `sessions`, `wallet_accounts`, `wallet_transactions`
- `spin_configs`, `spin_results`, `daily_spin_usage`
- `withdrawals`, `bank_accounts`, `upi_accounts`
- `payout_transactions`, `payout_webhooks`
- `referrals`, `provider_callbacks`
- `broadcasts`, `broadcast_recipients`
- `admin_users`, `audit_logs`
- `device_risk_groups`, `fraud_flags`
- `scheduled_jobs`, `encrypted_secrets`

---

## 🔄 Background Jobs

PostgreSQL-backed job runner (no separate worker needed):
- `PROCESS_PAYOUT` — Triggers RazorpayX payout
- `SEND_NOTIFICATION` — Telegram notifications
- Safe locking prevents duplicate execution
- Auto-retry with exponential backoff

---

## 📞 Support

Configured via Admin Panel → Settings → Support Username

---

## ⚠️ Important Notes

1. **Never commit `.env`** — contains secrets
2. **ENCRYPTION_KEY** must be exactly 64 hex chars (32 bytes)
3. **Super Admin Chat ID** is hardcoded to `8004114088` — only this Telegram account can access the admin panel
4. **RazorpayX account number** must be set in provider config after connecting
5. All provider credentials are stored **encrypted** in the database
6. Test with RazorpayX **test environment** before going live

---

## 📄 License

Proprietary — All rights reserved.
