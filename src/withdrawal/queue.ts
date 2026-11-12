import { createWalletClient, http, type WalletClient, type Address, type Hash, parseUnits, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepoliaChain } from '../watcher/rpc.js';
import { getPool, query, transaction, getAdvisoryLockKey } from '../db/pool.js';
import { settlementService } from '../settlement/index.js';
import { getConfig } from '../../config.js';
import pino from 'pino';

const logger = pino({ name: 'withdrawal-signer' });
const config = getConfig();

let hotWalletClient: WalletClient | null = null;

function getHotWalletClient(): WalletClient {
  if (!hotWalletClient) {
    const { HOT_WALLET_PRIVATE_KEY } = config;
    if (!HOT_WALLET_PRIVATE_KEY) {
      throw new Error('HOT_WALLET_PRIVATE_KEY not configured');
    }

    const account = privateKeyToAccount(HOT_WALLET_PRIVATE_KEY as `0x${string}`);
    hotWalletClient = createWalletClient({
      account,
      chain: baseSepoliaChain,
      transport: http(config.RPC_URL),
    });

    logger.info({ address: account.address }, 'Hot wallet client initialized');
  }
  return hotWalletClient;
}

/**
 * Withdrawal record from database.
 */
export interface WithdrawalRecord {
  id: string;
  user_id: string;
  destination_address: string;
  chain_id: number;
  amount_raw: string;
  amount_usdc: number;
  fee_raw: string;
  fee_usdc: number;
  status: string;
  tx_hash: string | null;
  auto_approved: boolean;
  retry_count: number;
  max_retries: number;
  last_error: string | null;
}

/**
 * Estimate gas for USDC transfer.
 */
async function estimateGas(destination: Address, amountRaw: bigint): Promise<bigint> {
  const client = getHotWalletClient();
  try {
    // USDC transfer: ~65k gas typically
    // For starter kit, return conservative estimate
    return 100000n;
  } catch {
    return 100000n;
  }
}

/**
 * Build and broadcast USDC transfer transaction.
 */
async function broadcastWithdrawal(
  destination: Address,
  amountRaw: bigint
): Promise<{ hash: Hash; gasUsed: bigint; effectiveGasPrice: bigint }> {
  const client = getHotWalletClient();

  // USDC contract ABI (minimal: transfer)
  const usdcAbi = [{
    name: 'transfer',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  }] as const;

  const gasEstimate = await estimateGas(destination, amountRaw);
  const gasPrice = await client.estimateGasPrice?.() ?? parseUnits('1', 'gwei');

  const hash = await client.writeContract({
    address: config.USDC_CONTRACT_ADDRESS as Address,
    abi: usdcAbi,
    functionName: 'transfer',
    args: [destination, amountRaw],
    gas: gasEstimate,
    gasPrice,
  });

  // Wait for receipt
  const receipt = await client.waitForTransactionReceipt({ hash });

  return {
    hash: receipt.transactionHash,
    gasUsed: receipt.gasUsed,
    effectiveGasPrice: receipt.effectiveGasPrice ?? gasPrice,
  };
}

export class WithdrawalQueue {
  private isProcessing = false;
  private processInterval: ReturnType<typeof setInterval> | null = null;
  private readonly PROCESS_INTERVAL_MS = 10000; // 10 seconds

  /**
   * Start the withdrawal processor.
   */
  start(): void {
    if (this.isProcessing) return;
    this.isProcessing = true;
    logger.info('Starting withdrawal queue processor');

    this.processInterval = setInterval(() => this.processQueue(), this.PROCESS_INTERVAL_MS);
    this.processQueue().catch(err => logger.error({ err }, 'Initial queue process failed'));
  }

  /**
   * Stop the withdrawal processor.
   */
  stop(): void {
    if (!this.isProcessing) return;
    this.isProcessing = false;
    if (this.processInterval) {
      clearInterval(this.processInterval);
      this.processInterval = null;
    }
    logger.info('Withdrawal queue processor stopped');
  }

