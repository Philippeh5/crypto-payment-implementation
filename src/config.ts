import { z } from 'zod';

/**
 * Validated environment configuration schema.
 * All runtime config flows through this — no raw process.env access elsewhere.
 */

const EnvSchema = z.object({
  // Chain & RPC
  RPC_URL: z.string().url(),
  RPC_FALLBACK_URLS: z.string().optional().transform(s => s?.split(',').map(u => u.trim()).filter(Boolean) ?? []),
  CHAIN_ID: z.coerce.number().int().positive(),

  // Token
  USDC_CONTRACT_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  USDC_DECIMALS: z.coerce.number().int().min(0).max(18).default(6),

  // Wallet
  MASTER_XPUB: z.string().min(10).optional(),
  HOT_WALLET_PRIVATE_KEY: z.string().regex(/^0x[a-fA-F0-9]{64}$/).optional(),

  // Settlement & Risk
  REQUIRED_CONFIRMATIONS: z.coerce.number().int().min(1).max(100).default(5),
  REORG_CHECK_DEPTH: z.coerce.number().int().min(1).max(500).default(10),
  AUTO_APPROVE_THRESHOLD_USDC: z.coerce.number().int().min(0).default(500),
  MAX_WITHDRAWAL_USDC: z.coerce.number().int().min(1).default(10000),
  WITHDRAWAL_COOLDOWN_MS: z.coerce.number().int().min(0).default(30000),

  // Database
  DATABASE_URL: z.string().url(),

  // App
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

export type Config = z.infer<typeof EnvSchema>;

let cachedConfig: Config | null = null;

export function getConfig(): Config {
  if (cachedConfig) return cachedConfig;

  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('❌ Invalid configuration:');
    console.error(parsed.error.flatten().fieldErrors);
    process.exit(1);
  }

  cachedConfig = parsed.data;
  return cachedConfig;
}

export function resetConfigCache(): void {
  cachedConfig = null;
}