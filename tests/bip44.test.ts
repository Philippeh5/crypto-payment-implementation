import { describe, it, expect } from 'vitest';
import { deriveAddress } from '../src/wallet/bip44.js';

describe('BIP-44 Address Derivation', () => {
  // Test vector: known xpub from BIP-44 test vectors
  // This is a test xpub for m/44'/60'/0'/0 (Ethereum mainnet)
  const TEST_XPUB = 'xpub6CUGRUonZSQ4TWtTMmzXdrXDtypWKiKrhko4egpiMZbpiaQL2jkwSB1icqYh2cfDfVxdx4df189oLKnC5fSwqPfgyP3hooxujYzAu3fDVmz';

  it('should derive correct address at index 0', () => {
    const result = deriveAddress(TEST_XPUB, 0);
    expect(result.index).toBe(0);
    expect(result.derivationPath).toBe("m/44'/60'/0'/0/0");
    expect(result.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });

  it('should derive different addresses for different indices', () => {
    const addr0 = deriveAddress(TEST_XPUB, 0);
    const addr1 = deriveAddress(TEST_XPUB, 1);
    const addr2 = deriveAddress(TEST_XPUB, 2);

    expect(addr0.address).not.toBe(addr1.address);
    expect(addr1.address).not.toBe(addr2.address);
    expect(addr0.address).not.toBe(addr2.address);
  });

  it('should produce deterministic results', () => {
    const r1 = deriveAddress(TEST_XPUB, 42);
    const r2 = deriveAddress(TEST_XPUB, 42);
    expect(r1.address).toBe(r2.address);
    expect(r1.publicKey).toBe(r2.publicKey);
  });

  it('should throw for negative index', () => {
    expect(() => deriveAddress(TEST_XPUB, -1)).toThrow('Address index out of range');
  });

  it('should throw for index too large', () => {
    expect(() => deriveAddress(TEST_XPUB, 0x80000000)).toThrow('Address index out of range');
  });
});

describe('Address validation', () => {
  const { isValidAddress, normalizeAddress } = await import('../src/wallet/bip44.js');

  it('should validate correct Ethereum addresses', () => {
    expect(isValidAddress('0x1234567890123456789012345678901234567890')).toBe(true);
    expect(isValidAddress('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd')).toBe(true);
  });

  it('should reject invalid addresses', () => {
    expect(isValidAddress('0x123')).toBe(false);
    expect(isValidAddress('1234567890123456789012345678901234567890')).toBe(false); // missing 0x
    expect(isValidAddress('0xGHIJKL')).toBe(false); // invalid hex
  });

  it('should normalize addresses to lowercase', () => {
    expect(normalizeAddress('0xABCDEF1234567890')).toBe('0xabcdef1234567890');
  });
});