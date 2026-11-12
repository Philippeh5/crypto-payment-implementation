import { getPool, query, transaction, getAdvisoryLockKey } from '../db/pool.js';
import { walletService } from '../wallet/index.js';
import { getRpcClient } from './rpc.js';
import { parseTransferLog, isRelevantTransfer } from './parser.js';
import { verifyBlockCanonical, storeProcessedBlock, detectReorgDepth, handleReorg } from './reorg.js';
import { getConfig } from '../../config.js';
import pino from 'pino';

const logger = pino({ name: 'watcher-service' });
const config = getConfig();

export interface WatcherStats {
  isRunning: boolean;
  lastPolledBlock: bigint;
  currentBlock: bigint;
  depositsFound: number;
  depositsCredited: number;
  reorgsDetected: number;
  errors: number;
  uptimeMs: number;
}

export class WatcherService {
  private isRunning = false;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private reorgCheckInterval: ReturnType<typeof setInterval> | null = null;
  private startTime = Date.now();

  private stats: WatcherStats = {
    isRunning: false,
    lastPolledBlock: 0n,
    currentBlock: 0n,
    depositsFound: 0,
    depositsCredited: 0,
    reorgsDetected: 0,
    errors: 0,
    uptimeMs: 0,
  };

  private readonly POLL_INTERVAL_MS = 5000; // 5 seconds
  private readonly REORG_CHECK_INTERVAL_MS = 30000; // 30 seconds

  /**
   * Start the watcher loop.
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Watcher already running');
      return;
    }

    this.isRunning = true;
    this.startTime = Date.now();
    logger.info('Starting deposit watcher...');

    // Initialize last polled block from DB
    await this.initializeLastPolledBlock();

    // Start polling loop
    this.pollInterval = setInterval(() => this.pollLoop(), this.POLL_INTERVAL_MS);
    // Run once immediately
    this.pollLoop().catch(err => logger.error({ err }, 'Initial poll failed'));

    // Start reorg detection
    this.reorgCheckInterval = setInterval(() => this.reorgCheckLoop(), this.REORG_CHECK_INTERVAL_MS);

    logger.info('Watcher started');
  }

  /**
   * Stop the watcher.
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return;

    this.isRunning = false;

    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    if (this.reorgCheckInterval) {
      clearInterval(this.reorgCheckInterval);
      this.reorgCheckInterval = null;
    }

    logger.info('Watcher stopped');
  }

  /**
   * Get current stats.
   */
  getStats(): WatcherStats {
    return {
      ...this.stats,
      uptimeMs: Date.now() - this.startTime,
    };
  }

  private async initializeLastPolledBlock(): Promise<void> {
    // Get the highest block we've processed
    const result = await query<{ max_block: bigint }>(
      `SELECT COALESCE(MAX(block_number), 0) as max_block FROM processed_blocks WHERE chain_id = $1`,
      [config.CHAIN_ID]
    );

    this.stats.lastPolledBlock = result.rows[0]?.max_block ?? 0n;
    logger.info({ lastPolledBlock: this.stats.lastPolledBlock.toString() }, 'Initialized last polled block');
  }

  private async pollLoop(): Promise<void> {
    if (!this.isRunning) return;

    try {
      const client = getRpcClient();
      const currentBlock = await client.getBlock({ blockTag: 'latest' });
      const currentBlockNumber = currentBlock.number;

      this.stats.currentBlock = currentBlockNumber;

      // Don't process if we're already caught up
      if (currentBlockNumber <= this.stats.lastPolledBlock) {
        return;
      }

      // Process blocks in batches
      const fromBlock = this.stats.lastPolledBlock + 1n;
      const toBlock = currentBlockNumber;

      logger.debug({ fromBlock: fromBlock.toString(), toBlock: toBlock.toString() }, 'Polling blocks');

      await this.processBlockRange(fromBlock, toBlock);

      this.stats.lastPolledBlock = toBlock;
    } catch (err) {
      this.stats.errors++;
      logger.error({ err }, 'Poll loop error');
    }
  }

  private async processBlockRange(fromBlock: bigint, toBlock: bigint): Promise<void> {
    const client = getRpcClient();

    for (let blockNum = fromBlock; blockNum <= toBlock; blockNum++) {
      if (!this.isRunning) break;

      try {
        // Get block with full transactions
        const block = await client.getBlock({
          blockNumber: blockNum,
          includeTransactions: true,
        });

        if (!block.transactions) continue;

        // Store block for reorg checks
        await storeProcessedBlock(
          config.CHAIN_ID,
          block.number,
          block.hash,
          block.parentHash,
          Number(block.timestamp)
        );

        // Process each transaction's logs
        for (const tx of block.transactions) {
          // Get transaction receipt for logs
          const receipt = await client.getTransactionReceipt({ hash: tx.hash });

          for (const log of receipt.logs) {
            if (!isRelevantTransfer(log)) continue;

            const depositEvent = parseTransferLog(log, Number(block.timestamp));
            if (!depositEvent) continue;

            await this.handleDepositEvent(depositEvent, block.number, block.hash);
          }
        }
      } catch (err) {
        logger.error({ err, blockNum: blockNum.toString() }, 'Error processing block');
        this.stats.errors++;
      }
    }
  }

