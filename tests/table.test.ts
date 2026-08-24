import stringWidth from 'string-width';
import { describe, expect, it } from 'vitest';
import { Account } from '../src/core/types.js';
import {
  getTableComponents,
  pad,
  renderAccountsTable,
  renderSelectMenu,
  truncateAccount,
  truncateToWidth,
} from '../src/ui/table.js';

describe('Table & TUI presentation', () => {
  const sampleAccounts: Account[] = [
    {
      id: 'acc_1',
      email: 'alice@example.com',
      alias: 'alice-work',
      authType: 'oauth',
      status: 'valid',
      gcpProject: 'my-gcp-project',
      createdAt: Date.now() - 3600 * 1000,
      updatedAt: Date.now() - 3600 * 1000,
      lastUsedAt: Date.now() - 60 * 1000,
    },
    {
      id: 'acc_2',
      email: 'bob@example.com',
      authType: 'api-key',
      status: 'rate-limited',
      createdAt: Date.now() - 86400 * 1000,
      updatedAt: Date.now() - 86400 * 1000,
    },
    {
      id: 'acc_3',
      email: 'cjk@example.com',
      alias: '日本語テスト',
      authType: 'api-key',
      status: 'valid',
      createdAt: Date.now() - 86400 * 1000,
      updatedAt: Date.now() - 86400 * 1000,
    },
  ];

  it('pads and truncates strings accurately across wide and CJK characters', () => {
    expect(pad('test', 8)).toBe('test    ');
    expect(truncateToWidth('hello world', 8)).toBe('hello w.');
    expect(truncateAccount('user@example.com', 10)).toBe('user@exam.');

    // CJK 2-column character truncation
    const cjk = '日本語テストアカウント';
    const truncatedCjk = truncateToWidth(cjk, 8);
    expect(stringWidth(truncatedCjk)).toBeLessThanOrEqual(8);
  });

  it('renders the wide plan and quota layout', () => {
    const table = renderAccountsTable(sampleAccounts, 'acc_1', 140);
    for (const header of [
      'ACCOUNT',
      'PLAN',
      'GEMINI 5H',
      'GEMINI WK',
      'CLAUDE 5H',
      'CLAUDE WK',
      'LAST',
    ]) {
      expect(table).toContain(header);
    }
    expect(table).toContain('alice-work (alice@example.com)');
    expect(table).toContain('* 01');
    expect(table).toContain('02');
  });

  it('enforces maximum width bounds for widths >= 20 without line wrapping', () => {
    const widthsToTest = [20, 24, 30, 40, 80, 120];

    for (const width of widthsToTest) {
      const components = getTableComponents(sampleAccounts, 'acc_1', width);
      const headerWidth = stringWidth(components.headerLine);
      const dividerWidth = stringWidth(components.dividerLine);

      expect(headerWidth).toBeLessThanOrEqual(width);
      expect(dividerWidth).toBeLessThanOrEqual(width);

      for (const row of components.rows) {
        const rowWidth = stringWidth(row.coloredText);
        expect(rowWidth).toBeLessThanOrEqual(width);
      }
    }
  });

  it('renders interactive selection menu with ASCII navigation hints and active indicators', () => {
    const menu = renderSelectMenu(sampleAccounts, 'acc_1', 1, '', 'Select profile:', 100);
    expect(menu).toContain('Select profile:');
    expect(menu).toContain('Up/Down or j/k; Enter; Esc/q');
    expect(menu).toContain('* 01'); // active item
    expect(menu).toContain('> 02'); // selected item
  });
});
