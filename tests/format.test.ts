import { describe, expect, it } from 'vitest';
import { Account } from '../src/core/types.js';
import {
  formatAccountShort,
  formatAuthType,
  formatStatus,
  formatTimeAgo,
} from '../src/ui/format.js';

describe('UI Formatting Helpers', () => {
  it('formats auth types with proper labels', () => {
    expect(formatAuthType('api-key')).toContain('API Key');
    expect(formatAuthType('oauth')).toContain('OAuth');
    expect(formatAuthType('service-account')).toContain('Service Account');
    expect(formatAuthType('adc')).toContain('ADC');
  });

  it('formats account statuses with color highlights', () => {
    expect(formatStatus('valid')).toContain('valid');
    expect(formatStatus('expired')).toContain('expired');
    expect(formatStatus('invalid')).toContain('invalid');
    expect(formatStatus('rate-limited')).toContain('rate-limited');
    expect(formatStatus('unverified', true)).toBe('unverified');
    expect(formatStatus('unverified', false)).toContain('unverified');
    expect(formatStatus('unknown')).toContain('unknown');
  });

  it('formats relative timestamps accurately', () => {
    const now = Date.now();
    expect(formatTimeAgo()).toBe('-');
    expect(formatTimeAgo(0)).toBe('-');
    expect(formatTimeAgo(now - 10_000)).toBe('just now');
    expect(formatTimeAgo(now - 120_000)).toBe('2m ago');
    expect(formatTimeAgo(now - 7_200_000)).toBe('2h ago');
    expect(formatTimeAgo(now - 172_800_000)).toBe('2d ago');
    expect(formatTimeAgo(now + 100_000)).toBe('just now');
  });

  it('formats account short representations', () => {
    const accountWithAlias: Account = {
      id: 'acc_123',
      email: 'user@example.com',
      alias: 'my-alias',
      authType: 'api-key',
      status: 'valid',
      createdAt: 1000,
      updatedAt: 1000,
    };
    expect(formatAccountShort(accountWithAlias)).toBe('my-alias (user@example.com)');

    const accountWithoutAlias: Account = {
      ...accountWithAlias,
      alias: undefined,
    };
    expect(formatAccountShort(accountWithoutAlias)).toBe('user@example.com');
  });
});
