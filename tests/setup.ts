// Test environment setup
process.env.NODE_ENV = 'test';
process.env.TELEGRAM_BOT_TOKEN = 'test_token:ABCDEF1234567890';
process.env.SUPER_ADMIN_CHAT_ID = '8004114088';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/rocketcash_test';
process.env.SESSION_SECRET = 'test_session_secret_at_least_32_characters_long';
process.env.JWT_SECRET = 'test_jwt_secret_at_least_32_characters_long_here';
process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.APP_URL = 'http://localhost:3000';
process.env.MINI_APP_URL = 'http://localhost:3000/miniapp';

// Silence logger during tests
jest.mock('../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));
