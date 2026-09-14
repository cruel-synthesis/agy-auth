import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ANTIGRAVITY_OAUTH_CLIENT, getOAuthClientConfig } from '../src/core/oauth-config.js';
import { applyCheckResults, applyQuotaResult, applyQuotaResults } from '../src/core/quota-apply.js';
import {
  QUOTA_REFRESH_CONCURRENCY,
  QuotaClient,
  QuotaRefresh,
  TokenUpdate,
  collectFromBuckets,
  collectFromSummary,
  summarizeQuotaRefresh,
} from '../src/core/quota.js';
import { RegistryManager } from '../src/core/registry.js';
import { Account, Registry } from '../src/core/types.js';
import { VerificationResult, Verifier } from '../src/core/verifier.js';
import { blockingStatusLabel, formatQuotaCell, quotaSummaryLines } from '../src/ui/format.js';
import { renderAccountsTable } from '../src/ui/table.js';
import { TestEnv, setupTestEnvironment } from './test-utils.js';

const FUTURE_RESET = 4_102_444_800; // 2100-01-01T00:00:00Z
const PAST_RESET = 1_000_000_000; // 2001-09-09T01:46:40Z

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;

interface MockFetch {
  fetchFn: typeof fetch;
  calls: string[];
}

/** Substring-routed fetch double. Unmatched URLs answer HTTP 404. */
function mockFetch(routes: Record<string, Route>): MockFetch {
  const calls: string[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    for (const [needle, route] of Object.entries(routes)) {
      if (url.includes(needle)) return route(url, init);
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

function oauthAccount(overrides: Partial<Account> = {}): Account {
  const now = Date.now();
  return {
    id: 'acc1',
    email: 'user@example.com',
    authType: 'oauth',
    status: 'unverified',
    credentials: {
      keychainPayload: {
        auth_method: 'consumer',
        token: {
          access_token: 'synthetic-access-token',
          refresh_token: 'synthetic-refresh-token',
          token_type: 'Bearer',
          expiry: new Date(now + 3_600_000).toISOString(),
        },
      },
    },
    createdAt: now - 86_400_000,
    updatedAt: now - 86_400_000,
    ...overrides,
  };
}

const SUMMARY_OK = {
  groups: [
    {
      displayName: 'Gemini models',
      buckets: [
        {
          bucketId: 'gemini-5h',
          window: '5h',
          remainingFraction: 0.5,
          resetTime: '2100-01-01T00:00:00Z',
        },
        { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.25 },
      ],
    },
    {
      displayName: 'Claude models',
      buckets: [{ bucketId: 'claude-5h', window: '5h', remainingFraction: 0.9 }],
    },
  ],
};

const CODE_ASSIST_OK = {
  currentTier: { id: 'free', name: 'Google AI Free' },
  paidTier: { id: 'ultra', name: 'Google AI Ultra' },
  cloudaicompanionProject: 'discovered-project',
};

describe('Quota client contracts', () => {
  it('parses Contract A and reports plan plus discovered project', async () => {
    const { fetchFn, calls } = mockFetch({
      retrieveUserQuotaSummary: () => jsonResponse(SUMMARY_OK),
      loadCodeAssist: () => jsonResponse(CODE_ASSIST_OK),
    });

    const { result } = await QuotaClient.refreshAccountQuota(oauthAccount(), { fetchFn });

    expect(result.ok).toBe(true);
    expect(result.status).toBe('valid');
    expect(result.plan).toBe('Google AI Ultra');
    expect(result.discoveredProject).toBe('discovered-project');
    expect(result.rateLimit?.gemini?.rate5h).toEqual({
      usedPercent: 50,
      windowMinutes: 300,
      resetsAt: FUTURE_RESET,
    });
    expect(result.rateLimit?.gemini?.rateWeekly?.usedPercent).toBe(75);
    expect(result.rateLimit?.claude?.rate5h?.usedPercent).toBe(10);
    expect(result.quotaCheckedAt).toBeGreaterThan(0);
    // Contract B must not be consulted once Contract A produced usable windows.
    expect(calls.some((c) => c.includes(':retrieveUserQuota') && !c.includes('Summary'))).toBe(
      false
    );
  });

  it('falls back to Contract B with a discovered project when Contract A is unusable', async () => {
    const { fetchFn, calls } = mockFetch({
      retrieveUserQuotaSummary: () => jsonResponse({ groups: [] }),
      loadCodeAssist: () => jsonResponse(CODE_ASSIST_OK),
      ':retrieveUserQuota': (_url, init) => {
        expect(JSON.parse(String(init?.body))).toEqual({ project: 'discovered-project' });
        return jsonResponse({
          buckets: [
            { modelId: 'claude-sonnet-4-6', tokenType: 'weekly', remainingFraction: 0.2 },
            { modelId: 'gemini-3-flash', tokenType: '5h', remaining_fraction: 0.6 },
          ],
        });
      },
    });

    const { result } = await QuotaClient.refreshAccountQuota(oauthAccount(), { fetchFn });

    expect(result.ok).toBe(true);
    expect(result.rateLimit?.claude?.rateWeekly?.usedPercent).toBe(80);
    expect(result.rateLimit?.gemini?.rate5h?.usedPercent).toBe(40);
    expect(result.discoveredProject).toBe('discovered-project');
    expect(
      calls.filter((c) => c.includes(':retrieveUserQuota') && !c.includes('Summary'))
    ).toHaveLength(1);
  });

  it('tries the mirror host when the first endpoint fails with 5xx', async () => {
    let summaryAttempts = 0;
    const { fetchFn } = mockFetch({
      retrieveUserQuotaSummary: () => {
        summaryAttempts++;
        return summaryAttempts === 1
          ? new Response('boom', { status: 503 })
          : jsonResponse(SUMMARY_OK);
      },
      loadCodeAssist: () => jsonResponse(CODE_ASSIST_OK),
    });

    const { result } = await QuotaClient.refreshAccountQuota(oauthAccount(), { fetchFn });
    expect(summaryAttempts).toBe(2);
    expect(result.ok).toBe(true);
  });

  it('never invents a project when discovery yields none and the profile has none', async () => {
    const { fetchFn, calls } = mockFetch({
      retrieveUserQuotaSummary: () => jsonResponse({ groups: [] }),
      loadCodeAssist: () => jsonResponse({ currentTier: { name: 'Google AI Pro' } }),
    });

    const { result } = await QuotaClient.refreshAccountQuota(oauthAccount(), { fetchFn });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('quota-unavailable');
    expect(result.plan).toBe('Google AI Pro');
    expect(result.discoveredProject).toBeUndefined();
    expect(calls.some((c) => c.includes(':retrieveUserQuota') && !c.includes('Summary'))).toBe(
      false
    );
  });

  it('uses the configured project when discovery reports none', async () => {
    let requestedProject: string | undefined;
    const { fetchFn } = mockFetch({
      retrieveUserQuotaSummary: () => jsonResponse({ groups: [] }),
      loadCodeAssist: () => jsonResponse({}),
      ':retrieveUserQuota': (_url, init) => {
        requestedProject = JSON.parse(String(init?.body)).project;
        return jsonResponse({
          buckets: [{ modelId: 'gemini-3-pro', tokenType: '5h', remainingFraction: 0.3 }],
        });
      },
    });

    const { result } = await QuotaClient.refreshAccountQuota(
      oauthAccount({ gcpProject: 'user-project' }),
      { fetchFn }
    );

    expect(requestedProject).toBe('user-project');
    expect(result.ok).toBe(true);
    expect(result.discoveredProject).toBeUndefined();
  });

  it('does not overwrite a user-configured project with a discovered one', async () => {
    const { fetchFn } = mockFetch({
      retrieveUserQuotaSummary: () => jsonResponse(SUMMARY_OK),
      loadCodeAssist: () => jsonResponse(CODE_ASSIST_OK),
    });

    const { result } = await QuotaClient.refreshAccountQuota(
      oauthAccount({ gcpProject: 'user-project' }),
      { fetchFn }
    );

    expect(result.ok).toBe(true);
    expect(result.discoveredProject).toBeUndefined();
  });

  it('skips non-OAuth profiles without any request', async () => {
    const { fetchFn, calls } = mockFetch({});
    const { result } = await QuotaClient.refreshAccountQuota(
      { ...oauthAccount(), authType: 'api-key', credentials: { apiKey: 'k' } },
      { fetchFn }
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('not-applicable');
    expect(calls).toHaveLength(0);
  });

  it('reports not-applicable for an OAuth profile with no access token', async () => {
    const { fetchFn, calls } = mockFetch({});
    const { result } = await QuotaClient.refreshAccountQuota(
      { ...oauthAccount(), credentials: undefined },
      { fetchFn }
    );
    expect(result.reason).toBe('not-applicable');
    expect(calls).toHaveLength(0);
  });
});

describe('Quota payload validation', () => {
  it('aggregates multiple buckets per family and window to the most constrained', () => {
    const candidates = collectFromBuckets({
      buckets: [
        {
          modelId: 'gemini-3-flash',
          tokenType: '5h',
          remainingFraction: 0.8,
          resetTime: '2100-01-01T02:00:00Z',
        },
        {
          modelId: 'gemini-3-pro',
          tokenType: '5h',
          remainingFraction: 0.2,
          resetTime: '2100-01-01T03:00:00Z',
        },
        {
          modelId: 'gemini-3-pro-low',
          tokenType: '5h',
          remainingFraction: 0.2,
          resetTime: '2100-01-01T01:00:00Z',
        },
      ],
    });
    expect(candidates).toHaveLength(3);

    const snapshot = collectFromBuckets({
      buckets: [
        { modelId: 'gemini-3-flash', tokenType: '5h', remainingFraction: 0.8 },
        { modelId: 'gemini-3-pro', tokenType: '5h', remainingFraction: 0.2 },
      ],
    });
    expect(snapshot.map((c) => c.usedPercent).sort((a, b) => a - b)).toEqual([20, 80]);
  });

  it('accepts the snake-case Contract B fields as one consistent shape', () => {
    const [candidate] = collectFromBuckets({
      buckets: [
        {
          model_id: 'gemini-3-pro-5h',
          remaining_fraction: 0.25,
          reset_time: '2100-01-01T00:00:00Z',
        },
      ],
    });

    expect(candidate).toMatchObject({
      family: 'gemini',
      window: '5h',
      usedPercent: 75,
      resetsAt: FUTURE_RESET,
    });
  });

  it('selects highest usage and earliest reset deterministically', async () => {
    const { fetchFn } = mockFetch({
      retrieveUserQuotaSummary: () => jsonResponse({ groups: [] }),
      loadCodeAssist: () => jsonResponse({}),
      ':retrieveUserQuota': () =>
        jsonResponse({
          buckets: [
            {
              modelId: 'gemini-a',
              tokenType: '5h',
              remainingFraction: 0.7,
              resetTime: '2100-01-01T05:00:00Z',
            },
            {
              modelId: 'gemini-b',
              tokenType: '5h',
              remainingFraction: 0.1,
              resetTime: '2100-01-01T04:00:00Z',
            },
            {
              modelId: 'gemini-c',
              tokenType: '5h',
              remainingFraction: 0.1,
              resetTime: '2100-01-01T02:00:00Z',
            },
          ],
        }),
    });

    const { result } = await QuotaClient.refreshAccountQuota(oauthAccount({ gcpProject: 'p' }), {
      fetchFn,
    });

    expect(result.rateLimit?.gemini?.rate5h?.usedPercent).toBe(90);
    expect(result.rateLimit?.gemini?.rate5h?.resetsAt).toBe(
      Math.floor(Date.parse('2100-01-01T02:00:00Z') / 1000)
    );
  });

  it('rejects invalid fractions, unknown windows, and ambiguous families', () => {
    expect(
      collectFromBuckets({
        buckets: [
          { modelId: 'gemini-3-pro', tokenType: '5h', remainingFraction: 1.5 },
          { modelId: 'gemini-3-pro', tokenType: '5h', remainingFraction: -0.2 },
          { modelId: 'gemini-3-pro', tokenType: '5h', remainingFraction: Number.NaN },
          { modelId: 'gemini-3-pro', tokenType: '5h', remainingFraction: 'half' },
          { modelId: 'gemini-3-pro', tokenType: 'monthly', remainingFraction: 0.5 },
          { modelId: 'gemini-claude-hybrid', tokenType: '5h', remainingFraction: 0.5 },
          { modelId: 'unknown-model', tokenType: '5h', remainingFraction: 0.5 },
          'not-an-object',
        ],
      })
    ).toEqual([]);
  });

  it('rejects conflicting window labels within one bucket', () => {
    expect(
      collectFromSummary({
        groups: [
          {
            displayName: 'Gemini',
            buckets: [{ bucketId: 'gemini-weekly', window: '5h', remainingFraction: 0.5 }],
          },
        ],
      })
    ).toEqual([]);
  });

  it('drops invalid reset timestamps but keeps the window', () => {
    const [candidate] = collectFromSummary({
      groups: [
        {
          displayName: 'Gemini',
          buckets: [
            { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.5, resetTime: 'nonsense' },
          ],
        },
      ],
    });
    expect(candidate.usedPercent).toBe(50);
    expect(candidate.resetsAt).toBeUndefined();
  });

  it('treats a recognized response with no usable window as quota-unavailable', async () => {
    const { fetchFn } = mockFetch({
      retrieveUserQuotaSummary: () =>
        jsonResponse({ groups: [{ displayName: 'Mystery', buckets: [] }] }),
      loadCodeAssist: () => jsonResponse({}),
    });
    const { result } = await QuotaClient.refreshAccountQuota(oauthAccount(), { fetchFn });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('quota-unavailable');
    expect(result.status).toBeUndefined();
  });

  it('treats malformed JSON as a transport failure', async () => {
    const { fetchFn } = mockFetch({
      googleapis: () => new Response('<html>nope</html>', { status: 200 }),
    });
    const { result } = await QuotaClient.refreshAccountQuota(oauthAccount(), { fetchFn });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('network-error');
    expect(result.status).toBeUndefined();
  });
});

describe('Quota error policy', () => {
  it('maps HTTP 401 to expired', async () => {
    const { fetchFn } = mockFetch({ googleapis: () => new Response('{}', { status: 401 }) });
    const { result } = await QuotaClient.refreshAccountQuota(oauthAccount(), { fetchFn });
    expect(result.reason).toBe('auth-failed');
    expect(result.status).toBe('expired');
  });

  it('maps explicit insufficient-scope evidence to needs-reauth', async () => {
    const { fetchFn } = mockFetch({
      googleapis: () =>
        jsonResponse(
          {
            error: {
              status: 'PERMISSION_DENIED',
              details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }],
            },
          },
          403
        ),
    });
    const { result } = await QuotaClient.refreshAccountQuota(oauthAccount(), { fetchFn });
    expect(result.reason).toBe('scope-insufficient');
    expect(result.status).toBe('needs-reauth');
  });

  it('leaves status untouched for a generic 403', async () => {
    const { fetchFn } = mockFetch({
      googleapis: () => jsonResponse({ error: { status: 'PERMISSION_DENIED' } }, 403),
    });
    const { result } = await QuotaClient.refreshAccountQuota(oauthAccount(), { fetchFn });
    expect(result.reason).toBe('network-error');
    expect(result.status).toBeUndefined();
  });

  it.each([429, 500, 503])('leaves status untouched for HTTP %i', async (status) => {
    const { fetchFn } = mockFetch({ googleapis: () => new Response('{}', { status }) });
    const { result } = await QuotaClient.refreshAccountQuota(oauthAccount(), { fetchFn });
    expect(result.reason).toBe('network-error');
    expect(result.status).toBeUndefined();
  });

  it('reports quota-unavailable when the service answers but refuses the quota', async () => {
    // Shape observed live: loadCodeAssist answers 200 with allowedTiers and no
    // currentTier/paidTier/cloudaicompanionProject, while both quota contracts
    // answer 429. The service is plainly reachable, so calling this a network
    // error would misdescribe it.
    const { fetchFn } = mockFetch({
      retrieveUserQuotaSummary: () =>
        jsonResponse(
          {
            error: {
              code: 429,
              message: 'Resource has been exhausted.',
              status: 'RESOURCE_EXHAUSTED',
            },
          },
          429
        ),
      ':retrieveUserQuota': () =>
        jsonResponse(
          {
            error: {
              code: 429,
              message: 'Resource has been exhausted.',
              status: 'RESOURCE_EXHAUSTED',
            },
          },
          429
        ),
      loadCodeAssist: () =>
        jsonResponse({
          allowedTiers: [
            { id: 'standard-tier', name: 'Gemini Code Assist', isDefault: true, usesGcpTos: true },
          ],
          ineligibleTiers: [
            {
              reasonCode: 'UNSUPPORTED_CLIENT',
              tierId: 'free-tier',
              tierName: 'Gemini Code Assist for individuals',
            },
          ],
        }),
    });

    const account = oauthAccount({
      status: 'valid',
      gcpProject: 'user-project',
      plan: 'Cached Plan',
      rateLimit: { gemini: { rate5h: { usedPercent: 30, windowMinutes: 300 } } },
      quotaCheckedAt: 1_700_000_000_000,
    });
    const { result } = await QuotaClient.refreshAccountQuota(account, { fetchFn });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('quota-unavailable');
    // Neither the credential status nor the cached snapshot may be touched.
    expect(result.status).toBeUndefined();
    expect(result.rateLimit).toBeUndefined();
    expect(result.quotaCheckedAt).toBeUndefined();
    // An unrecognized tier shape yields no plan rather than a guessed one.
    expect(result.plan).toBeUndefined();
  });

  it('still reports network-error when nothing answers at all', async () => {
    const { fetchFn } = mockFetch({
      googleapis: () => {
        throw new Error('connection refused');
      },
    });
    const { result } = await QuotaClient.refreshAccountQuota(
      oauthAccount({ gcpProject: 'user-project' }),
      { fetchFn }
    );
    expect(result.reason).toBe('network-error');
  });

  it('bounds total time across endpoints when every request hangs', async () => {
    const fetchFn = ((_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;

    const startedAt = Date.now();
    const { result } = await QuotaClient.refreshAccountQuota(oauthAccount({ gcpProject: 'p' }), {
      fetchFn,
      deadlineMs: 250,
      requestTimeoutMs: 60,
    });
    const elapsed = Date.now() - startedAt;

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('network-error');
    // Six possible requests at 60ms each would exceed 300ms without the deadline.
    expect(elapsed).toBeLessThan(1_000);
  });
});

describe('Environment-gated OAuth refresh', () => {
  // This suite exercises the one provenance agy-auth may refresh itself.
  const expiredAccount = () =>
    oauthAccount({
      credentialSource: 'custom-client',
      credentials: {
        keychainPayload: {
          auth_method: 'consumer',
          token: {
            access_token: 'stale-access-token',
            refresh_token: 'synthetic-refresh-token',
            token_type: 'Bearer',
            expiry: new Date(Date.now() - 3_600_000).toISOString(),
          },
        },
      },
    });

  /** Still valid, but inside the five-minute early-refresh window. */
  const nearlyExpiredAccount = () =>
    oauthAccount({
      credentialSource: 'custom-client',
      credentials: {
        keychainPayload: {
          auth_method: 'consumer',
          token: {
            access_token: 'still-valid-access-token',
            refresh_token: 'synthetic-refresh-token',
            token_type: 'Bearer',
            expiry: new Date(Date.now() + 120_000).toISOString(),
          },
        },
      },
    });

  it('keeps using a token that is near expiry but cannot be refreshed early', async () => {
    const { fetchFn, calls } = mockFetch({
      retrieveUserQuotaSummary: () => jsonResponse(SUMMARY_OK),
      loadCodeAssist: () => jsonResponse(CODE_ASSIST_OK),
    });

    // No client id, so the early refresh cannot happen. The token has two
    // minutes of life left, which is not the same as being expired.
    const { result } = await QuotaClient.refreshAccountQuota(nearlyExpiredAccount(), {
      fetchFn,
      env: {},
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe('valid');
    expect(result.reason).toBeUndefined();
    expect(calls.some((url) => url.includes('retrieveUserQuotaSummary'))).toBe(true);
    // The early refresh was attempted and declined locally, not sent to Google.
    expect(calls.some((url) => url.includes('oauth2.googleapis.com'))).toBe(false);
  });

  it('still reports a genuinely expired token as expired', async () => {
    const { fetchFn } = mockFetch({});
    const { result } = await QuotaClient.refreshAccountQuota(expiredAccount(), {
      fetchFn,
      env: {},
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('token-expired');
    expect(result.status).toBe('expired');
  });

  it("renews an Antigravity session with Antigravity's client, never the configured one", async () => {
    let refreshBody = '';
    const { fetchFn, calls } = mockFetch({
      'oauth2.googleapis.com': (_url, init) => {
        refreshBody = String(init?.body ?? '');
        return jsonResponse({ access_token: 'renewed-access-token', expires_in: 1800 });
      },
      retrieveUserQuotaSummary: () => jsonResponse(SUMMARY_OK),
      loadCodeAssist: () => jsonResponse(CODE_ASSIST_OK),
    });

    const nativeAccount = oauthAccount({
      credentialSource: 'antigravity',
      credentials: {
        keychainPayload: {
          auth_method: 'consumer',
          token: {
            access_token: 'stale-access-token',
            refresh_token: 'antigravity-issued-refresh',
            token_type: 'Bearer',
            expiry: new Date(Date.now() - 3_600_000).toISOString(),
          },
        },
      },
    });

    const { result, tokenUpdate } = await QuotaClient.refreshAccountQuota(nativeAccount, {
      fetchFn,
      env: { AGY_OAUTH_CLIENT_ID: 'unrelated-client', AGY_OAUTH_CLIENT_SECRET: 'unrelated-secret' },
    });

    // The refresh token belongs to Antigravity's client, so only that client is
    // offered it, even though a different one is configured.
    expect(calls.some((url) => url.includes('oauth2.googleapis.com'))).toBe(true);
    expect(refreshBody).toContain(
      encodeURIComponent(ANTIGRAVITY_OAUTH_CLIENT.clientId).replace(/%20/g, '+')
    );
    expect(refreshBody).not.toContain('unrelated-client');
    expect(tokenUpdate).toBeDefined();
    expect(result.ok).toBe(true);
    expect(result.status).toBe('valid');
  });

  it('refreshes a custom-client account with the configured client', async () => {
    const { fetchFn, calls } = mockFetch({
      'oauth2.googleapis.com': () =>
        jsonResponse({ access_token: 'fresh-access-token', expires_in: 1800 }),
      retrieveUserQuotaSummary: () => jsonResponse(SUMMARY_OK),
      loadCodeAssist: () => jsonResponse(CODE_ASSIST_OK),
    });

    const customAccount = oauthAccount({
      credentialSource: 'custom-client',
      oauthClientId: 'env-client-id',
      credentials: {
        keychainPayload: {
          auth_method: 'consumer',
          token: {
            access_token: 'stale-access-token',
            refresh_token: 'custom-issued-refresh',
            token_type: 'Bearer',
            expiry: new Date(Date.now() - 3_600_000).toISOString(),
          },
        },
      },
    });

    const { result, tokenUpdate } = await QuotaClient.refreshAccountQuota(customAccount, {
      fetchFn,
      env: { AGY_OAUTH_CLIENT_ID: 'env-client-id', AGY_OAUTH_CLIENT_SECRET: 'env-secret' },
    });

    expect(calls.some((url) => url.includes('oauth2.googleapis.com'))).toBe(true);
    expect(tokenUpdate?.token.access_token).toBe('fresh-access-token');
    expect(result.ok).toBe(true);
  });

  it('declines to refresh when a different client is configured than the one that issued', async () => {
    const { fetchFn, calls } = mockFetch({
      'oauth2.googleapis.com': () =>
        jsonResponse({ access_token: 'should-never-be-issued', expires_in: 1800 }),
    });

    const customAccount = oauthAccount({
      credentialSource: 'custom-client',
      oauthClientId: 'client-that-issued',
      credentials: {
        keychainPayload: {
          auth_method: 'consumer',
          token: {
            access_token: 'stale-access-token',
            refresh_token: 'custom-issued-refresh',
            token_type: 'Bearer',
            expiry: new Date(Date.now() - 3_600_000).toISOString(),
          },
        },
      },
    });

    const { result } = await QuotaClient.refreshAccountQuota(customAccount, {
      fetchFn,
      env: { AGY_OAUTH_CLIENT_ID: 'a-completely-different-client' },
    });

    expect(calls.some((url) => url.includes('oauth2.googleapis.com'))).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.status).toBe('expired');
  });

  it('ships no OAuth client id or secret fallback', () => {
    expect(getOAuthClientConfig({})).toBeNull();
    expect(getOAuthClientConfig({ AGY_OAUTH_CLIENT_SECRET: 'only-a-secret' })).toBeNull();
    expect(getOAuthClientConfig({ AGY_OAUTH_CLIENT_ID: '  ' })).toBeNull();
    expect(getOAuthClientConfig({ AGY_OAUTH_CLIENT_ID: 'id-1' })).toEqual({ clientId: 'id-1' });
    expect(
      getOAuthClientConfig({ AGY_OAUTH_CLIENT_ID: 'id-1', AGY_OAUTH_CLIENT_SECRET: 's-1' })
    ).toEqual({ clientId: 'id-1', clientSecret: 's-1' });
  });

  it('reports expired without contacting Google when no client id is configured', async () => {
    const { fetchFn, calls } = mockFetch({});
    const { result, tokenUpdate } = await QuotaClient.refreshAccountQuota(expiredAccount(), {
      fetchFn,
      env: {},
    });

    expect(result.reason).toBe('token-expired');
    expect(result.status).toBe('expired');
    expect(tokenUpdate).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('refreshes with an environment client id and honours a rotated refresh token', async () => {
    let tokenBody = '';
    const { fetchFn } = mockFetch({
      'oauth2.googleapis.com': (_url, init) => {
        tokenBody = String(init?.body);
        return jsonResponse({
          access_token: 'fresh-access-token',
          refresh_token: 'rotated-refresh-token',
          token_type: 'Bearer',
          expires_in: 3600,
        });
      },
      retrieveUserQuotaSummary: (_url, init) => {
        expect((init?.headers as Record<string, string>).Authorization).toBe(
          'Bearer fresh-access-token'
        );
        return jsonResponse(SUMMARY_OK);
      },
      loadCodeAssist: () => jsonResponse(CODE_ASSIST_OK),
    });

    const { result, tokenUpdate } = await QuotaClient.refreshAccountQuota(expiredAccount(), {
      fetchFn,
      env: { AGY_OAUTH_CLIENT_ID: 'env-client-id', AGY_OAUTH_CLIENT_SECRET: 'env-secret' },
    });

    expect(result.ok).toBe(true);
    expect(tokenBody).toContain('client_id=env-client-id');
    expect(tokenBody).toContain('client_secret=env-secret');
    expect(tokenUpdate?.token.access_token).toBe('fresh-access-token');
    expect(tokenUpdate?.token.refresh_token).toBe('rotated-refresh-token');
  });

  it('keeps the existing refresh token when Google does not rotate it', async () => {
    const { fetchFn } = mockFetch({
      'oauth2.googleapis.com': () =>
        jsonResponse({ access_token: 'fresh-access-token', expires_in: 1800 }),
      retrieveUserQuotaSummary: () => jsonResponse(SUMMARY_OK),
      loadCodeAssist: () => jsonResponse(CODE_ASSIST_OK),
    });

    const { tokenUpdate } = await QuotaClient.refreshAccountQuota(expiredAccount(), {
      fetchFn,
      env: { AGY_OAUTH_CLIENT_ID: 'env-client-id' },
    });

    expect(tokenUpdate?.token.refresh_token).toBe('synthetic-refresh-token');
  });

  it('reports expired when the refresh request is rejected', async () => {
    const { fetchFn } = mockFetch({
      'oauth2.googleapis.com': () => new Response('{"error":"invalid_grant"}', { status: 400 }),
    });
    const { result } = await QuotaClient.refreshAccountQuota(expiredAccount(), {
      fetchFn,
      env: { AGY_OAUTH_CLIENT_ID: 'env-client-id' },
    });
    expect(result.reason).toBe('token-expired');
    expect(result.status).toBe('expired');
  });

  it('never exposes a token through the quota result or its serialization', async () => {
    const { fetchFn } = mockFetch({
      'oauth2.googleapis.com': () =>
        jsonResponse({ access_token: 'fresh-access-token', expires_in: 3600 }),
      retrieveUserQuotaSummary: () => jsonResponse(SUMMARY_OK),
      loadCodeAssist: () => jsonResponse(CODE_ASSIST_OK),
    });

    const refresh = await QuotaClient.refreshAccountQuota(expiredAccount(), {
      fetchFn,
      env: { AGY_OAUTH_CLIENT_ID: 'env-client-id' },
    });

    const serializedResult = JSON.stringify(refresh.result);
    expect(serializedResult).not.toContain('fresh-access-token');
    expect(serializedResult).not.toContain('synthetic-refresh-token');
    expect(JSON.stringify(refresh)).not.toContain('fresh-access-token');
    expect(String(new TokenUpdate(refresh.tokenUpdate?.token as never))).toBe('[redacted]');
  });
});

describe('Bounded multi-account refresh', () => {
  it('never exceeds four concurrent requests and survives per-account failures', async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchFn = (async (input: string | URL | Request) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      const url = String(input);
      if (url.includes('retrieveUserQuotaSummary')) return jsonResponse(SUMMARY_OK);
      if (url.includes('loadCodeAssist')) return jsonResponse(CODE_ASSIST_OK);
      return new Response('{}', { status: 500 });
    }) as unknown as typeof fetch;

    const accounts = Array.from({ length: 9 }, (_, i) =>
      oauthAccount({ id: `acc${i}`, email: `user${i}@example.com` })
    );
    accounts[3] = { ...accounts[3], authType: 'api-key', credentials: { apiKey: 'k' } };

    const results = await QuotaClient.refreshAccountQuotas(accounts, { fetchFn });

    expect(results.size).toBe(9);
    expect(peak).toBeLessThanOrEqual(QUOTA_REFRESH_CONCURRENCY);
    expect(results.get('acc3')?.result.reason).toBe('not-applicable');
    expect(results.get('acc0')?.result.ok).toBe(true);
  });

  it('summarizes refresh outcomes without leaking anything else', () => {
    const summary = summarizeQuotaRefresh(false, [
      { result: { accountId: 'a', observedUpdatedAt: 1, ok: true } },
      { result: { accountId: 'b', observedUpdatedAt: 2, ok: false, reason: 'network-error' } },
    ]);
    expect(summary).toEqual({
      attempted: true,
      offline: false,
      accounts: [
        { accountId: 'a', ok: true },
        { accountId: 'b', ok: false, reason: 'network-error' },
      ],
    });
    expect(summarizeQuotaRefresh(true, []).attempted).toBe(false);
  });
});

describe('Registry integration', () => {
  let testEnv: TestEnv;

  function writeRegistry(registry: unknown): void {
    fs.writeFileSync(
      path.join(process.env.AGY_AUTH_HOME as string, 'registry.json'),
      `${JSON.stringify(registry, null, 2)}\n`,
      { mode: 0o600 }
    );
  }

  beforeEach(() => {
    testEnv = setupTestEnvironment();
  });

  afterEach(() => {
    testEnv.cleanup();
  });

  it('loads a simplified schema v2 registry with no quota fields and no migration', () => {
    const account = oauthAccount();
    delete (account as Partial<Account>).plan;
    writeRegistry({
      schemaVersion: 3,
      activeAccountId: 'acc1',
      previousAccountId: null,
      accounts: [account],
      settings: { defaultLocation: 'global' },
    } satisfies Registry);

    const registry = new RegistryManager();
    const loaded = registry.getAccounts();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].plan).toBeUndefined();
    expect(loaded[0].rateLimit).toBeUndefined();
    expect(loaded[0].quotaCheckedAt).toBeUndefined();
    expect(fs.readdirSync(path.join(process.env.AGY_AUTH_HOME as string, 'backups'))).toHaveLength(
      0
    );
  });

  it('preserves valid legacy plan and quota cache while dropping malformed windows', () => {
    writeRegistry({
      schemaVersion: 1,
      activeAccountId: 'legacy1',
      previousAccountId: null,
      accounts: [
        {
          id: 'legacy1',
          email: 'legacy@example.com',
          authType: 'oauth',
          status: 'needs-reauth',
          plan: 'Google AI Ultra',
          quotaCheckedAt: 1_700_000_000_000,
          quotaSnapshot: { dailyRequestsUsed: 5 },
          rateLimit: {
            primary: { usedPercent: 10, windowMinutes: 300 },
            gemini: {
              rate5h: { usedPercent: 40, windowMinutes: 300, resetsAt: FUTURE_RESET },
              rateWeekly: { usedPercent: 250, windowMinutes: 10080 },
            },
            claude: { rate5h: { usedPercent: 'lots', windowMinutes: 300 } },
          },
          credentials: {
            accessToken: 'legacy-access-token',
            refreshToken: 'legacy-refresh-token',
          },
          createdAt: 1_700_000_000_000,
          updatedAt: 1_700_000_000_000,
        },
      ],
      settings: { defaultLocation: 'global' },
    });

    const registry = new RegistryManager();
    const [account] = registry.getAccounts();

    expect(account.plan).toBe('Google AI Ultra');
    expect(account.quotaCheckedAt).toBe(1_700_000_000_000);
    expect(account.rateLimit?.gemini?.rate5h?.usedPercent).toBe(40);
    // usedPercent 250 is out of range and 'lots' is not a number: both dropped.
    expect(account.rateLimit?.gemini?.rateWeekly).toBeUndefined();
    expect(account.rateLimit?.claude).toBeUndefined();
    expect((account as Record<string, unknown>).quotaSnapshot).toBeUndefined();
    expect(account.status).toBe('needs-reauth');
  });

  it('applies quota state narrowly and rejects stale optimistic writes', async () => {
    const account = oauthAccount({ status: 'unverified' });
    writeRegistry({
      schemaVersion: 3,
      activeAccountId: 'acc1',
      previousAccountId: null,
      accounts: [account],
      settings: { defaultLocation: 'global' },
    } satisfies Registry);

    const registry = new RegistryManager();
    const refresh: QuotaRefresh = {
      result: {
        accountId: 'acc1',
        observedUpdatedAt: account.updatedAt,
        ok: true,
        status: 'valid',
        plan: 'Google AI Ultra',
        rateLimit: { gemini: { rate5h: { usedPercent: 20, windowMinutes: 300 } } },
        quotaCheckedAt: 1_700_000_000_000,
        discoveredProject: 'discovered-project',
      },
      tokenUpdate: new TokenUpdate({
        access_token: 'fresh-access-token',
        refresh_token: 'rotated-refresh-token',
        token_type: 'Bearer',
        expiry: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    };

    expect(await applyQuotaResults(registry, [refresh])).toBe(1);

    const [stored] = registry.getAccounts();
    expect(stored.status).toBe('valid');
    expect(stored.plan).toBe('Google AI Ultra');
    expect(stored.gcpProject).toBe('discovered-project');
    expect(stored.quotaCheckedAt).toBe(1_700_000_000_000);
    expect(stored.credentials?.keychainPayload?.token.access_token).toBe('fresh-access-token');
    expect(stored.credentials?.keychainPayload?.token.refresh_token).toBe('rotated-refresh-token');
    expect(stored.email).toBe(account.email);
    expect(stored.updatedAt).toBeGreaterThan(account.updatedAt);

    // Replaying the same (now stale) result must not touch the account again.
    expect(await applyQuotaResults(registry, [refresh])).toBe(0);
    expect(registry.getAccounts()[0].updatedAt).toBe(stored.updatedAt);
  });

  it('creates no backup churn for routine quota refreshes', async () => {
    const account = oauthAccount();
    writeRegistry({
      schemaVersion: 3,
      activeAccountId: 'acc1',
      previousAccountId: null,
      accounts: [account],
      settings: { defaultLocation: 'global' },
    } satisfies Registry);

    const registry = new RegistryManager();
    await applyQuotaResults(registry, [
      {
        result: {
          accountId: 'acc1',
          observedUpdatedAt: account.updatedAt,
          ok: true,
          status: 'valid',
          rateLimit: { gemini: { rate5h: { usedPercent: 5, windowMinutes: 300 } } },
          quotaCheckedAt: Date.now(),
        },
      },
    ]);

    expect(fs.readdirSync(path.join(process.env.AGY_AUTH_HOME as string, 'backups'))).toHaveLength(
      0
    );
  });

  it('preserves the cached snapshot when a refresh fails', async () => {
    const account = oauthAccount({
      status: 'valid',
      plan: 'Google AI Ultra',
      rateLimit: {
        gemini: { rate5h: { usedPercent: 30, windowMinutes: 300, resetsAt: FUTURE_RESET } },
      },
      quotaCheckedAt: 1_700_000_000_000,
    });
    writeRegistry({
      schemaVersion: 3,
      activeAccountId: 'acc1',
      previousAccountId: null,
      accounts: [account],
      settings: { defaultLocation: 'global' },
    } satisfies Registry);

    const registry = new RegistryManager();
    const applied = await applyQuotaResults(registry, [
      {
        result: {
          accountId: 'acc1',
          observedUpdatedAt: account.updatedAt,
          ok: false,
          reason: 'network-error',
        },
      },
    ]);

    expect(applied).toBe(0);
    const [stored] = registry.getAccounts();
    expect(stored.status).toBe('valid');
    expect(stored.plan).toBe('Google AI Ultra');
    expect(stored.rateLimit?.gemini?.rate5h?.usedPercent).toBe(30);
    expect(stored.quotaCheckedAt).toBe(1_700_000_000_000);
  });

  it('applies an explicit plan without replacing cached quota when quota is unavailable', async () => {
    const account = oauthAccount({
      status: 'valid',
      plan: 'Google AI Free',
      rateLimit: {
        gemini: { rate5h: { usedPercent: 30, windowMinutes: 300, resetsAt: FUTURE_RESET } },
      },
      quotaCheckedAt: 1_700_000_000_000,
    });
    writeRegistry({
      schemaVersion: 3,
      activeAccountId: 'acc1',
      previousAccountId: null,
      accounts: [account],
      settings: { defaultLocation: 'global' },
    } satisfies Registry);

    const registry = new RegistryManager();
    const applied = await applyQuotaResults(registry, [
      {
        result: {
          accountId: 'acc1',
          observedUpdatedAt: account.updatedAt,
          ok: false,
          reason: 'quota-unavailable',
          plan: 'Google AI Pro',
        },
      },
    ]);

    expect(applied).toBe(1);
    const [stored] = registry.getAccounts();
    expect(stored.status).toBe('valid');
    expect(stored.plan).toBe('Google AI Pro');
    expect(stored.rateLimit?.gemini?.rate5h?.usedPercent).toBe(30);
    expect(stored.quotaCheckedAt).toBe(1_700_000_000_000);
  });

  it('gives quota precedence only for decisive outcomes during list --check', async () => {
    const oauth = oauthAccount({
      id: 'oauth1',
      email: 'oauth@example.com',
      status: 'valid',
    });
    const apiKey: Account = {
      id: 'api1',
      email: 'api@example.com',
      authType: 'api-key',
      status: 'unverified',
      credentials: { apiKey: 'synthetic-api-key' },
      createdAt: Date.now() - 1000,
      updatedAt: Date.now() - 1000,
    };
    writeRegistry({
      schemaVersion: 3,
      activeAccountId: 'oauth1',
      previousAccountId: null,
      accounts: [oauth, apiKey],
      settings: { defaultLocation: 'global' },
    } satisfies Registry);

    const registry = new RegistryManager();
    const verifications = new Map<string, VerificationResult>([
      [
        'oauth1',
        {
          status: 'unverified',
          verification: { checkedAt: Date.now(), source: 'local', message: 'local ok' },
          observedUpdatedAt: oauth.updatedAt,
        },
      ],
      [
        'api1',
        {
          status: 'valid',
          verification: { checkedAt: Date.now(), source: 'remote', message: 'verified' },
          observedUpdatedAt: apiKey.updatedAt,
        },
      ],
    ]);

    // A local-only `unverified` result and a transport failure must not erase a
    // stronger status already established for the profile.
    await applyCheckResults(
      registry,
      verifications,
      new Map([
        [
          'oauth1',
          {
            result: {
              accountId: 'oauth1',
              observedUpdatedAt: oauth.updatedAt,
              ok: false,
              reason: 'network-error' as const,
            },
          },
        ],
      ])
    );

    let accounts = registry.getAccounts();
    expect(accounts.find((a) => a.id === 'oauth1')?.status).toBe('valid');
    expect(accounts.find((a) => a.id === 'api1')?.status).toBe('valid');

    // A decisive scope failure does override it.
    const refreshed = registry.getAccounts().find((a) => a.id === 'oauth1') as Account;
    await applyCheckResults(
      registry,
      new Map([
        [
          'oauth1',
          {
            status: 'unverified' as const,
            verification: { checkedAt: Date.now(), source: 'local', message: 'local ok' },
            observedUpdatedAt: refreshed.updatedAt,
          },
        ],
      ]),
      new Map([
        [
          'oauth1',
          {
            result: {
              accountId: 'oauth1',
              observedUpdatedAt: refreshed.updatedAt,
              ok: false,
              reason: 'scope-insufficient' as const,
              status: 'needs-reauth' as const,
            },
          },
        ],
      ])
    );

    accounts = registry.getAccounts();
    expect(accounts.find((a) => a.id === 'oauth1')?.status).toBe('needs-reauth');
  });

  it('rejects a quota result for an account that no longer exists', () => {
    const draft: Registry = {
      schemaVersion: 3,
      activeAccountId: null,
      previousAccountId: null,
      accounts: [],
      settings: { defaultLocation: 'global' },
    };
    expect(
      applyQuotaResult(draft, {
        result: { accountId: 'gone', observedUpdatedAt: 1, ok: true, status: 'valid' },
      })
    ).toBe(false);
  });

  it('verifies OAuth profiles locally without any quota request', async () => {
    const result = await Verifier.verifyAccount(oauthAccount(), {
      fetchFn: (() => {
        throw new Error('OAuth verification must not make network requests');
      }) as unknown as typeof fetch,
    });
    expect(result.status).toBe('unverified');
  });
});

describe('Quota rendering', () => {
  it('renders an elapsed window as stale rather than 100% or its old value', () => {
    expect(
      formatQuotaCell({ usedPercent: 80, windowMinutes: 300, resetsAt: PAST_RESET }).text
    ).toBe('stale');
    expect(
      formatQuotaCell({ usedPercent: 80, windowMinutes: 300, resetsAt: FUTURE_RESET }).text
    ).toContain('20%');
  });

  it('renders unknown quota as a dash and exhausted quota as an error', () => {
    expect(formatQuotaCell(undefined).text).toBe('-');
    expect(formatQuotaCell(undefined).isError).toBe(false);
    const empty = formatQuotaCell({ usedPercent: 100, windowMinutes: 300, resetsAt: FUTURE_RESET });
    expect(empty.text).toContain('0%');
    expect(empty.isError).toBe(true);
  });

  it('names a blocking account status once instead of per quota column', () => {
    expect(blockingStatusLabel('expired')).toBe('expired');
    expect(blockingStatusLabel('rate-limited')).toBe('limited');
    expect(blockingStatusLabel('needs-reauth')).toBe('reauth');
    expect(blockingStatusLabel('invalid')).toBe('invalid');
    expect(blockingStatusLabel('valid')).toBeUndefined();
    expect(blockingStatusLabel('unverified')).toBeUndefined();
  });

  it('reports absent quota as absent whatever the account status', () => {
    // An expired token used to print 'expired' into all four quota columns, so
    // one account-level fact was repeated four times and read as four separate
    // expiries. The quota cell now answers only the question it is asked.
    const window = { usedPercent: 10, windowMinutes: 300, resetsAt: FUTURE_RESET };
    expect(formatQuotaCell(window).text).toContain('90%');
    expect(formatQuotaCell(undefined).text).toBe('-');

    const expired = oauthAccount({ status: 'expired', rateLimit: undefined });
    const table = renderAccountsTable([expired], expired.id, 160);
    expect(table).toContain('expired');
    expect(table.match(/expired/g)).toHaveLength(1);
  });

  it('renders a shared plan and quota block for detailed views', () => {
    const lines = quotaSummaryLines(
      oauthAccount({
        status: 'valid',
        plan: 'Google AI Ultra',
        rateLimit: {
          gemini: { rate5h: { usedPercent: 25, windowMinutes: 300, resetsAt: FUTURE_RESET } },
        },
        quotaCheckedAt: Date.now() - 120_000,
      })
    ).join('\n');

    expect(lines).toContain('Plan:');
    expect(lines).toContain('Google AI Ultra');
    expect(lines).toContain('75%');
    expect(lines).toContain('Gemini week:  -');
    expect(lines).toContain('Claude 5h:    -');
    expect(lines).toContain('Quota check:');
    expect(lines).toContain('2m ago');
  });

  it('reports never-checked quota honestly', () => {
    const lines = quotaSummaryLines(oauthAccount()).join('\n');
    expect(lines).toContain('Quota check:  never');
  });
});
