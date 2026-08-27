import { Context } from 'telegraf';
import { db } from '../../db';
import { encrypt } from '../../utils/crypto';
import { testConnection as testRazorpayX } from '../../providers/razorpayx';
import { testBitLabsConnection } from '../../providers/bitlabs';
import { getAdminState, setAdminState, clearAdminState } from './index';
import { logger } from '../../utils/logger';

export async function handleProvidersMenu(ctx: Context, admin: any): Promise<void> {
  const msg = `🔌 <b>API / Providers</b>\n\nSelect a provider to configure:`;
  await (ctx.editMessageText || ctx.reply).call(ctx, msg, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '💳 RazorpayX', callback_data: 'admin:provider_action:razorpayx_menu' }],
        [{ text: '🎯 BitLabs', callback_data: 'admin:provider_action:bitlabs_menu' }],
        [{ text: '🏦 IFSC', callback_data: 'admin:provider_action:ifsc_menu' }],
        [{ text: '◀️ Menu', callback_data: 'admin:menu' }],
      ],
    },
  }).catch(async () => ctx.reply(msg, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [[{ text: '💳 RazorpayX', callback_data: 'admin:provider_action:razorpayx_menu' }],[{ text: '◀️ Back', callback_data: 'admin:providers' }]] }
  }));
}

export async function handleProviderAction(ctx: Context, admin: any, subAction: string, text?: string): Promise<void> {
  const telegramId = ctx.from!.id;
  const state = getAdminState(telegramId);

  // Handle text input for provider configuration
  if (text && state.state.startsWith('PROVIDER_INPUT_')) {
    await handleProviderTextInput(ctx, admin, state, text);
    return;
  }

  switch (subAction) {
    case 'razorpayx_menu': await showRazorpayXMenu(ctx, admin); break;
    case 'razorpayx_configure': await startRazorpayXConfig(ctx, admin); break;
    case 'razorpayx_test': await testRazorpayXConnection(ctx, admin); break;
    case 'bitlabs_menu': await showBitLabsMenu(ctx, admin); break;
    case 'bitlabs_configure': await startBitLabsConfig(ctx, admin); break;
    case 'bitlabs_test': await testBitLabsConn(ctx, admin); break;
    case 'ifsc_menu': await showIFSCMenu(ctx, admin); break;
    case 'ifsc_configure': await startIFSCConfig(ctx, admin); break;
    default: break;
  }
}

