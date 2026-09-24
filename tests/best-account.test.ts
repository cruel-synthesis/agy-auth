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

/** A family that reports its 5-hour window and nothing about the week. */
function fiveHourOnly(remaining5h: number): RateLimitWindow {
  return {
    usedPercent: 100 - remaining5h * 100,
    windowMinutes: 300,
    resetsAt: hoursFromNow(3),
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

  it('does not rewrite the session on the strength of an unread weekly window', () => {
    // `inUse` has a measured week with little left to lose; `unread` reports no
    // weekly window at all and is scored as an untouched one, which ranks it far
    // higher. That lead is an assumption, not a reading.
    const inUse = account('in-use', { rateLimit: { gemini: family(1, 0.2, 168) } });
    const unread = account('unread', { rateLimit: { gemini: { rate5h: fiveHourOnly(1) } } });

    const choice = chooseBestAccount([inUse, unread], 'in-use', NOW);

    // Both measured the same 5-hour headroom, which is all there is to compare.
    expect(choice.basis).toBe('headroom');
    expect(choice.shouldSwitch).toBe(false);
  });

  it('sends an exhausted account to the best measured headroom, not the best guess', () => {
    const spent = account('spent', { rateLimit: { gemini: family(0.05, 1, 168) } });
    const guessed = account('guessed', { rateLimit: { gemini: { rate5h: fiveHourOnly(0.95) } } });
    const measured = account('measured', { rateLimit: { gemini: family(0.99, 0.3, 168) } });

    const choice = chooseBestAccount([spent, guessed, measured], 'spent', NOW);
    const scoreOf = (id: string) =>
      choice.ranked.find((entry) => entry.account.id === id)?.score ?? 0;

    // The assumed untouched week wins on score, so an exhausted account in use
    // must not be a licence to act on it.
    expect(scoreOf('guessed')).toBeGreaterThan(scoreOf('measured'));
    expect(choice.basis).toBe('headroom');
    expect(choice.best?.account.id).toBe('measured');
    expect(choice.shouldSwitch).toBe(true);
  });

  it('applies the same measured comparison when no account is in use', () => {
    const guessed = account('guessed', { rateLimit: { gemini: { rate5h: fiveHourOnly(0.95) } } });
    const measured = account('measured', { rateLimit: { gemini: family(0.99, 0.3, 168) } });

    const choice = chooseBestAccount([guessed, measured], null, NOW);

    expect(choice.basis).toBe('headroom');
    expect(choice.best?.account.id).toBe('measured');
    expect(choice.shouldSwitch).toBe(true);
  });

  it('does not let the account that tops the score hide a usable alternative', () => {
    const inUse = account('in-use', { rateLimit: { gemini: family(0.6, 0.2, 168) } });
    // Half measured, half assumed: it tops the score on a week nobody read.
    const mixed = account('mixed', {
      rateLimit: { gemini: family(0.7, 0.2, 168), claude: { rate5h: fiveHourOnly(0.7) } },
    });
    const spare = account('spare', { rateLimit: { gemini: family(0.9, 0.1, 168) } });

    const choice = chooseBestAccount([inUse, mixed, spare], 'in-use', NOW);
    const topScore = [...choice.ranked].sort((a, b) => b.score - a.score)[0];

    expect(topScore.account.id).toBe('mixed');
    expect(topScore.weeklyBasis).toBe('mixed');
    // Refusing to act on `mixed` must not mean staying on an account that
    // `spare` beats on measured headroom alone.
    expect(choice.ranked[0].account.id).toBe('spare');
    expect(choice.best?.account.id).toBe('spare');
    expect(choice.shouldSwitch).toBe(true);
  });

  it('does not rewrite the session when one family of the candidate went unread', () => {
    // `candidate` reports both Gemini windows and only Claude's 5-hour one, so
    // half its score rests on an assumed untouched Claude week. Its Gemini
    // week is measured, which is all `perishing` ever spoke for.
    const inUse = account('in-use', {
      rateLimit: { gemini: family(1, 0.2, 168), claude: family(1, 0.2, 168) },
    });
    const candidate = account('candidate', {
      rateLimit: { gemini: family(1, 0.3, 168), claude: { rate5h: fiveHourOnly(1) } },
    });

    const choice = chooseBestAccount([inUse, candidate], 'in-use', NOW);

    expect(choice.best?.account.id).toBe('candidate');
    expect(choice.best?.perishing?.measured).toBe(true);
    expect(choice.best?.weeklyBasis).toBe('mixed');
    expect(choice.ranked.find((entry) => entry.account.id === 'in-use')?.weeklyBasis).toBe(
      'measured'
    );
    expect(choice.shouldSwitch).toBe(false);
  });

  it('moves between two accounts that both report every weekly window', () => {
    const inUse = account('in-use', {
      rateLimit: { gemini: family(1, 0.02, 168), claude: family(1, 0.02, 168) },
    });
    const candidate = account('candidate', {
      rateLimit: { gemini: family(1, 0.9, 24), claude: family(1, 0.9, 24) },
    });

    const choice = chooseBestAccount([inUse, candidate], 'in-use', NOW);

    expect(choice.best?.account.id).toBe('candidate');
    expect(choice.best?.weeklyBasis).toBe('measured');
    expect(choice.shouldSwitch).toBe(true);
  });

  it('still moves on measured headroom when neither side has a weekly reading', () => {
    // The same assumption on both sides cancels, so the comparison is between
    // two measured 5-hour windows and the switch rests on readings.
    const inUse = account('in-use', { rateLimit: { gemini: { rate5h: fiveHourOnly(0.2) } } });
    const roomier = account('roomier', { rateLimit: { gemini: { rate5h: fiveHourOnly(0.9) } } });

    const choice = chooseBestAccount([inUse, roomier], 'in-use', NOW);

    expect(choice.best?.account.id).toBe('roomier');
    expect(choice.shouldSwitch).toBe(true);
  });

  it('still moves off an account that cannot work, whatever the candidate reports', () => {
    const spent = account('spent', { rateLimit: { gemini: family(0.05, 1, 168) } });
    const unread = account('unread', { rateLimit: { gemini: { rate5h: fiveHourOnly(0.9) } } });

    const choice = chooseBestAccount([spent, unread], 'spent', NOW);

    expect(choice.ranked.find((entry) => entry.account.id === 'spent')?.blocked).toBe(
      '5-hour limit nearly spent'
    );
    expect(choice.best?.account.id).toBe('unread');
    expect(choice.shouldSwitch).toBe(true);
  });

  it('never proposes switching to the account already in use', () => {
    const best = account('best', { rateLimit: { gemini: family(1, 1, 24) } });
    const other = account('other', { rateLimit: { gemini: family(1, 1, 168) } });

    const choice = chooseBestAccount([best, other], 'best', NOW);

    expect(choice.best?.account.id).toBe('best');
    expect(choice.shouldSwitch).toBe(false);
  });

  it('does not rank a measured week that is all but spent on its 5-hour room', () => {
    // `unread` puts the choice on 5-hour headroom, which says nothing about the
    // week. `drained` would win there with 1% of its week left.
    const inUse = account('in-use', { rateLimit: { gemini: family(0.5, 0.8, 168) } });
    const unread = account('unread', { rateLimit: { gemini: { rate5h: fiveHourOnly(0.6) } } });
    const drained = account('drained', { rateLimit: { gemini: family(1, 0.01, 144) } });

    const choice = chooseBestAccount([inUse, unread, drained], 'in-use', NOW);
    const held = choice.ranked.find((entry) => entry.account.id === 'drained');

    expect(choice.basis).toBe('headroom');
    expect(held?.blocked).toBe('weekly limit nearly spent');
    expect(held?.refillsAt).toBe(hoursFromNow(144));
    expect(choice.best?.account.id).not.toBe('drained');
    expect(choice.shouldSwitch).toBe(true);
    expect(choice.best?.account.id).toBe('unread');
  });

  it('still spends the last of a measured week that resets soon', () => {
    // Every week was read, so the score decides, and a small week about to
    // reset is exactly the quota most likely to be wasted.
    const later = account('later', { rateLimit: { gemini: family(1, 0.5, 168) } });
    const closing = account('closing', { rateLimit: { gemini: family(1, 0.08, 1) } });

    const choice = chooseBestAccount([later, closing], 'later', NOW);

    expect(choice.basis).toBe('weekly');
    expect(choice.best?.account.id).toBe('closing');
    expect(choice.shouldSwitch).toBe(true);
  });

  it('blocks an account whose week is spent, and dates it by the weekly reset', () => {
    const spentWeek = account('spent-week', { rateLimit: { gemini: family(0.9, 0, 48, 2) } });

    const choice = chooseBestAccount([spentWeek], null, NOW);

    expect(choice.best).toBeNull();
    expect(choice.ranked[0].blocked).toBe('weekly limit nearly spent');
    expect(choice.ranked[0].refillsAt).toBe(hoursFromNow(48));
  });
});