  /**
   * Process pending withdrawals.
   */
  private async processQueue(): Promise<void> {
    if (!this.isProcessing) return;

    try {
      const pending = await query<WithdrawalRecord>(
        `SELECT * FROM withdrawals
         WHERE status IN ('QUEUED', 'VALIDATING')
         AND chain_id = $1
         ORDER BY requested_at ASC
         LIMIT 10`,
        [config.CHAIN_ID]
      );

      for (const withdrawal of pending.rows) {
        if (!this.isProcessing) break;
        await this.processWithdrawal(withdrawal);
      }
    } catch (err) {
      logger.error({ err }, 'Queue processing error');
    }
  }

  /**
   * Process a single withdrawal through its lifecycle.
   */
  private async processWithdrawal(withdrawal: WithdrawalRecord): Promise<void> {
    const lockKey = getAdvisoryLockKey('withdrawal', withdrawal.id);

    await transaction(async (client) => {
      // Lock and re-check
      const locked = await client.query(
        `SELECT status FROM withdrawals WHERE id = $1 FOR UPDATE`,
        [withdrawal.id]
      );

      if (!locked.rows[0] || !['QUEUED', 'VALIDATING'].includes(locked.rows[0].status)) {
        return; // Already processed
      }

      // Step 1: Validate
      await client.query(
        `UPDATE withdrawals SET status = 'VALIDATING', updated_at = NOW() WHERE id = $1`,
        [withdrawal.id]
      );

      const validation = await this.validateWithdrawal(withdrawal, client);
      if (!validation.valid) {
        await client.query(
          `UPDATE withdrawals SET status = 'FAILED', last_error = $1, updated_at = NOW() WHERE id = $2`,
          [validation.error, withdrawal.id]
        );
        logger.warn({ withdrawalId: withdrawal.id, error: validation.error }, 'Withdrawal validation failed');
        return;
      }

      // Step 2: Lock funds
      const lockedFunds = await settlementService.lockFundsForWithdrawal(withdrawal.user_id, withdrawal.amount_usdc);
      if (!lockedFunds) {
        await client.query(
          `UPDATE withdrawals SET status = 'FAILED', last_error = 'Insufficient available balance', updated_at = NOW() WHERE id = $1`,
          [withdrawal.id]
        );
        return;
      }

      // Step 3: Check auto-approve
      const isAutoApprove = withdrawal.amount_usdc <= config.AUTO_APPROVE_THRESHOLD_USDC && withdrawal.auto_approved;

      await client.query(
        `UPDATE withdrawals SET status = 'SIGNING', auto_approved = $1, updated_at = NOW() WHERE id = $2`,
        [isAutoApprove, withdrawal.id]
      );

      if (!isAutoApprove) {
        // Manual approval required — leave in SIGNING status
        logger.info({ withdrawalId: withdrawal.id, amountUsdc: withdrawal.amount_usdc }, 'Withdrawal requires manual approval');
        return;
      }

      // Step 4: Broadcast
      await client.query(
        `UPDATE withdrawals SET status = 'BROADCASTING', updated_at = NOW() WHERE id = $1`,
        [withdrawal.id]
      );

      try {
        const { hash, gasUsed, effectiveGasPrice } = await broadcastWithdrawal(
          withdrawal.destination_address as Address,
          BigInt(withdrawal.amount_raw)
        );

        await client.query(
          `UPDATE withdrawals
           SET status = 'CONFIRMED', tx_hash = $1, gas_used = $2, effective_gas_price = $3, updated_at = NOW()
           WHERE id = $4`,
          [hash, gasUsed.toString(), effectiveGasPrice.toString(), withdrawal.id]
        );

        logger.info({ withdrawalId: withdrawal.id, txHash: hash }, 'Withdrawal broadcast');

        // Step 5: Wait for confirmation (simplified — in production use event listener)
        // For starter kit, mark as COMPLETED after broadcast
        // Real implementation would poll for receipt
        await this.finalizeWithdrawal(withdrawal.id, hash);

      } catch (err: any) {
        logger.error({ err, withdrawalId: withdrawal.id }, 'Withdrawal broadcast failed');

        // Release locked funds
        await settlementService.releaseLockedFunds(withdrawal.user_id, withdrawal.amount_usdc);

        const retryCount = withdrawal.retry_count + 1;
        if (retryCount >= withdrawal.max_retries) {
          await client.query(
            `UPDATE withdrawals SET status = 'FAILED', last_error = $1, retry_count = $2, updated_at = NOW() WHERE id = $3`,
            [err.message, retryCount, withdrawal.id]
          );
        } else {
          await client.query(
            `UPDATE withdrawals SET status = 'QUEUED', retry_count = $1, last_error = $2, updated_at = NOW() WHERE id = $3`,
            [retryCount, err.message, withdrawal.id]
          );
        }
      }
    });
  }

