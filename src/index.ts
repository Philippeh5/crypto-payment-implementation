import 'dotenv/config';
import { createServer } from 'http';
import { getConfig } from './config.js';
import { getPool, closePool, healthCheck } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { walletService } from './wallet/index.js';
import { watcherService } from './watcher/index.js';
import { withdrawalQueue } from './withdrawal/index.js';
import pino from 'pino';

const logger = pino({ name: 'app' });
const config = getConfig();

class Application {
  private server: ReturnType<typeof createServer> | null = null;
  private isShuttingDown = false;

  async start(): Promise<void> {
    logger.info('Starting Crypto Payment Starter Kit...');

    // Initialize database
    const pool = getPool();
    logger.info('Database pool created');

    // Run migrations
    await runMigrations();
    logger.info('Migrations completed');

    // Health check
    const healthy = await healthCheck();
    if (!healthy) {
      throw new Error('Database health check failed');
    }
    logger.info('Database health check passed');

    // Start watcher (deposit monitoring)
    await watcherService.start();
    logger.info('Deposit watcher started');

    // Start withdrawal queue
    withdrawalQueue.start();
    logger.info('Withdrawal queue started');

    // Start HTTP server
    await this.startHttpServer();

    // Graceful shutdown handlers
    this.setupShutdownHandlers();

    logger.info({ port: config.PORT }, 'Application started successfully');
  }

  private async startHttpServer(): Promise<void> {
    this.server = createServer(async (req, res) => {
      // CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = new URL(req.url || '/', `http://localhost:${config.PORT}`);

      try {
        if (url.pathname === '/health') {
          await this.handleHealth(req, res);
        } else if (url.pathname === '/api/deposit-address' && req.method === 'POST') {
          await this.handleCreateDepositAddress(req, res);
        } else if (url.pathname === '/api/balance' && req.method === 'GET') {
          await this.handleGetBalance(req, res);
        } else if (url.pathname === '/api/withdraw' && req.method === 'POST') {
          await this.handleWithdraw(req, res);
        } else if (url.pathname === '/api/stats' && req.method === 'GET') {
          await this.handleStats(req, res);
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
        }
      } catch (err) {
        logger.error({ err }, 'Request handler error');
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    });

    return new Promise<void>((resolve, reject) => {
      this.server!.listen(config.PORT, () => {
        logger.info({ port: config.PORT }, 'HTTP server listening');
        resolve();
      });
      this.server!.on('error', reject);
    });
  }

  private async handleHealth(_req: any, res: any): Promise<void> {
    const dbHealthy = await healthCheck();
    const watcherStats = watcherService.getStats();

    res.writeHead(dbHealthy ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: dbHealthy ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      database: dbHealthy ? 'connected' : 'disconnected',
      watcher: {
        running: watcherStats.isRunning,
        lastPolledBlock: watcherStats.lastPolledBlock.toString(),
        currentBlock: watcherStats.currentBlock.toString(),
        depositsFound: watcherStats.depositsFound,
        depositsCredited: watcherStats.depositsCredited,
      },
    }));
  }

  private async handleCreateDepositAddress(req: any, res: any): Promise<void> {
    const body = await this.parseBody(req);
    const { userId } = body;

    if (!userId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'userId required' }));
      return;
    }

    try {
      const address = await walletService.getOrCreateDepositAddress({ userId });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        address: address.address,
        derivationIndex: address.derivation_index,
        derivationPath: address.derivation_path,
        chainId: address.chain_id,
      }));
    } catch (err: any) {
      logger.error({ err, userId }, 'Create deposit address failed');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  private async handleGetBalance(req: any, res: any): Promise<void> {
    const url = new URL(req.url || '/', `http://localhost:${config.PORT}`);
    const userId = url.searchParams.get('userId');

    if (!userId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'userId required' }));
      return;
    }

    try {
      const balances = await walletService.getUserDepositAddresses(userId);
      // For simplicity, return address list; real impl would query user_balances
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ userId, addresses: balances }));
    } catch (err: any) {
      logger.error({ err, userId }, 'Get balance failed');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  private async handleWithdraw(req: any, res: any): Promise<void> {
    const body = await this.parseBody(req);
    const { userId, destinationAddress, amountUsdc } = body;

    if (!userId || !destinationAddress || !amountUsdc) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'userId, destinationAddress, amountUsdc required' }));
      return;
    }

    try {
      // Insert withdrawal request
      const amountRaw = BigInt(Math.round(amountUsdc * Math.pow(10, config.USDC_DECIMALS)));
      const result = await getPool().query(
        `INSERT INTO withdrawals (user_id, destination_address, chain_id, amount_raw, amount_usdc, fee_raw, fee_usdc, auto_approved)
         VALUES ($1, $2, $3, $4, $5, 0, 0, $6)
         RETURNING id`,
        [userId, destinationAddress, config.CHAIN_ID, amountRaw.toString(), amountUsdc, amountUsdc <= config.AUTO_APPROVE_THRESHOLD_USDC]
      );

      const withdrawalId = result.rows[0].id;
      logger.info({ withdrawalId, userId, amountUsdc }, 'Withdrawal requested');

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ withdrawalId, status: 'QUEUED' }));
    } catch (err: any) {
      logger.error({ err, userId }, 'Withdrawal request failed');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  private async handleStats(_req: any, res: any): Promise<void> {
    const watcherStats = watcherService.getStats();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      watcher: watcherStats,
      uptimeMs: Date.now() - (globalThis as any).appStartTime || 0,
    }));
  }

  private parseBody(req: any): Promise<any> {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (chunk: any) => { data += chunk; });
      req.on('end', () => {
        try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('Invalid JSON')); }
      });
      req.on('error', reject);
    });
  }

  private setupShutdownHandlers(): void {
    const shutdown = async (signal: string) => {
      if (this.isShuttingDown) return;
      this.isShuttingDown = true;
      logger.info({ signal }, 'Shutting down...');

      try {
        withdrawalQueue.stop();
        await watcherService.stop();

        if (this.server) {
          await new Promise<void>((resolve) => {
            this.server!.close(() => resolve());
          });
        }

        await closePool();
        logger.info('Shutdown complete');
        process.exit(0);
      } catch (err) {
        logger.error({ err }, 'Shutdown error');
        process.exit(1);
      }
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  }
}

// Start the application
const app = new Application();
(globalThis as any).appStartTime = Date.now();

app.start().catch((err) => {
  logger.fatal({ err }, 'Failed to start application');
  process.exit(1);
});

export { Application };