  private async handleDepositEvent(
    event: {
      txHash: string;
      logIndex: number;
      blockNumber: bigint;
      blockHash: string;
      fromAddress: string;
      toAddress: string;
      amountRaw: bigint;
      amountUsdc: number;
    },
    blockNumber: bigint,
    blockHash: string
  ): Promise<void> {
    // Check if deposit address exists in our system
    const depositAddress = await walletService.validateDepositAddress(event.toAddress, config.CHAIN_ID);
    if (!depositAddress) {
      // Not our address — ignore
      return;
    }

    // Check if already processed (idempotency)
    const existing = await query(
      `SELECT id FROM deposits WHERE tx_hash = $1 AND log_index = $2`,
      [event.txHash, event.logIndex]
    );

    if (existing.rows.length > 0) {
      logger.debug({ txHash: event.txHash, logIndex: event.logIndex }, 'Deposit already processed');
      return;
    }

    // Insert as PENDING
    const lockKey = getAdvisoryLockKey('deposit', depositAddress.user_id);
    await transaction(async (client) => {
      // Re-check inside transaction
      const check = await client.query(
        `SELECT id FROM deposits WHERE tx_hash = $1 AND log_index = $2`,
        [event.txHash, event.logIndex]
      );
      if (check.rows.length > 0) return;

      await client.query(
        `INSERT INTO deposits (
          deposit_address_id, user_id, tx_hash, log_index, block_number, block_hash,
          amount_raw, amount_usdc, status, required_confirmations, reorg_check_depth
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PENDING', $9, $10)`,
        [
          depositAddress.id,
          depositAddress.user_id,
          event.txHash,
          event.logIndex,
          blockNumber,
          blockHash,
          event.amountRaw.toString(),
          event.amountUsdc,
          config.REQUIRED_CONFIRMATIONS,
          config.REORG_CHECK_DEPTH,
        ]
      );
    });

    this.stats.depositsFound++;
    logger.info({
      userId: depositAddress.user_id,
      address: depositAddress.address,
      amountUsdc: event.amountUsdc,
      txHash: event.txHash,
      blockNumber: blockNumber.toString(),
    }, 'New deposit detected');
  }

  private async reorgCheckLoop(): Promise<void> {
    if (!this.isRunning) return;

    try {
      // 1. Check for reorgs
      const reorg = await detectReorgDepth(config.CHAIN_ID);
      if (reorg.hasReorg && reorg.forkBlock) {
        this.stats.reorgsDetected++;
        await handleReorg(config.CHAIN_ID, reorg.forkBlock);
      }

      // 2. Process pending deposits — check confirmations and verify
      await this.processPendingDeposits();
    } catch (err) {
      this.stats.errors++;
      logger.error({ err }, 'Reorg check loop error');
    }
  }

  private async processPendingDeposits(): Promise<void> {
    // Get deposits that need confirmation checking
    const pending = await query<{
      id: string;
      user_id: string;
      block_number: bigint;
      block_hash: string;
      amount_usdc: number;
      confirmations: number;
      required_confirmations: number;
      status: string;
    }>(
      `SELECT * FROM deposits
       WHERE status IN ('PENDING', 'CONFIRMING', 'VERIFIED')
       AND chain_id = $1`,
      [config.CHAIN_ID]
    );

    const client = getRpcClient();
    const currentBlock = await client.getBlock({ blockTag: 'latest' });
    const currentBlockNumber = currentBlock.number;

    for (const deposit of pending.rows) {
      const confirmations = Number(currentBlockNumber - deposit.block_number);

      // Update confirmations count
      await query(
        `UPDATE deposits SET confirmations = $1, updated_at = NOW() WHERE id = $2`,
        [confirmations, deposit.id]
      );

      // If not enough confirmations yet, update status to CONFIRMING
      if (confirmations < deposit.required_confirmations) {
        if (deposit.status !== 'CONFIRMING') {
          await query(
            `UPDATE deposits SET status = 'CONFIRMING', updated_at = NOW() WHERE id = $1`,
            [deposit.id]
          );
        }
        continue;
      }

      // Enough confirmations — run reorg verification
      if (deposit.status !== 'VERIFIED') {
        const verification = await verifyBlockCanonical(
          config.CHAIN_ID,
          deposit.block_number,
          deposit.block_hash
        );

        if (!verification.isCanonical) {
          // Reorg detected for this deposit
          await query(
            `UPDATE deposits SET status = 'FAILED', updated_at = NOW() WHERE id = $1`,
            [deposit.id]
          );
          logger.warn({ depositId: deposit.id }, 'Deposit failed reorg verification');
          continue;
        }

        // Mark as VERIFIED
        await query(
          `UPDATE deposits SET status = 'VERIFIED', verified_at_block = $1, updated_at = NOW() WHERE id = $2`,
          [verification.checkedAtBlock, deposit.id]
        );
        logger.info({ depositId: deposit.id }, 'Deposit passed reorg verification');
      }

      // If VERIFIED, credit the deposit
      if (deposit.status === 'VERIFIED') {
        await this.creditDeposit(deposit);
      }
    }
  }

  private async creditDeposit(deposit: {
    id: string;
    user_id: string;
    amount_raw: string;
    amount_usdc: number;
  }): Promise<void> {
    const lockKey = getAdvisoryLockKey('credit', deposit.user_id);

    await transaction(async (client) => {
      // Re-check status inside transaction
      const check = await client.query(
        `SELECT status FROM deposits WHERE id = $1 FOR UPDATE`,
        [deposit.id]
      );
      if (check.rows[0]?.status !== 'VERIFIED') return;

      // Atomic credit: move from pending to available
      await client.query(
        `UPDATE user_balances
         SET pending_usdc = pending_usdc - $1,
             available_usdc = available_usdc + $1,
             updated_at = NOW()
         WHERE user_id = $2`,
        [deposit.amount_usdc, deposit.user_id]
      );

      // Mark deposit as CREDITED
      await client.query(
        `UPDATE deposits SET status = 'CREDITED', credited_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [deposit.id]
      );
    });

    this.stats.depositsCredited++;
    logger.info({ depositId: deposit.id, amountUsdc: deposit.amount_usdc }, 'Deposit credited');
  }
}

export const watcherService = new WatcherService();