async function showRazorpayXMenu(ctx: Context, admin: any): Promise<void> {
  // Get current config (masked)
  const { rows } = await db.query(
    `SELECT pc.environment, pc.is_active,
            (SELECT CASE WHEN encrypted_value IS NOT NULL THEN 'rzp_' || repeat('*', 12) ELSE 'Not set' END
             FROM encrypted_secrets WHERE provider_name='razorpayx' AND key_name='key_id') as key_id_masked
     FROM provider_configs pc WHERE pc.provider_name='razorpayx'`
  );

  const config = rows[0];
  const status = config?.is_active ? '🟢 Active' : '🔴 Inactive';

  const msg =
    `💳 <b>RazorpayX Configuration</b>\n\n` +
    `Status: ${status}\n` +
    `Environment: <code>${config?.environment || 'test'}</code>\n` +
    `Key ID: <code>${config?.key_id_masked || 'Not set'}</code>\n` +
    `Secret: <code>••••••••••••</code>`;

  const keyboard = [
    [{ text: '⚙️ Configure', callback_data: 'admin:provider_action:razorpayx_configure' }],
    [{ text: '🧪 Test Connection', callback_data: 'admin:provider_action:razorpayx_test' }],
    [{ text: '◀️ Back', callback_data: 'admin:providers' }],
  ];

  await ctx.reply(msg, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
}

async function startRazorpayXConfig(ctx: Context, admin: any): Promise<void> {
  setAdminState(ctx.from!.id, 'PROVIDER_INPUT_RAZORPAYX_KEY_ID', { provider: 'razorpayx', step: 'key_id' });
  await ctx.reply(
    `💳 <b>RazorpayX Configuration</b>\n\nStep 1/4 — Enter your <b>Key ID</b>:\n(starts with rzp_live_ or rzp_test_)`,
    { parse_mode: 'HTML', reply_markup: { force_reply: true } }
  );
}

async function handleProviderTextInput(ctx: Context, admin: any, state: any, text: string): Promise<void> {
  const { provider, step, data } = state.data;
  const telegramId = ctx.from!.id;

  if (provider === 'razorpayx') {
    switch (step) {
      case 'key_id':
        setAdminState(telegramId, 'PROVIDER_INPUT_RAZORPAYX_SECRET', { provider, step: 'secret', data: { key_id: text } });
        await ctx.reply(`Step 2/4 — Enter your <b>Key Secret</b>:`, { parse_mode: 'HTML' });
        break;
      case 'secret':
        setAdminState(telegramId, 'PROVIDER_INPUT_RAZORPAYX_WEBHOOK', { provider, step: 'webhook_secret', data: { ...state.data?.data, key_secret: text } });
        await ctx.reply(`Step 3/4 — Enter your <b>Webhook Secret</b>:`, { parse_mode: 'HTML' });
        break;
      case 'webhook_secret':
        setAdminState(telegramId, 'PROVIDER_INPUT_RAZORPAYX_ENV', { provider, step: 'environment', data: { ...state.data?.data, webhook_secret: text } });
        await ctx.reply(`Step 4/4 — Enter environment:\n<code>test</code> or <code>production</code>`, {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[
            { text: '🧪 Test', callback_data: 'admin:provider_action:razorpayx_env_test' },
            { text: '🚀 Production', callback_data: 'admin:provider_action:razorpayx_env_prod' },
          ]] }
        });
        break;
      case 'environment': {
        const inputData = state.data?.data || {};
        const env = text.toLowerCase() === 'production' ? 'production' : 'test';
        await saveRazorpayXCredentials(inputData.key_id, inputData.key_secret, inputData.webhook_secret, env, admin.id.toString());
        clearAdminState(telegramId);
        await ctx.reply(
          `✅ <b>RazorpayX credentials saved!</b>\n\nKey ID: <code>rzp_${repeat('*', 12)}</code>\nSecret: <code>••••••••••••</code>\nEnvironment: <code>${env}</code>`,
          {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [
              [{ text: '🧪 Test Connection', callback_data: 'admin:provider_action:razorpayx_test' }],
              [{ text: '◀️ Back', callback_data: 'admin:providers' }],
            ] }
          }
        );
        break;
      }
    }
  } else if (provider === 'bitlabs') {
    switch (step) {
      case 'api_token':
        setAdminState(telegramId, 'PROVIDER_INPUT_BITLABS_APP_ID', { provider, step: 'app_id', data: { api_token: text } });
        await ctx.reply(`Step 2/3 — Enter your <b>App ID</b>:`, { parse_mode: 'HTML' });
        break;
      case 'app_id':
        setAdminState(telegramId, 'PROVIDER_INPUT_BITLABS_CALLBACK', { provider, step: 'callback_secret', data: { ...state.data?.data, app_id: text } });
        await ctx.reply(`Step 3/3 — Enter your <b>Callback Secret</b>:`, { parse_mode: 'HTML' });
        break;
      case 'callback_secret': {
        const inputData = state.data?.data || {};
        await saveBitLabsCredentials(inputData.api_token, inputData.app_id, text, admin.id.toString());
        clearAdminState(telegramId);
        await ctx.reply(`✅ <b>BitLabs credentials saved!</b>`, {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [
            [{ text: '🧪 Test Connection', callback_data: 'admin:provider_action:bitlabs_test' }],
            [{ text: '◀️ Back', callback_data: 'admin:providers' }],
          ] }
        });
        break;
      }
    }
  }
}

async function saveRazorpayXCredentials(keyId: string, keySecret: string, webhookSecret: string, environment: string, adminId: string): Promise<void> {
  const secretPairs = [
    { key: 'key_id', value: keyId },
    { key: 'key_secret', value: keySecret },
    { key: 'webhook_secret', value: webhookSecret },
  ];

  for (const { key, value } of secretPairs) {
    const encrypted = encrypt(value);
    await db.query(
      `INSERT INTO encrypted_secrets (provider_name, key_name, encrypted_value, updated_by)
       VALUES ('razorpayx', $1, $2, $3)
       ON CONFLICT (provider_name, key_name) DO UPDATE SET encrypted_value=$2, updated_by=$3, updated_at=NOW()`,
      [key, encrypted, adminId]
    );
  }

  await db.query(
    `INSERT INTO provider_configs (provider_name, environment, is_active)
     VALUES ('razorpayx', $1, TRUE)
     ON CONFLICT (provider_name) DO UPDATE SET environment=$1, is_active=TRUE, updated_by=$2, updated_at=NOW()`,
    [environment, adminId]
  );

  await db.query(
    `INSERT INTO audit_logs (admin_id, action, target_type) VALUES ($1, 'CONFIGURE_RAZORPAYX', 'provider')`,
    [adminId]
  );
}

