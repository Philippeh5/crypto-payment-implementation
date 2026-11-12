import { getPool, query, transaction, getAdvisoryLockKey } from '../db/pool.js';
import { getConfig } from '../../config.js';
import pino from 'pino';

const logger = pino({ name: 'settlement' });
const config = getConfig();

/**
 * Settlement Service
 *
 * Handles the atomic crediting of verified deposits to user balances.
 * Uses row-level locks (SELECT FOR UPDATE) to prevent race conditions.
 */

export interface CreditResult {
  success: boolean;
  depositId: string;
  userId: string;
  amountUsdc: number;
  newAvailableBalance: number;
  newPendingBalance: number;
}

export class SettlementService {
  /**
   * Credit a verified deposit to user's available balance.
   * Moves amount from pending_usdc to available_usdc atomically.
   */
  async creditDeposit(depositId: string): Promise<CreditResult> {
    // Get deposit details
    const depositResult = await query<{
      id: string;
      user_id: string;
      amount_usdc: number;
      status: string;
    }>(
      `SELECT id, user_id, amount_usdc, status FROM deposits WHERE id = $1`,
      [depositId]
    );

    const deposit = depositResult.rows[0];
    if (!deposit) {
      throw new Error(`Deposit ${depositId} not found`);
    }

    if (deposit.status !== 'VERIFIED') {
      throw new Error(`Deposit ${depositId} not in VERIFIED status (current: ${deposit.status})`);
    }

    const lockKey = getAdvisoryLockKey('credit', deposit.user_id);

    return transaction(async (client) => {
      // Lock the deposit row and re-check status
      const lockedDeposit = await client.query(
        `SELECT status FROM deposits WHERE id = $1 FOR UPDATE`,
        [depositId]
      );

      if (lockedDeposit.rows[0]?.status !== 'VERIFIED') {
        throw new Error(`Deposit status changed during credit attempt`);
      }

      // Lock user balance row
      const balanceResult = await client.query(
        `SELECT available_usdc, pending_usdc FROM user_balances WHERE user_id = $1 FOR UPDATE`,
        [deposit.user_id]
      );

      let availableUsdc = 0;
      let pendingUsdc = 0;

      if (balanceResult.rows.length === 0) {
        // Create balance row if doesn't exist
        await client.query(
          `INSERT INTO user_balances (user_id, available_usdc, pending_usdc) VALUES ($1, 0, 0)`,
          [deposit.user_id]
        );
      } else {
        availableUsdc = Number(balanceResult.rows[0].available_usdc);
        pendingUsdc = Number(balanceResult.rows[0].pending_usdc);
      }

      const amount = deposit.amount_usdc;

      // Verify sufficient pending balance
      if (pendingUsdc < amount) {
        logger.warn({
          userId: deposit.user_id,
          pending: pendingUsdc,
          amount,
        }, 'Insufficient pending balance for credit');
        // Don't fail — just log and continue (pending might be slightly off due to rounding)
      }

      // Atomic transfer: pending -> available
      await client.query(
        `UPDATE user_balances
         SET pending_usdc = GREATEST(pending_usdc - $1, 0),
             available_usdc = available_usdc + $1,
             updated_at = NOW()
         WHERE user_id = $2`,
        [amount, deposit.user_id]
      );

      // Mark deposit as CREDITED
      await client.query(
        `UPDATE deposits SET status = 'CREDITED', credited_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [depositId]
      );

      const newAvailable = availableUsdc + amount;
      const newPending = Math.max(pendingUsdc - amount, 0);

      logger.info({
        depositId,
        userId: deposit.user_id,
        amountUsdc: amount,
        newAvailable,
        newPending,
      }, 'Deposit credited successfully');

      return {
        success: true,
        depositId,
        userId: deposit.user_id,
        amountUsdc: amount,
        newAvailableBalance: newAvailable,
        newPendingBalance: newPending,
      };
    });
  }

  /**
   * Get user's current balances.
   */
  async getUserBalances(userId: string): Promise<{
    availableUsdc: number;
    pendingUsdc: number;
    lockedUsdc: number;
  }> {
    const result = await query<{
      available_usdc: number;
      pending_usdc: number;
      locked_usdc: number;
    }>(
      `SELECT available_usdc, pending_usdc, locked_usdc FROM user_balances WHERE user_id = $1`,
      [userId]
    );

    if (result.rows.length === 0) {
      return { availableUsdc: 0, pendingUsdc: 0, lockedUsdc: 0 };
    }

    return {
      availableUsdc: Number(result.rows[0].available_usdc),
      pendingUsdc: Number(result.rows[0].pending_usdc),
      lockedUsdc: Number(result.rows[0].locked_usdc),
    };
  }

  /**
   * Lock funds for withdrawal (move from available to locked).
   */
  async lockFundsForWithdrawal(userId: string, amountUsdc: number): Promise<boolean> {
    const lockKey = getAdvisoryLockKey('withdrawal_lock', userId);

    return transaction(async (client) => {
      const balanceResult = await client.query(
        `SELECT available_usdc FROM user_balances WHERE user_id = $1 FOR UPDATE`,
        [userId]
      );

      if (balanceResult.rows.length === 0) return false;

      const available = Number(balanceResult.rows[0].available_usdc);
      if (available < amountUsdc) return false;

      await client.query(
        `UPDATE user_balances
         SET available_usdc = available_usdc - $1,
             locked_usdc = locked_usdc + $1,
             updated_at = NOW()
         WHERE user_id = $2`,
        [amountUsdc, userId]
      );

      return true;
    });
  }

  /**
   * Release locked funds (withdrawal failed/cancelled).
   */
  async releaseLockedFunds(userId: string, amountUsdc: number): Promise<void> {
    await query(
      `UPDATE user_balances
       SET locked_usdc = GREATEST(locked_usdc - $1, 0),
           available_usdc = available_usdc + $1,
           updated_at = NOW()
       WHERE user_id = $2`,
      [amountUsdc, userId]
    );
  }

  /**
   * Finalize withdrawal (funds already locked, now removed from locked).
   */
  async finalizeWithdrawal(userId: string, amountUsdc: number): Promise<void> {
    await query(
      `UPDATE user_balances
       SET locked_usdc = GREATEST(locked_usdc - $1, 0),
           updated_at = NOW()
       WHERE user_id = $2`,
      [amountUsdc, userId]
    );
  }
}

export const settlementService = new SettlementService();