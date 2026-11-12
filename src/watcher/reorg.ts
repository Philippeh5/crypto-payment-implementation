import { getPool, query, transaction } from '../db/pool.js';
import { getRpcClient } from './rpc.js';
import { getConfig } from '../../config.js';
import pino from 'pino';

const logger = pino({ name: 'reorg-protection' });
const config = getConfig();

/**
 * Reorg Protection
 *
 * Before crediting a deposit, verify that the block it was included in
 * is still canonical at the required confirmation depth.
 *
 * Strategy:
 * 1. When deposit is detected at block N, wait for REQUIRED_CONFIRMATIONS
 * 2. At block N + REQUIRED_CONFIRMATIONS, fetch block hash for block N
 * 3. Compare with stored block hash from when deposit was first seen
 * 4. If match → canonical → credit
 * 5. If mismatch → reorg detected → mark deposit FAILED
 */

export interface ReorgCheckResult {
  isCanonical: boolean;
  currentBlockHash: string;
  storedBlockHash: string;
  checkedAtBlock: bigint;
}

/**
 * Verify that a block is still canonical by comparing its hash
 * at the current chain tip minus reorg check depth.
 */
export async function verifyBlockCanonical(
  chainId: number,
  blockNumber: bigint,
  storedBlockHash: string
): Promise<ReorgCheckResult> {
  const client = getRpcClient();

  // Current chain tip
  const currentBlock = await client.getBlock({ blockTag: 'latest' });
  const currentBlockNumber = currentBlock.number;

  // We can only verify if we're past the check depth
  const checkDepth = BigInt(config.REORG_CHECK_DEPTH);
  if (currentBlockNumber < blockNumber + checkDepth) {
    return {
      isCanonical: false,
      currentBlockHash: '',
      storedBlockHash,
      checkedAtBlock: currentBlockNumber,
    };
  }

  // Fetch the block at the target height
  const targetBlock = await client.getBlock({ blockNumber, blockTag: undefined });
  const currentBlockHash = targetBlock.hash;

  const isCanonical = currentBlockHash.toLowerCase() === storedBlockHash.toLowerCase();

  logger.info({
    blockNumber: blockNumber.toString(),
    storedHash: storedBlockHash,
    currentHash: currentBlockHash,
    isCanonical,
    checkDepth: checkDepth.toString(),
  }, 'Reorg check completed');

  return {
    isCanonical,
    currentBlockHash,
    storedBlockHash,
    checkedAtBlock: currentBlockNumber,
  };
}

/**
 * Store a processed block for future reorg checks.
 */
export async function storeProcessedBlock(
  chainId: number,
  blockNumber: bigint,
  blockHash: string,
  parentHash: string,
  timestamp: number
): Promise<void> {
  await query(
    `INSERT INTO processed_blocks (chain_id, block_number, block_hash, parent_hash, timestamp)
     VALUES ($1, $2, $3, $4, to_timestamp($5))
     ON CONFLICT (chain_id, block_number) DO UPDATE SET
       block_hash = EXCLUDED.block_hash,
       parent_hash = EXCLUDED.parent_hash,
       timestamp = EXCLUDED.timestamp,
       processed_at = NOW()`,
    [chainId, blockNumber, blockHash, parentHash, timestamp]
  );
}

/**
 * Get stored block hash for reorg verification.
 */
export async function getStoredBlockHash(
  chainId: number,
  blockNumber: bigint
): Promise<string | null> {
  const result = await query<{ block_hash: string }>(
    `SELECT block_hash FROM processed_blocks WHERE chain_id = $1 AND block_number = $2`,
    [chainId, blockNumber]
  );
  return result.rows[0]?.block_hash ?? null;
}

/**
 * Detect reorg by walking back from current tip.
 * Returns the first block where hash diverges (fork point).
 */
export async function detectReorgDepth(chainId: number): Promise<{
  hasReorg: boolean;
  forkBlock: bigint | null;
  commonAncestor: bigint | null;
}> {
  const client = getRpcClient();
  const currentBlock = await client.getBlock({ blockTag: 'latest' });
  let currentNumber = currentBlock.number;
  let currentHash = currentBlock.hash;

  // Walk back up to REORG_CHECK_DEPTH
  for (let i = 0; i < config.REORG_CHECK_DEPTH; i++) {
    if (currentNumber === 0n) break;

    const stored = await getStoredBlockHash(chainId, currentNumber);
    if (!stored) break; // No record yet

    if (stored.toLowerCase() !== currentHash.toLowerCase()) {
      // Found divergence
      const ancestor = currentNumber - 1n;
      return {
        hasReorg: true,
        forkBlock: currentNumber,
        commonAncestor: ancestor > 0n ? ancestor : 0n,
      };
    }

    // Move to parent
    const parentBlock = await client.getBlock({ blockNumber: currentNumber });
    currentHash = parentBlock.parentHash;
    currentNumber = parentBlock.number;
  }

  return { hasReorg: false, forkBlock: null, commonAncestor: null };
}

/**
 * Handle detected reorg: mark affected deposits as FAILED.
 * Call this when detectReorgDepth returns hasReorg=true.
 */
export async function handleReorg(
  chainId: number,
  forkBlock: bigint
): Promise<number> {
  // Mark all deposits in the forked blocks as FAILED
  const result = await query(
    `UPDATE deposits
     SET status = 'FAILED', updated_at = NOW()
     WHERE chain_id = $1 AND block_number >= $2 AND status IN ('PENDING', 'CONFIRMING', 'VERIFIED')
     RETURNING id`,
    [chainId, forkBlock]
  );

  const count = result.rowCount ?? 0;
  if (count > 0) {
    logger.warn({ chainId, forkBlock: forkBlock.toString(), count }, 'Reorg detected — marked deposits as FAILED');
  }

  return count;
}