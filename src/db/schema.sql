-- ──────────────────────────────────────────────
-- crypto-payment-starter-kit Database Schema
-- PostgreSQL 15+
-- ──────────────────────────────────────────────

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ──────────────────────────────────────────────
-- Users (simplified — in reality this would be your auth system)
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    external_id TEXT UNIQUE,           -- Your app's user ID
    email TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_external_id ON users(external_id);

-- ──────────────────────────────────────────────
-- Deposit Addresses (BIP-44 derived)
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS deposit_addresses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    address TEXT NOT NULL,             -- Checksummed EVM address
    derivation_index INTEGER NOT NULL, -- BIP-44 index (m/44'/60'/0'/0/index)
    derivation_path TEXT NOT NULL,     -- Full path for audit
    chain_id INTEGER NOT NULL,         -- EVM chain ID
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (chain_id, address)
);

CREATE INDEX IF NOT EXISTS idx_deposit_addresses_user_id ON deposit_addresses(user_id);
CREATE INDEX IF NOT EXISTS idx_deposit_addresses_chain_address ON deposit_addresses(chain_id, address);

-- ──────────────────────────────────────────────
-- Deposits (on-chain USDC transfers)
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS deposits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    deposit_address_id UUID NOT NULL REFERENCES deposit_addresses(id) ON DELETE RESTRICT,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- On-chain identifiers
    tx_hash TEXT NOT NULL,             -- Transaction hash
    log_index INTEGER NOT NULL,        -- Log index within transaction
    block_number BIGINT NOT NULL,      -- Block where deposit was included
    block_hash TEXT NOT NULL,          -- Block hash for reorg verification

    -- Amount (in smallest unit, e.g., 6 decimals for USDC)
    amount_raw BIGINT NOT NULL,        -- Raw amount (no decimals)
    amount_usdc NUMERIC(18, 6) NOT NULL, -- Human-readable USDC amount

    -- Status lifecycle
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN (
        'PENDING',       -- Detected, waiting for confirmations
        'CONFIRMING',    -- Has some confirmations, not enough yet
        'VERIFIED',      -- Reorg check passed at required depth
        'CREDITED',      -- Balance updated, settlement complete
        'FAILED'         -- Reorg detected or invalid
    )),

    -- Confirmation tracking
    confirmations INTEGER NOT NULL DEFAULT 0,
    required_confirmations INTEGER NOT NULL DEFAULT 5,

    -- Reorg protection
    verified_at_block BIGINT,          -- Block height where reorg check passed
    reorg_check_depth INTEGER NOT NULL DEFAULT 10,

    -- Timestamps
    detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    confirmed_at TIMESTAMPTZ,
    credited_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (tx_hash, log_index)
);

CREATE INDEX IF NOT EXISTS idx_deposits_user_id ON deposits(user_id);
CREATE INDEX IF NOT EXISTS idx_deposits_status ON deposits(status);
CREATE INDEX IF NOT EXISTS idx_deposits_block_number ON deposits(block_number);
CREATE INDEX IF NOT EXISTS idx_deposits_tx_hash ON deposits(tx_hash);

-- ──────────────────────────────────────────────
-- Withdrawals (user-initiated)
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS withdrawals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- Destination
    destination_address TEXT NOT NULL, -- Checksummed EVM address
    chain_id INTEGER NOT NULL,

    -- Amount
    amount_raw BIGINT NOT NULL,
    amount_usdc NUMERIC(18, 6) NOT NULL,

    -- Fee (paid by user, deducted from amount)
    fee_raw BIGINT NOT NULL DEFAULT 0,
    fee_usdc NUMERIC(18, 6) NOT NULL DEFAULT 0,

    -- Status lifecycle
    status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN (
        'QUEUED',           -- Waiting to be processed
        'VALIDATING',       -- Checking balance, limits, cooldown
        'SIGNING',          -- Hot wallet signing
        'BROADCASTING',     -- Submitting to mempool
        'CONFIRMED',        -- On-chain confirmed
        'COMPLETED',        -- Fully settled
        'FAILED',           -- Error (retryable or manual)
        'CANCELLED'         -- User/admin cancelled
    )),

    -- On-chain
    tx_hash TEXT,                      -- Broadcast transaction hash
    block_number BIGINT,               -- Confirmed block
    gas_used BIGINT,                   -- Actual gas used
    effective_gas_price BIGINT,        -- Effective gas price (wei)

    -- Risk controls
    auto_approved BOOLEAN NOT NULL DEFAULT FALSE,
    retry_count INTEGER NOT NULL DEFAULT 0,
    max_retries INTEGER NOT NULL DEFAULT 3,
    last_error TEXT,

    -- Timestamps
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ,
    confirmed_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_withdrawals_user_id ON withdrawals(user_id);
CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals(status);
CREATE INDEX IF NOT EXISTS idx_withdrawals_tx_hash ON withdrawals(tx_hash);

-- ──────────────────────────────────────────────
-- User Balances (USD-denominated, 6 decimals)
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_balances (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    available_usdc NUMERIC(18, 6) NOT NULL DEFAULT 0,   -- Spendable
    pending_usdc NUMERIC(18, 6) NOT NULL DEFAULT 0,     -- Awaiting confirmations
    locked_usdc NUMERIC(18, 6) NOT NULL DEFAULT 0,      -- In withdrawal queue
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ──────────────────────────────────────────────
-- Processed Blocks (for reorg detection & idempotency)
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS processed_blocks (
    chain_id INTEGER NOT NULL,
    block_number BIGINT NOT NULL,
    block_hash TEXT NOT NULL,
    parent_hash TEXT NOT NULL,
    timestamp TIMESTAMPTZ NOT NULL,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (chain_id, block_number)
);

CREATE INDEX IF NOT EXISTS idx_processed_blocks_chain_number ON processed_blocks(chain_id, block_number);

-- ──────────────────────────────────────────────
-- Helper: Updated_at trigger
-- ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS update_users_updated_at ON users;
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_deposits_updated_at ON deposits;
CREATE TRIGGER update_deposits_updated_at BEFORE UPDATE ON deposits FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_withdrawals_updated_at ON withdrawals;
CREATE TRIGGER update_withdrawals_updated_at BEFORE UPDATE ON withdrawals FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_user_balances_updated_at ON user_balances;
CREATE TRIGGER update_user_balances_updated_at BEFORE UPDATE ON user_balances FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();