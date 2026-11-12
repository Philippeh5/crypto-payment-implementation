import { createPublicClient, http, webSocket, fallback, type PublicClient, type Transport, type Chain } from 'viem';
import { getConfig } from '../../config.js';
import pino from 'pino';

const logger = pino({ name: 'rpc-client' });

const config = getConfig();

// Base Sepolia chain definition
export const baseSepoliaChain: Chain = {
  id: 84532,
  name: 'Base Sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: [config.RPC_URL] },
    public: { http: [config.RPC_URL] },
  },
  blockExplorers: {
    default: { name: 'BaseScan', url: 'https://sepolia.basescan.org' },
  },
  testnet: true,
};

// Build transport with fallback
function buildTransports(): Transport[] {
  const transports: Transport[] = [http(config.RPC_URL)];

  if (config.RPC_FALLBACK_URLS.length > 0) {
    for (const url of config.RPC_FALLBACK_URLS) {
      transports.push(http(url));
    }
  }

  // Try WebSocket if URL looks like WS
  const wsUrl = config.RPC_URL.replace('https://', 'wss://').replace('http://', 'ws://');
  if (wsUrl !== config.RPC_URL) {
    transports.unshift(webSocket(wsUrl));
  }

  return transports;
}

/**
 * Create a public Viem client with fallback transports.
 */
export function createRpcClient(): PublicClient {
  return createPublicClient({
    chain: baseSepoliaChain,
    transport: fallback(buildTransports()),
    pollingInterval: 2000, // 2s polling fallback
  });
}

let clientInstance: PublicClient | null = null;

export function getRpcClient(): PublicClient {
  if (!clientInstance) {
    clientInstance = createRpcClient();
    logger.info('RPC client initialized with fallback transports');
  }
  return clientInstance;
}

export function resetRpcClient(): void {
  clientInstance = null;
}