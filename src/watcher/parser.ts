import { type Log } from 'viem';
import { getConfig } from '../../config.js';
import pino from 'pino';

const logger = pino({ name: 'log-parser' });
const config = getConfig();

/**
 * ERC-20 Transfer event signature: Transfer(address indexed from, address indexed to, uint256 value)
 * Topic0 = keccak256("Transfer(address,address,uint256)")
 */
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/**
 * Parsed deposit event from ERC-20 Transfer log.
 */
export interface DepositEvent {
  txHash: string;
  logIndex: number;
  blockNumber: bigint;
  blockHash: string;
  fromAddress: string;
  toAddress: string;
  amountRaw: bigint;
  amountUsdc: number;
  timestamp: number;
}

/**
 * Parse an ERC-20 Transfer log into a DepositEvent.
 * Validates: correct contract, correct topic, indexed topics match.
 */
export function parseTransferLog(log: Log, blockTimestamp: number): DepositEvent | null {
  try {
    // Validate contract address
    if (normalizeAddress(log.address) !== normalizeAddress(config.USDC_CONTRACT_ADDRESS)) {
      return null;
    }

    // Validate topic0
    if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC.toLowerCase()) {
      return null;
    }

    // Topics: [topic0, from (indexed), to (indexed)]
    // Data: value (uint256)
    if (log.topics.length < 3) {
      logger.warn({ log }, 'Transfer log missing indexed topics');
      return null;
    }

    const fromAddress = `0x${log.topics[1].slice(-40)}`;
    const toAddress = `0x${log.topics[2].slice(-40)}`;
    const amountRaw = BigInt(log.data || '0x0');

    if (amountRaw === 0n) {
      return null;
    }

    const decimals = config.USDC_DECIMALS;
    const amountUsdc = Number(amountRaw) / Math.pow(10, decimals);

    return {
      txHash: log.transactionHash,
      logIndex: log.logIndex ?? 0,
      blockNumber: log.blockNumber,
      blockHash: log.blockHash,
      fromAddress: normalizeAddress(fromAddress),
      toAddress: normalizeAddress(toAddress),
      amountRaw,
      amountUsdc,
      timestamp: blockTimestamp,
    };
  } catch (err) {
    logger.error({ err, log }, 'Failed to parse transfer log');
    return null;
  }
}

/**
 * Normalize address to lowercase.
 */
function normalizeAddress(address: string): string {
  return address.toLowerCase();
}

/**
 * Check if a log is a USDC Transfer to one of our deposit addresses.
 * Used for quick filtering before full parsing.
 */
export function isRelevantTransfer(log: Log): boolean {
  if (normalizeAddress(log.address) !== normalizeAddress(config.USDC_CONTRACT_ADDRESS)) {
    return false;
  }
  if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC.toLowerCase()) {
    return false;
  }
  return true;
}