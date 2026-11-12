import { getPool, query, getAdvisoryLockKey, withAdvisoryLock } from '../db/pool.js';
import { deriveAddress, deriveAddressFromConfig, isValidAddress, normalizeAddress } from './bip44.js';
import { getConfig } from '../../config.js';
import pino from 'pino';

const logger = pino({ name: 'wallet-service' });

export interface DepositAddressRecord {
  id: string;
  user_id: string;
  address: string;
  derivation_index: number;
  derivation_path: string;
  chain_id: number;
  is_active: boolean;
  created_at: Date;
}

export interface CreateDepositAddressParams {
  userId: string;
  chainId?: number;
}

export class WalletService {
  private config = getConfig();

  /**
   * Get or create the next deposit address for a user.
   * Uses advisory lock to prevent concurrent derivation conflicts.
   */
  async getOrCreateDepositAddress(params: CreateDepositAddressParams): Promise<DepositAddressRecord> {
    const { userId } = params;
    const chainId = params.chainId ?? this.config.CHAIN_ID;

    const lockKey = getAdvisoryLockKey('deposit_address', userId);

    return withAdvisoryLock(lockKey, async () => {
      // Check for existing active address
      const existing = await query<DepositAddressRecord>(
        `SELECT * FROM deposit_addresses
         WHERE user_id = $1 AND chain_id = $2 AND is_active = TRUE
         ORDER BY derivation_index DESC LIMIT 1`,
        [userId, chainId]
      );

      if (existing.rows.length > 0) {
        return existing.rows[0];
      }

      // Get next index
      const maxIndexResult = await query<{ max_index: number }>(
        `SELECT COALESCE(MAX(derivation_index), -1) as max_index
         FROM deposit_addresses WHERE user_id = $1 AND chain_id = $2`,
        [userId, chainId]
      );

      const nextIndex = (maxIndexResult.rows[0]?.max_index ?? -1) + 1;

      // Derive address
      const derived = deriveAddressFromConfig(nextIndex);

      // Store
      const inserted = await query<DepositAddressRecord>(
        `INSERT INTO deposit_addresses (user_id, address, derivation_index, derivation_path, chain_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [userId, derived.address, derived.index, derived.derivationPath, chainId]
      );

      logger.info({ userId, address: derived.address, index: derived.index }, 'Created deposit address');
      return inserted.rows[0];
    });
  }

  /**
   * Validate that an address belongs to our derivation scheme.
   */
  async validateDepositAddress(address: string, chainId: number): Promise<DepositAddressRecord | null> {
    const normalized = normalizeAddress(address);
    const result = await query<DepositAddressRecord>(
      `SELECT * FROM deposit_addresses
       WHERE LOWER(address) = $1 AND chain_id = $2 AND is_active = TRUE`,
      [normalized, chainId]
    );
    return result.rows[0] ?? null;
  }

  /**
   * Get all deposit addresses for a user.
   */
  async getUserDepositAddresses(userId: string, chainId?: number): Promise<DepositAddressRecord[]> {
    const targetChainId = chainId ?? this.config.CHAIN_ID;
    const result = await query<DepositAddressRecord>(
      `SELECT * FROM deposit_addresses
       WHERE user_id = $1 AND chain_id = $2
       ORDER BY derivation_index ASC`,
      [userId, targetChainId]
    );
    return result.rows;
  }

  /**
   * Deactivate an address (e.g., after compromise).
   */
  async deactivateAddress(addressId: string): Promise<void> {
    await query(
      `UPDATE deposit_addresses SET is_active = FALSE WHERE id = $1`,
      [addressId]
    );
    logger.info({ addressId }, 'Deactivated deposit address');
  }
}

export const walletService = new WalletService();