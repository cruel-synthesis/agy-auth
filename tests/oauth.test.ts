import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeOperationBlockedError } from '../src/core/native-guard.js';
import { OAUTH_SCOPES, OAuthFlow, defaultOpenBrowser } from '../src/core/oauth.js';

function visitCallback(
  authorizationUrl: string,
  options: {
    mutateState?: boolean;
    error?: string;
    omitCode?: boolean;
    path?: string;
  } = {}
): void {
  const authorization = new URL(authorizationUrl);
  const redirectUri = authorization.searchParams.get('redirect_uri');
  const state = authorization.searchParams.get('state');
  if (!redirectUri || !state) throw new Error('OAuth authorization URL omitted callback state');

  const callback = new URL(redirectUri);
  if (options.path) {
    callback.pathname = options.path;
  }
  if (options.error) {
    callback.searchParams.set('error', options.error);
  } else if (!options.omitCode) {
    callback.searchParams.set('code', 'synthetic-authorization-code');
  }
  callback.searchParams.set('state', options.mutateState ? 'wrong-state' : state);

  http.get(callback, (response) => response.resume()).on('error', () => {});
}

describe('OAuthFlow', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fails closed before opening a browser when no OAuth client is configured', async () => {
    const openBrowserFn = vi.fn();
    const fetchFn = vi.fn();

    await expect(
      OAuthFlow.authenticate({
        env: {},
        fetchFn: fetchFn as unknown as typeof fetch,
        openBrowserFn,
      })
    ).rejects.toThrow(/AGY_OAUTH_CLIENT_ID/);
    expect(openBrowserFn).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('completes PKCE login and accepts only a verified Google email', async () => {
    let tokenRequestBody = '';
    let capturedAuthUrl = '';
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://oauth2.googleapis.com/token') {
        tokenRequestBody = String(init?.body || '');
        return new Response(
          JSON.stringify({
            access_token: 'synthetic-access-token',
            refresh_token: 'synthetic-refresh-token',
            token_type: 'Bearer',
            expires_in: 3600,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url === 'https://www.googleapis.com/oauth2/v3/userinfo') {
        return new Response(
          JSON.stringify({ email: 'verified@example.com', email_verified: true }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      throw new Error(`Unexpected OAuth request: ${url}`);
    });

    const result = await OAuthFlow.authenticate({
      env: {
        AGY_OAUTH_CLIENT_ID: 'agy-auth-test-client.apps.googleusercontent.com',
        AGY_OAUTH_CLIENT_SECRET: 'test-secret',
      },
      fetchFn: fetchFn as unknown as typeof fetch,
      timeoutMs: 5_000,
      openBrowserFn: (url) => {
        capturedAuthUrl = url;
        const authorization = new URL(url);
        expect(authorization.hostname).toBe('accounts.google.com');
        expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
        expect(authorization.searchParams.get('code_challenge')).toBeTruthy();
        expect(authorization.searchParams.get('state')).toBeTruthy();
        expect(authorization.searchParams.get('scope')).toBe(OAUTH_SCOPES);
        expect(authorization.searchParams.get('access_type')).toBe('offline');
        expect(authorization.searchParams.get('client_secret')).toBeNull(); // Secret never in URL
        visitCallback(url);
      },
    });

    expect(result.email).toBe('verified@example.com');
    expect(result.payload.token).toMatchObject({
      access_token: 'synthetic-access-token',
      refresh_token: 'synthetic-refresh-token',
      token_type: 'Bearer',
    });
    const tokenParams = new URLSearchParams(tokenRequestBody);
    expect(tokenParams.get('client_id')).toBe('agy-auth-test-client.apps.googleusercontent.com');
    expect(tokenParams.get('client_secret')).toBe('test-secret');
    expect(tokenParams.get('code_verifier')).toBeTruthy();
    expect(tokenParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
    expect(capturedAuthUrl).not.toContain('test-secret');
  });

  it('rejects a callback whose state does not match', async () => {
    const fetchFn = vi.fn();
    await expect(
      OAuthFlow.authenticate({
        env: { AGY_OAUTH_CLIENT_ID: 'test-client' },
        fetchFn: fetchFn as unknown as typeof fetch,
        timeoutMs: 2_000,
        openBrowserFn: (url) => visitCallback(url, { mutateState: true }),
      })
    ).rejects.toThrow(/state/i);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('rejects provider cancellation or error parameters', async () => {
    const fetchFn = vi.fn();
    await expect(
      OAuthFlow.authenticate({
        env: { AGY_OAUTH_CLIENT_ID: 'test-client' },
        fetchFn: fetchFn as unknown as typeof fetch,
        timeoutMs: 2_000,
        openBrowserFn: (url) => visitCallback(url, { error: 'access_denied' }),
      })
    ).rejects.toThrow(/cancelled or denied/i);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('rejects callback with missing authorization code', async () => {
    const fetchFn = vi.fn();
    await expect(
      OAuthFlow.authenticate({
        env: { AGY_OAUTH_CLIENT_ID: 'test-client' },
        fetchFn: fetchFn as unknown as typeof fetch,
        timeoutMs: 2_000,
        openBrowserFn: (url) => visitCallback(url, { omitCode: true }),
      })
    ).rejects.toThrow(/Missing OAuth authorization code/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('handles token exchange failure response cleanly', async () => {
    const fetchFn = vi.fn(async () => {
      return new Response(
        JSON.stringify({ error: 'invalid_grant', error_description: 'Bad code' }),
        { status: 400, headers: { 'content-type': 'application/json' } }
      );
    });

    await expect(
      OAuthFlow.authenticate({
        env: { AGY_OAUTH_CLIENT_ID: 'test-client' },
        fetchFn: fetchFn as unknown as typeof fetch,
        timeoutMs: 2_000,
        openBrowserFn: visitCallback,
      })
    ).rejects.toThrow(/token exchange failed/i);
  });

  it('rejects an unverified or missing Google email', async () => {
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      if (String(input) === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({ access_token: 'synthetic-access-token' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({ email: 'unverified@example.com', email_verified: false }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });

    await expect(
      OAuthFlow.authenticate({
        env: { AGY_OAUTH_CLIENT_ID: 'test-client' },
        fetchFn: fetchFn as unknown as typeof fetch,
        timeoutMs: 2_000,
        openBrowserFn: visitCallback,
      })
    ).rejects.toThrow(/verified email/i);
  });

  it('handles userinfo network failure gracefully', async () => {
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      if (String(input) === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({ access_token: 'synthetic-access-token' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('Unauthorized', { status: 401 });
    });

    await expect(
      OAuthFlow.authenticate({
        env: { AGY_OAUTH_CLIENT_ID: 'test-client' },
        fetchFn: fetchFn as unknown as typeof fetch,
        timeoutMs: 2_000,
        openBrowserFn: visitCallback,
      })
    ).rejects.toThrow(/verified email/i);
  });

  it('times out and cleans up if user does not complete login within timeout', async () => {
    const fetchFn = vi.fn();
    await expect(
      OAuthFlow.authenticate({
        env: { AGY_OAUTH_CLIENT_ID: 'test-client' },
        fetchFn: fetchFn as unknown as typeof fetch,
        timeoutMs: 50,
        openBrowserFn: () => {}, // Do not visit callback
      })
    ).rejects.toThrow(/timed out/i);
  });

  it('responds with 404 for unexpected request paths without terminating flow early', async () => {
    let handled404 = false;
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      if (String(input) === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({ access_token: 'synthetic-token' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ email: 'user@example.com', email_verified: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const result = await OAuthFlow.authenticate({
      env: { AGY_OAUTH_CLIENT_ID: 'test-client' },
      fetchFn: fetchFn as unknown as typeof fetch,
      timeoutMs: 2_000,
      openBrowserFn: (url) => {
        const authorization = new URL(url);
        const redirectUri = authorization.searchParams.get('redirect_uri') || '';
        const wrongPath = new URL('/wrong/path', redirectUri);
        http.get(wrongPath, (res) => {
          expect(res.statusCode).toBe(404);
          handled404 = true;
          visitCallback(url);
        });
      },
    });

    expect(handled404).toBe(true);
    expect(result.email).toBe('user@example.com');
  });

  it('processes only one valid callback when duplicate requests arrive together', async () => {
    let tokenExchangeCount = 0;
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      if (String(input) === 'https://oauth2.googleapis.com/token') {
        tokenExchangeCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 25));
        return new Response(JSON.stringify({ access_token: 'synthetic-token' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ email: 'user@example.com', email_verified: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    await OAuthFlow.authenticate({
      env: { AGY_OAUTH_CLIENT_ID: 'test-client' },
      fetchFn: fetchFn as unknown as typeof fetch,
      timeoutMs: 2_000,
      openBrowserFn: (url) => {
        visitCallback(url);
        visitCallback(url);
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(tokenExchangeCount).toBe(1);
  });

  it('rejects rather than hanging when the real launcher is blocked by isolation', async () => {
    // No openBrowserFn, so the flow reaches the real launcher and the suite
    // guard stops it. Swallowing that left the callback server listening until
    // the timeout, which read as a slow sign-in rather than a blocked one.
    const fetchFn = vi.fn(() => {
      throw new Error('no request should be made');
    });

    await expect(
      OAuthFlow.authenticate({
        env: { AGY_OAUTH_CLIENT_ID: 'synthetic-client' },
        fetchFn: fetchFn as unknown as typeof fetch,
        // Far beyond the per-test limit, so a timeout cannot pass for a
        // rejection: hanging fails the test instead of satisfying it.
        timeoutMs: 600_000,
      })
    ).rejects.toBeInstanceOf(NativeOperationBlockedError);

    expect(fetchFn).not.toHaveBeenCalled();
  });

  // Exercises the injected launcher only. The suite guard stays on; that the
  // real launcher is blocked by it is asserted in native-isolation.test.ts.
  it('defaultOpenBrowser survives a launcher that cannot start', () => {
    const failing = vi.fn(() => {
      throw new Error('spawn xdg-open ENOENT');
    });

    expect(() => defaultOpenBrowser('https://example.com', failing)).not.toThrow();
    expect(failing).toHaveBeenCalledWith(expect.any(String), ['https://example.com']);
  });
});