  /**
   * Validate withdrawal: balance, limits, cooldown, address format.
   */
  private async validateWithdrawal(
    withdrawal: WithdrawalRecord,
    client: any
  ): Promise<{ valid: boolean; error?: string }> {
    // Check destination address format
    if (!/^0x[a-fA-F0-9]{40}$/.test(withdrawal.destination_address)) {
      return { valid: false, error: 'Invalid destination address format' };
    }

    // Check amount limits
    if (withdrawal.amount_usdc <= 0) {
      return { valid: false, error: 'Amount must be positive' };
    }
    if (withdrawal.amount_usdc > config.MAX_WITHDRAWAL_USDC) {
      return { valid: false, error: `Amount exceeds maximum of ${config.MAX_WITHDRAWAL_USDC} USDC` };
    }

    // Check user balance
    const balances = await settlementService.getUserBalances(withdrawal.user_id);
    if (balances.availableUsdc < withdrawal.amount_usdc) {
      return { valid: false, error: 'Insufficient available balance' };
    }

    // Check cooldown (last withdrawal time)
    const lastWithdrawal = await client.query(
      `SELECT confirmed_at FROM withdrawals
       WHERE user_id = $1 AND status IN ('CONFIRMED', 'COMPLETED')
       ORDER BY confirmed_at DESC LIMIT 1`,
      [withdrawal.user_id]
    );

    if (lastWithdrawal.rows.length > 0 && lastWithdrawal.rows[0].confirmed_at) {
      const elapsed = Date.now() - new Date(lastWithdrawal.rows[0].confirmed_at).getTime();
      if (elapsed < config.WITHDRAWAL_COOLDOWN_MS) {
        return { valid: false, error: 'Withdrawal cooldown not elapsed' };
      }
    }

    // Check daily limit (simplified)
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const dailyTotal = await client.query(
      `SELECT COALESCE(SUM(amount_usdc), 0) as total FROM withdrawals
       WHERE user_id = $1 AND status IN ('CONFIRMED', 'COMPLETED')
       AND confirmed_at >= $2`,
      [withdrawal.user_id, todayStart]
    );

    const dailyLimit = config.MAX_WITHDRAWAL_USDC * 5; // 5x max per day
    if (Number(dailyTotal.rows[0].total) + withdrawal.amount_usdc > dailyLimit) {
      return { valid: false, error: 'Daily withdrawal limit exceeded' };
    }

    return { valid: true };
  }

  /**
   * Finalize withdrawal after on-chain confirmation.
   */
  private async finalizeWithdrawal(withdrawalId: string, txHash: string): Promise<void> {
    await transaction(async (client) => {
      const withdrawal = await client.query(
        `SELECT * FROM withdrawals WHERE id = $1 FOR UPDATE`,
        [withdrawalId]
      );

      if (!withdrawal.rows[0]) return;

      const w = withdrawal.rows[0];

      // Finalize: remove from locked balance
      await settlementService.finalizeWithdrawal(w.user_id, w.amount_usdc);

      await client.query(
        `UPDATE withdrawals SET status = 'COMPLETED', completed_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [withdrawalId]
      );

      logger.info({ withdrawalId, txHash }, 'Withdrawal completed');
    });
  }
}

export const withdrawalQueue = new WithdrawalQueue();