async function saveBitLabsCredentials(apiToken: string, appId: string, callbackSecret: string, adminId: string): Promise<void> {
  const secretPairs = [
    { key: 'api_token', value: apiToken },
    { key: 'app_id', value: appId },
    { key: 'callback_secret', value: callbackSecret },
  ];

  for (const { key, value } of secretPairs) {
    await db.query(
      `INSERT INTO encrypted_secrets (provider_name, key_name, encrypted_value, updated_by)
       VALUES ('bitlabs', $1, $2, $3)
       ON CONFLICT (provider_name, key_name) DO UPDATE SET encrypted_value=$2, updated_by=$3, updated_at=NOW()`,
      [key, encrypt(value), adminId]
    );
  }

  await db.query(
    `INSERT INTO provider_configs (provider_name, environment, is_active)
     VALUES ('bitlabs', 'production', TRUE)
     ON CONFLICT (provider_name) DO UPDATE SET is_active=TRUE, updated_by=$1, updated_at=NOW()`,
    [adminId]
  );

  await db.query(
    `INSERT INTO audit_logs (admin_id, action, target_type) VALUES ($1, 'CONFIGURE_BITLABS', 'provider')`,
    [adminId]
  );
}

async function testRazorpayXConnection(ctx: Context, admin: any): Promise<void> {
  await ctx.reply('🧪 Testing RazorpayX connection...');
  const result = await testRazorpayX();
  await ctx.reply(
    result.connected
      ? `✅ <b>RazorpayX CONNECTED</b>\n${result.message}`
      : `❌ <b>RazorpayX FAILED</b>\n${result.message}`,
    { parse_mode: 'HTML' }
  );
}

async function showBitLabsMenu(ctx: Context, admin: any): Promise<void> {
  const { rows } = await db.query(`SELECT is_active FROM provider_configs WHERE provider_name='bitlabs'`);
  const status = rows[0]?.is_active ? '🟢 Active' : '🔴 Inactive';
  await ctx.reply(
    `🎯 <b>BitLabs Configuration</b>\n\nStatus: ${status}`,
    {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [
        [{ text: '⚙️ Configure', callback_data: 'admin:provider_action:bitlabs_configure' }],
        [{ text: '🧪 Test Connection', callback_data: 'admin:provider_action:bitlabs_test' }],
        [{ text: '◀️ Back', callback_data: 'admin:providers' }],
      ] }
    }
  );
}

async function startBitLabsConfig(ctx: Context, admin: any): Promise<void> {
  setAdminState(ctx.from!.id, 'PROVIDER_INPUT_BITLABS_TOKEN', { provider: 'bitlabs', step: 'api_token' });
  await ctx.reply(`🎯 <b>BitLabs Configuration</b>\n\nStep 1/3 — Enter your <b>API Token</b>:`, { parse_mode: 'HTML' });
}

async function testBitLabsConn(ctx: Context, admin: any): Promise<void> {
  await ctx.reply('🧪 Testing BitLabs connection...');
  const result = await testBitLabsConnection();
  await ctx.reply(
    result.connected ? `✅ <b>BitLabs CONNECTED</b>\n${result.message}` : `❌ <b>BitLabs FAILED</b>\n${result.message}`,
    { parse_mode: 'HTML' }
  );
}

async function showIFSCMenu(ctx: Context, admin: any): Promise<void> {
  const { rows } = await db.query(`SELECT config FROM provider_configs WHERE provider_name='ifsc'`);
  const providerUrl = rows[0]?.config?.provider_url || 'https://ifsc.razorpay.com';
  await ctx.reply(
    `🏦 <b>IFSC Provider</b>\n\nProvider URL: <code>${providerUrl}</code>`,
    {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [
        [{ text: '⚙️ Configure', callback_data: 'admin:provider_action:ifsc_configure' }],
        [{ text: '◀️ Back', callback_data: 'admin:providers' }],
      ] }
    }
  );
}

async function startIFSCConfig(ctx: Context, admin: any): Promise<void> {
  setAdminState(ctx.from!.id, 'PROVIDER_INPUT_IFSC_URL', { provider: 'ifsc', step: 'url' });
  await ctx.reply(`🏦 <b>IFSC Configuration</b>\n\nEnter provider URL (e.g. https://ifsc.razorpay.com):`, { parse_mode: 'HTML' });
}

function repeat(char: string, n: number): string {
  return char.repeat(n);
}
