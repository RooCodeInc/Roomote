// The test command has already loaded .env.test. Avoid re-reading and
// decrypting env files whenever server tests rehydrate runtime configuration.
vi.mock('@dotenvx/dotenvx', () => ({
  config: vi.fn(() => ({ parsed: {} })),
  get: vi.fn((key: string) => process.env[key]),
}));

// Mock Redis before any imports that might use it.
vi.mock('@roomote/redis', async () => {
  const actual = await vi.importActual('@roomote/redis');
  return {
    ...actual,
    getRedis: vi.fn(() => ({
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue('OK'),
      setex: vi.fn().mockResolvedValue('OK'),
      del: vi.fn().mockResolvedValue(1),
      quit: vi.fn().mockResolvedValue('OK'),
      disconnect: vi.fn().mockResolvedValue(undefined),
    })),
  };
});
