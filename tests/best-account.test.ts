import { describe, expect, it } from 'vitest';
import { chooseBestAccount } from '../src/core/best-account.js';
import { Account, RateLimitWindow } from '../src/core/types.js';

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

function hoursFromNow(hours: number): number {
  return Math.floor((NOW + hours * HOUR) / 1000);
}

/** One model family's pair of windows, stated as the share still unspent. */
function family(
  remaining5h: number,
  remainingWeekly: number,
  weeklyResetHours: number,
  fiveHourResetHours = 3
): { rate5h: RateLimitWindow; rateWeekly: RateLimitWindow } {
  return {
    rate5h: {
      usedPercent: 100 - remaining5h * 100,
      windowMinutes: 300,
      resetsAt: hoursFromNow(fiveHourResetHours),
    },
    rateWeekly: {
      usedPercent: 100 - remainingWeekly * 100,
      windowMinutes: 10_080,
      resetsAt: hoursFromNow(weeklyResetHours),
    },
  };
}

function account(id: string, overrides: Partial<Account> = {}): Account {
  return {
    id,
    email: `${id}@example.com`,
    authType: 'oauth',
    status: 'valid',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('choosing the account that wastes the least quota', () => {
  it('prefers the equal account whose weekly allowance expires first', () => {
    const later = account('later', { rateLimit: { gemini: family(1, 1, 72) } });
    const sooner = account('sooner', { rateLimit: { gemini: family(1, 1, 24) } });

    const choice = chooseBestAccount([later, sooner], null, NOW);

    expect(choice.best?.account.id).toBe('sooner');
    expect(choice.ranked.map((entry) => entry.account.id)).toEqual(['sooner', 'later']);
  });

  it('does not chase a deadline with nothing left behind it', () => {
    // Expires within the hour but only 1% is unspent: there is nothing to save.
    const nearlyEmpty = account('nearly-empty', { rateLimit: { gemini: family(1, 0.01, 1) } });
    const full = account('full', { rateLimit: { gemini: family(1, 1, 168) } });

    const choice = chooseBestAccount([nearlyEmpty, full], null, NOW);

    expect(choice.best?.account.id).toBe('full');
  });

  it('skips an account with no room to work this window, however urgent its week', () => {
    const urgentButSpent = account('spent', { rateLimit: { gemini: family(0.05, 1, 12) } });
    const roomy = account('roomy', { rateLimit: { gemini: family(1, 0.5, 168) } });

    const choice = chooseBestAccount([urgentButSpent, roomy], null, NOW);

    expect(choice.best?.account.id).toBe('roomy');
    expect(choice.ranked.find((e) => e.account.id === 'spent')?.blocked).toBe(
      '5-hour limit nearly spent'
    );
  });

  it('scores both model families together', () => {
    const halfSpent = account('half-spent', {
      rateLimit: { gemini: family(1, 1, 24), claude: family(1, 0.02, 24) },
    });
    const bothFull = account('both-full', {
      rateLimit: { gemini: family(1, 1, 24), claude: family(1, 1, 24) },
    });

    const choice = chooseBestAccount([halfSpent, bothFull], null, NOW);

    expect(choice.ranked.map((e) => e.account.id)).toEqual(['both-full', 'half-spent']);
  });

  it('excludes accounts that cannot be used until the user acts', () => {
    const expired = account('expired', {
      status: 'expired',
      rateLimit: { gemini: family(1, 1, 1) },
    });
    const apiKey = account('api', { authType: 'api-key', credentials: { apiKey: 'AIzaSyKey' } });
    const usable = account('usable', { rateLimit: { gemini: family(1, 1, 168) } });

    const choice = chooseBestAccount([expired, apiKey, usable], null, NOW);

    expect(choice.best?.account.id).toBe('usable');
    const blocked = new Map(choice.ranked.map((e) => [e.account.id, e.blocked]));
    expect(blocked.get('expired')).toBe('needs a fresh sign-in');
    expect(blocked.get('api')).toBe('not an OAuth account');
  });

  it('treats a window past its reset as no reading rather than a full one', () => {
    const elapsed = account('elapsed', { rateLimit: { gemini: family(1, 1, 168, -1) } });

    const choice = chooseBestAccount([elapsed], null, NOW);

    expect(choice.best).toBeNull();
    expect(choice.ranked[0].blocked).toBe('no current quota reading');
    expect(choice.shouldSwitch).toBe(false);
  });

  it('records which families a headroom figure was averaged over', () => {
    // Only Gemini reported. Averaging over it alone yields a full 5-hour
    // headroom, which read as a statement about the whole account.
    const geminiOnly = account('gemini-only', { rateLimit: { gemini: family(1, 1, 72) } });
    const bothFamilies = account('both', {
      rateLimit: { gemini: family(1, 1, 72), claude: family(0.5, 1, 72) },
    });

    const partial = chooseBestAccount([geminiOnly], 'gemini-only', NOW).ranked[0];
    expect(partial.headroom).toBe(1);
    expect(partial.families).toEqual(['gemini']);

    const full = chooseBestAccount([bothFamilies], 'both', NOW).ranked[0];
    expect(full.families).toEqual(['gemini', 'claude']);
  });

  it('reports when every account is out of 5-hour quota, and when each refills', () => {
    const drained = account('drained', { rateLimit: { gemini: family(0, 1, 72, 2) } });

    const choice = chooseBestAccount([drained], 'drained', NOW);

    expect(choice.best).toBeNull();
    expect(choice.ranked[0].refillsAt).toBe(hoursFromNow(2));
  });

  it('stays put unless a candidate is clearly better than the account in use', () => {
    const active = account('active', { rateLimit: { gemini: family(1, 0.98, 24) } });
    const marginal = account('marginal', { rateLimit: { gemini: family(1, 1, 24) } });

    expect(chooseBestAccount([active, marginal], 'active', NOW)).toMatchObject({
      shouldSwitch: false,
    });

    const clearlyBetter = account('better', { rateLimit: { gemini: family(1, 1, 24) } });
    const weak = account('weak', { rateLimit: { gemini: family(1, 0.5, 24) } });

    expect(chooseBestAccount([weak, clearlyBetter], 'weak', NOW)).toMatchObject({
      shouldSwitch: true,
    });
  });

  it('never proposes switching to the account already in use', () => {
    const best = account('best', { rateLimit: { gemini: family(1, 1, 24) } });
    const other = account('other', { rateLimit: { gemini: family(1, 1, 168) } });

    const choice = chooseBestAccount([best, other], 'best', NOW);

    expect(choice.best?.account.id).toBe('best');
    expect(choice.shouldSwitch).toBe(false);
  });
});
