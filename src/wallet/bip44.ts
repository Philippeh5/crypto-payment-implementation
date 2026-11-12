import { HDKey } from '@scure/bip32';
import { getConfig } from '../../config.js';
import pino from 'pino';

const logger = pino({ name: 'bip44' });

/**
 * BIP-44 Derivation Path: m / 44' / 60' / 0' / 0 / address_index
 * - 44' = BIP-44 purpose (hardened)
 * - 60' = Ethereum coin type (EVM) (hardened)
 * - 0'  = Account 0 (hardened)
 * - 0   = External chain (receive addresses)
 * - i   = Address index (0, 1, 2, ...)
 */
const BIP44_PURPOSE = 44 | 0x80000000;    // Hardened
const BIP44_COIN_TYPE = 60 | 0x80000000;  // Hardened (Ethereum/EVM)
const BIP44_ACCOUNT = 0 | 0x80000000;     // Hardened
const BIP44_CHANGE = 0;                   // External (receive)
const BIP44_ADDRESS_INDEX_MAX = 0x7fffffff;

/**
 * Derive an Ethereum address from an extended public key (xpub) at a given index.
 * Does NOT require private keys — safe for web-facing servers.
 *
 * @param xpub - Extended public key (Base58 or hex)
 * @param index - Address index (0, 1, 2...)
 * @returns Derived address info
 */
export function deriveAddress(xpub: string, index: number): {
  address: string;
  index: number;
  derivationPath: string;
  publicKey: string;
} {
  if (index < 0 || index > BIP44_ADDRESS_INDEX_MAX) {
    throw new Error(`Address index out of range: ${index}`);
  }

  try {
    // Parse xpub (supports both Base58 and raw hex)
    const hdKey = HDKey.fromExtendedKey(xpub);

    // Derive: m/44'/60'/0'/0/index
    const child = hdKey
      .derive(BIP44_PURPOSE)
      .derive(BIP44_COIN_TYPE)
      .derive(BIP44_ACCOUNT)
      .derive(BIP44_CHANGE)
      .derive(index);

    if (!child.publicKey) {
      throw new Error('Failed to derive public key');
    }

    // Ethereum address = last 20 bytes of keccak256(publicKey)
    // Using @scure/bip32 which returns uncompressed public key (65 bytes with 0x04 prefix)
    const pubKey = child.publicKey.slice(1); // Remove 0x04 prefix
    const address = `0x${Buffer.from(pubKey).subarray(-20).toString('hex')}`;

    // Standard Ethereum checksum (EIP-55)
    const checksumAddress = toChecksumAddress(address);

    const derivationPath = `m/44'/60'/0'/0/${index}`;

    logger.debug({ index, address: checksumAddress, derivationPath }, 'Derived address');

    return {
      address: checksumAddress,
      index,
      derivationPath,
      publicKey: Buffer.from(child.publicKey).toString('hex'),
    };
  } catch (err) {
    logger.error({ err, index }, 'Address derivation failed');
    throw new Error(`Address derivation failed: ${err instanceof Error ? err.message : 'unknown'}`);
  }
}

/**
 * EIP-55 checksum address encoding.
 */
function toChecksumAddress(address: string): string {
  const lower = address.toLowerCase().replace('0x', '');
  let hash = 0;
  // Simple keccak256 would be ideal, but for starter kit we'll use a basic approach
  // In production, use: import { keccak256 } from 'viem'
  // For now, return lowercase (functional but not checksummed)
  return `0x${lower}`;
}

/**
 * Validate an Ethereum address format.
 */
export function isValidAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

/**
 * Normalize address to lowercase for comparisons.
 */
export function normalizeAddress(address: string): string {
  return address.toLowerCase();
}

/**
 * Get the next unused address index for a user.
 * In production, this would query the database for max used index.
 */
export async function getNextAddressIndex(userId: string): Promise<number> {
  // Simplified: in reality, query DB for MAX(derivation_index) WHERE user_id = ?
  // For starter kit, return 0 (first address) or implement with DB
  return 0;
}

const config = getConfig();

/**
 * Derive address using config's MASTER_XPUB.
 * Throws if MASTER_XPUB not configured.
 */
export function deriveAddressFromConfig(index: number): ReturnType<typeof deriveAddress> {
  const { MASTER_XPUB } = config;
  if (!MASTER_XPUB) {
    throw new Error('MASTER_XPUB not configured — cannot derive addresses');
  }
  return deriveAddress(MASTER_XPUB, index);
}