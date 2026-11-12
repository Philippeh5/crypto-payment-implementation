# Crypto Payment Starter Kit

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20.x-green?style=flat&logo=node.js&logoColor=white)](https://nodejs.org/)
[![EVM](https://img.shields.io/badge/EVM-Compatible-0052FF?style=flat&logo=ethereum)](https://ethereum.org/)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?style=flat&logo=docker&logoColor=white)](https://www.docker.com/)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

An **educational reference implementation** of a non-custodial crypto payment gateway for EVM networks. Demonstrates core patterns: BIP-44 HD wallet address derivation, deposit watching with reorg protection, settlement crediting, and withdrawal queues.

> ⚠️ **Starter Kit — Not Production Hardened**
> This is a learning reference. Production use requires: HSM/key isolation, comprehensive monitoring, rate limiting, audit trails, compliance review, and penetration testing.

---

## 🎯 Overview

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐     ┌────────────────┐
│   User      │────▶│   Gateway    │────▶│  EVM Chain  │────▶│  Settlement    │
│  Requests   │     │  Derives     │     │  Receives   │     │  Credits       │
│  Address    │     │  BIP-44 Addr │     │  USDC Dep.  │     │  User Balance  │
└─────────────┘     └──────────────┘     └─────────────┘     └────────────────┘
                           │                    │                    │
                           ▼                    ▼                    ▼
                    ┌──────────────┐     ┌─────────────┐     ┌────────────────┐
                    │  Database    │     │  Watcher    │     │  Withdrawal    │
                    │  (PostgreSQL)│     │  (RPC/WS)   │     │  Queue         │
                    └──────────────┘     └─────────────┘     └────────────────┘
```

**Core flows implemented:**
1. **Address Derivation** — Deterministic BIP-44 (`m/44'/60'/0'/0/index`) from `xpub`
2. **Deposit Watching** — Polling + WebSocket fallback, ERC-20 `Transfer` log parsing
3. **Reorg Protection** — Block hash verification at confirmation depth before crediting
4. **Settlement** — Atomic `credit_deposit()` with row-level locks
5. **Withdrawals** — Queued, risk-thresholded, hot-wallet signed broadcast

---

## 🛠️ Architecture & Tech Stack

| Layer | Technology |
| :--- | :--- |
| **Runtime** | Node.js 20+ / TypeScript (strict mode) |
| **EVM Interaction** | [Viem](https://viem.sh/) — type-safe, lightweight |
| **Chains** | Base (L2), Ethereum, Arbitrum, Polygon (configurable) |
| **Token** | ERC-20 USDC (configurable contract address) |
| **Database** | PostgreSQL (Supabase compatible) with advisory locks |
| **Config** | Zod-validated environment schema |
| **Deployment** | Multi-stage Docker + Docker Compose |

---

## 📂 Repository Structure

```plaintext
crypto-payment-starter-kit/
├── docker-compose.yml          # Local dev: app + postgres
├── Dockerfile                  # Multi-stage production build
├── package.json
├── tsconfig.json               # Strict TypeScript config
├── .env.example                # Safe template (no secrets)
├── src/
│   ├── config.ts               # Zod-validated env schema
│   ├── db/
│   │   ├── schema.sql          # Tables: deposits, withdrawals, users, blocks
│   │   ├── pool.ts             # Pg pool with advisory lock helpers
│   │   └── migrations/         # SQL migrations (001_init.sql)
│   ├── wallet/
│   │   ├── bip44.ts            # xpub → address derivation (m/44'/60'/0'/0/i)
│   │   └── index.ts            # WalletService: getNextAddress(), validateAddress()
│   ├── watcher/
│   │   ├── rpc.ts              # Viem clients: public + fallback providers
│   │   ├── parser.ts           # ERC-20 Transfer log → DepositEvent
│   │   ├── reorg.ts            // Block hash verification at depth
│   │   └── index.ts            // WatcherService: start(), stop(), poll loop
│   ├── settlement/
│   │   ├── creditor.ts         // creditDeposit() with SELECT FOR UPDATE
│   │   └── index.ts            // SettlementService
│   ├── withdrawal/
│   │   ├── queue.ts            // WithdrawalQueue: enqueue, process, retry
│   │   ├── signer.ts           // Hot wallet signing (Viem account)
│   │   └── index.ts            // WithdrawalService
│   └── index.ts                // Application entrypoint (wires all services)
└── tests/
    ├── bip44.test.ts           // Derivation vectors
    ├── parser.test.ts          // Log parsing edge cases
    └── reorg.test.ts           // Reorg detection scenarios
```

---

## 🚀 Quickstart

### 1. Prerequisites
- Node.js 20+
- PostgreSQL 15+ (or [Supabase](https://supabase.com) free tier)
- Base Sepolia RPC URL ([Alchemy](https://alchemy.com), [QuickNode](https://quicknode.com), or public)

### 2. Install & Configure
```bash
git clone https://github.com/Philippeh5/crypto-payment-starter-kit.git
cd crypto-payment-starter-kit

npm install
cp .env.example .env
# Edit .env with your values (see Configuration below)
```

### 3. Database Setup
```bash
# Option A: Docker Compose (spins up Postgres)
docker-compose up -d postgres
# Run migrations
npm run db:migrate

# Option B: External Postgres/Supabase
# Create DB, then run migrations manually
psql $DATABASE_URL -f src/db/schema.sql
```

### 4. Run
```bash
# Development (hot reload)
npm run dev

# Production build + run
npm run build
npm start
```

---

## ⚙️ Configuration (`.env`)

```bash
# ──────────────────────────────────────────────
# Chain & RPC
# ──────────────────────────────────────────────
RPC_URL=https://sepolia.base.org
RPC_FALLBACK_URLS=https://base-sepolia.g.alchemy.com/v2/...,https://base-sepolia.drpc.org
CHAIN_ID=84532

# ──────────────────────────────────────────────
# Token (ERC-20 USDC on Base Sepolia)
# ──────────────────────────────────────────────
USDC_CONTRACT_ADDRESS=0x036CbD9B5AD317E2bDF7c6A8445A46C1A63a5925C
USDC_DECIMALS=6

# ──────────────────────────────────────────────
# Wallet — NEVER put mnemonics/private keys in .env for production
# ──────────────────────────────────────────────
# Extended Public Key (xpub) for address derivation ONLY
# Generate offline: `cast wallet derive-mnemonic --xpub` or hardware wallet
MASTER_XPUB="xpub6C..."

# Hot wallet private key — ONLY for withdrawal signing
# Fund with MINIMAL liquidity (daily volume + buffer)
# Use hardware wallet / HSM in production
HOT_WALLET_PRIVATE_KEY="0x..."

# ──────────────────────────────────────────────
# Settlement & Risk
# ──────────────────────────────────────────────
REQUIRED_CONFIRMATIONS=5          # Blocks to wait before crediting
REORG_CHECK_DEPTH=10              # How far back to verify block hashes
AUTO_APPROVE_THRESHOLD_USDC=500   # Withdrawals ≤ this: auto-broadcast
MAX_WITHDRAWAL_USDC=10000         # Hard cap per withdrawal
WITHDRAWAL_COOLDOWN_MS=30000      # Min time between withdrawals

# ──────────────────────────────────────────────
# Database
# ──────────────────────────────────────────────
DATABASE_URL=postgresql://user:pass@localhost:5432/payment_gateway
# Or Supabase: postgresql://postgres:pass@db.xxx.supabase.co:5432/postgres

# ──────────────────────────────────────────────
# App
# ──────────────────────────────────────────────
PORT=3000
LOG_LEVEL=info
NODE_ENV=development
```

> **Security Note**: In production, never commit `.env`. Use secret managers (AWS Secrets Manager, GCP Secret Manager, Vault, Supabase Vault). Only `MASTER_XPUB` goes on the server — master seed stays offline.

---

## 🧪 Testing

```bash
# Unit tests
npm test

# Watch mode
npm run test:watch

# Coverage
npm run test:coverage
```

**Test coverage includes:**
- BIP-44 derivation vectors (testnet/mainnet, multiple indices)
- ERC-20 `Transfer` log parsing (indexed topics, data field)
- Reorg detection (block hash mismatch at depth)
- Settlement idempotency (duplicate credit prevention)
- Withdrawal queue ordering & retry logic

---

## 📚 Key Concepts

### BIP-44 Address Derivation
```typescript
// m / 44' / 60' / 0' / 0 / address_index
// 44' = BIP-44 purpose
// 60' = Ethereum coin type (EVM)
// 0'  = Account 0
// 0   = External chain (receive)
// i   = Address index (0, 1, 2...)

const address = deriveAddress(masterXpub, index);
// Returns: { address: "0x...", index, derivationPath }
```

### Deposit Lifecycle
```
PENDING (detected) → CONFIRMING (waiting for blocks)
    → VERIFIED (reorg check passed) → CREDITED (balance updated)
    → FAILED (reorg detected / invalid)
```

### Withdrawal Lifecycle
```
QUEUED → VALIDATING (balance, limits, cooldown)
    → SIGNING (hot wallet) → BROADCASTING (mempool)
    → CONFIRMED (on-chain) → COMPLETED
    → FAILED (retry / manual review)
```

---

## 🔒 Security Checklist (Before Production)

- [ ] **Key Management**: Master seed offline (hardware wallet). Only `xpub` on server. Hot wallet = minimal funds.
- [ ] **RPC**: Private endpoints with auth. Failover configured. Rate limiting on client.
- [ ] **Database**: Row-level security. Encrypted at rest. Automated backups. PITR enabled.
- [ ] **Monitoring**: Deposit latency alerts. Reorg detection alerts. Withdrawal failure alerts. Balance reconciliation cron.
- [ ] **Rate Limiting**: Per-user deposit address requests. Per-IP API limits. Webhook HMAC verification.
- [ ] **Compliance**: KYC/AML integration if required. Sanctions screening (OFAC, etc.). Travel Rule for >$1k.
- [ ] **Audit**: External smart contract audit (if custom contracts). Penetration test. Code review.

---

## 📖 Learning Path

1. **Start here**: `src/wallet/bip44.ts` — understand deterministic derivation
2. **Then**: `src/watcher/parser.ts` — ERC-20 log parsing
3. **Then**: `src/watcher/reorg.ts` — why block hash verification matters
4. **Then**: `src/settlement/creditor.ts` — atomic crediting with `SELECT FOR UPDATE`
5. **Then**: `src/withdrawal/queue.ts` — risk-bounded withdrawal processing

---

## 🤝 Contributing

Issues and PRs welcome for:
- Additional chain configurations
- Improved test coverage
- Documentation clarity
- Bug fixes

**Not accepted**: Production hardening PRs (this is intentionally a *starter kit*), feature requests for specific business logic.

---

## 📄 License

MIT License.