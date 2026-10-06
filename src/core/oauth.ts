import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import { isEmail } from './credential-validation.js';
import { CliError } from './errors.js';
import type { AgyKeychainPayload } from './keychain.js';
import { NativeOperationBlockedError, assertNativeAllowed } from './native-guard.js';
import { OAUTH_TOKEN_ENDPOINT, getSignInClient } from './oauth-config.js';

export interface OAuthResult {
  email: string;
  payload: AgyKeychainPayload;
}

export interface AuthenticateOptions {
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  openBrowserFn?: (url: string) => void;
  timeoutMs?: number;
}

interface GoogleTokenResponse {
  access_token?: string;
  token_type?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

interface GoogleUserInfo {
  email?: string;
  email_verified?: boolean;
}

/** The scopes Antigravity's client requests; the quota endpoints expect them. */
export const OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
].join(' ');

const SECURITY_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
} as const;

function base64URLEncode(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function sha256(buffer: Buffer): Buffer {
  return crypto.createHash('sha256').update(buffer).digest();
}

function renderHtml(title: string, heading: string, bodyText: string, isError = false): string {
  const headingColor = isError ? '#ef4444' : '#38bdf8';
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>${title}</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #18181b; color: #f4f4f5; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
      .box { background: #27272a; border: 1px solid #3f3f46; border-radius: 8px; padding: 24px 32px; text-align: center; max-width: 400px; }
      h1 { font-size: 18px; color: ${headingColor}; margin: 0 0 8px; }
      p { font-size: 14px; color: #a1a1aa; margin: 0; }
    </style>
  </head>
  <body>
    <div class="box">
      <h1>${heading}</h1>
      <p>${bodyText}</p>
    </div>
  </body>
</html>`;
}

type BrowserLauncher = (command: string, args: string[]) => void;

/**
 * The native boundary for opening a browser.
 *
 * The guard and the only real process spawn sit together, so neither can be
 * reached without the other.
 */
function spawnBrowser(command: string, args: string[]): void {
  assertNativeAllowed('browser launch');

  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

export function defaultOpenBrowser(url: string, launch: BrowserLauncher = spawnBrowser): void {
  const platform = process.platform;
  const command =
    platform === 'darwin' ? 'open' : platform === 'win32' ? 'explorer.exe' : 'xdg-open';

  try {
    launch(command, [url]);
  } catch (error: unknown) {
    // A launcher that cannot start is not fatal: the authorization URL is
    // printed to the terminal for manual navigation. An isolation breach is
    // fatal, and must not be mistaken for one.
    if (error instanceof NativeOperationBlockedError) throw error;
  }
}

export class OAuthFlow {
  /**
   * Starts a local loopback server on 127.0.0.1 and opens the browser for Google OAuth sign-in.
   * Enforces PKCE (S256), state validation, verified email lookup, security response headers,
   * single-settlement server cleanup, and bounded timeouts.
   */
  public static async authenticate(options: AuthenticateOptions = {}): Promise<OAuthResult> {
    const env = options.env || process.env;
    const clientConfig = getSignInClient(env);

    const fetchFn = options.fetchFn || fetch;
    const openBrowserFn = options.openBrowserFn || defaultOpenBrowser;
    const timeoutMs = options.timeoutMs ?? 120_000;

    return new Promise<OAuthResult>((resolve, reject) => {
      const codeVerifier = base64URLEncode(crypto.randomBytes(32));
      const codeChallenge = base64URLEncode(sha256(Buffer.from(codeVerifier)));
      const state = crypto.randomBytes(16).toString('hex');

      let isFinished = false;
      let callbackInProgress = false;

      const finish = (callback: () => void) => {
        if (isFinished) return;
        isFinished = true;
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        try {
          server.close();
        } catch {
          // Ignore server close error
        }
        callback();
      };

      const timeoutHandle = setTimeout(() => {
        finish(() => reject(new CliError('Authentication timed out waiting for browser sign-in.')));
      }, timeoutMs);

      const server = http.createServer(async (req, res) => {
        try {
          const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');

          if (req.method !== 'GET' || reqUrl.pathname !== '/auth/callback') {
            res.writeHead(404, {
              'Content-Type': 'text/plain; charset=utf-8',
              'Cache-Control': 'no-store, no-cache, must-revalidate',
              'X-Content-Type-Options': 'nosniff',
            });
            res.end('Not found');
            return;
          }

          if (isFinished || callbackInProgress) {
            res.writeHead(409, SECURITY_HEADERS);
            res.end(
              renderHtml(
                'Authentication In Progress',
                'OAuth Callback Already Received',
                'Return to your terminal to complete sign-in.'
              )
            );
            return;
          }

          const returnedState = reqUrl.searchParams.get('state');
          if (!returnedState || returnedState !== state) {
            res.writeHead(400, SECURITY_HEADERS);
            res.end(
              renderHtml(
                'Authentication Failed',
                'Invalid OAuth Callback',
                'State parameter mismatch. Return to your terminal.',
                true
              )
            );
            finish(() => reject(new CliError('OAuth state mismatch.')));
            return;
          }

          const error = reqUrl.searchParams.get('error');
          if (error) {
            res.writeHead(400, SECURITY_HEADERS);
            res.end(
              renderHtml(
                'Authentication Failed',
                'Authentication Cancelled or Denied',
                'Return to your terminal for details.',
                true
              )
            );
            finish(() =>
              reject(
                new CliError(
                  'Authentication was cancelled or denied by the provider.',
                  'auth_cancelled'
                )
              )
            );
            return;
          }

          const code = reqUrl.searchParams.get('code');
          if (!code) {
            res.writeHead(400, SECURITY_HEADERS);
            res.end(
              renderHtml(
                'Authentication Failed',
                'Missing Authorization Code',
                'Return to your terminal for details.',
                true
              )
            );
            finish(() => reject(new CliError('Missing OAuth authorization code.')));
            return;
          }

          callbackInProgress = true;

          const port = (server.address() as import('node:net').AddressInfo)?.port;
          const redirectUri = `http://127.0.0.1:${port}/auth/callback`;

          const tokenParams = new URLSearchParams({
            code,
            code_verifier: codeVerifier,
            grant_type: 'authorization_code',
            redirect_uri: redirectUri,
            client_id: clientConfig.clientId,
          });
          if (clientConfig.clientSecret) {
            tokenParams.set('client_secret', clientConfig.clientSecret);
          }

          let tokenData: GoogleTokenResponse;
          try {
            const tokenRes = await fetchFn(OAUTH_TOKEN_ENDPOINT, {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: tokenParams.toString(),
              signal: AbortSignal.timeout(15_000),
            });
            tokenData = (await tokenRes.json()) as GoogleTokenResponse;

            if (!tokenRes.ok || !tokenData.access_token) {
              res.writeHead(400, SECURITY_HEADERS);
              res.end(
                renderHtml(
                  'Authentication Failed',
                  'Token Exchange Failed',
                  'Return to your terminal for details.',
                  true
                )
              );
              finish(() =>
                reject(new CliError('Google OAuth token exchange failed.', 'token_exchange_failed'))
              );
              return;
            }
          } catch (err: unknown) {
            if (err instanceof CliError) {
              throw err;
            }
            res.writeHead(500, SECURITY_HEADERS);
            res.end(
              renderHtml(
                'Authentication Failed',
                'Token Exchange Error',
                'Return to your terminal for details.',
                true
              )
            );
            finish(() =>
              reject(
                new CliError('Google OAuth token exchange request failed.', 'token_exchange_failed')
              )
            );
            return;
          }

          // Retrieve verified user email
          let email = '';
          try {
            const userinfoRes = await fetchFn('https://www.googleapis.com/oauth2/v3/userinfo', {
              headers: { Authorization: `Bearer ${tokenData.access_token}` },
              signal: AbortSignal.timeout(15_000),
            });

            if (userinfoRes.ok) {
              const userinfo = (await userinfoRes.json()) as GoogleUserInfo;
              if (userinfo.email && userinfo.email_verified === true && isEmail(userinfo.email)) {
                email = userinfo.email;
              }
            }
          } catch {
            // Handled below if email is empty
          }

          if (!email) {
            res.writeHead(400, SECURITY_HEADERS);
            res.end(
              renderHtml(
                'Authentication Failed',
                'Profile Lookup Failed',
                'Could not retrieve a verified email address from your Google profile.',
                true
              )
            );
            finish(() =>
              reject(
                new CliError(
                  'Failed to retrieve a verified email address from Google OAuth profile.'
                )
              )
            );
            return;
          }

          res.writeHead(200, SECURITY_HEADERS);
          res.end(
            renderHtml(
              'Authentication Successful',
              'Authenticated with Antigravity',
              'You can close this tab and return to your terminal.'
            )
          );

          const expiresAt = new Date(
            Date.now() + (tokenData.expires_in || 3600) * 1000
          ).toISOString();

          const payload: AgyKeychainPayload = {
            auth_method: 'consumer',
            token: {
              access_token: tokenData.access_token,
              token_type: tokenData.token_type || 'Bearer',
              refresh_token: tokenData.refresh_token || '',
              expiry: expiresAt,
            },
          };

          finish(() => resolve({ email, payload }));
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          if (!res.headersSent) {
            res.writeHead(500, SECURITY_HEADERS);
          }
          if (!res.writableEnded) {
            res.end(
              renderHtml(
                'Authentication Failed',
                'Authentication Error',
                'Return to your terminal for details.',
                true
              )
            );
          }
          finish(() => reject(new CliError(`OAuth callback error: ${errMsg}`)));
        }
      });

      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as import('node:net').AddressInfo)?.port;
        const redirectUri = `http://127.0.0.1:${port}/auth/callback`;

        const authParams = new URLSearchParams({
          client_id: clientConfig.clientId,
          redirect_uri: redirectUri,
          response_type: 'code',
          scope: OAUTH_SCOPES,
          code_challenge: codeChallenge,
          code_challenge_method: 'S256',
          state,
          access_type: 'offline',
          prompt: 'consent select_account',
        });

        const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${authParams.toString()}`;

        console.log('\nOpening your browser for Google sign-in...');
        console.log(`If the browser does not open automatically, visit:\n  ${authUrl}\n`);

        try {
          openBrowserFn(authUrl);
        } catch (error: unknown) {
          // Failure to open browser is recoverable via terminal URL. An
          // isolation breach is not, and swallowing it here would hang until
          // the timeout rather than report it, so it settles the flow instead.
          if (error instanceof NativeOperationBlockedError) {
            finish(() => reject(error));
          }
        }
      });

      server.on('error', (err) => {
        finish(() =>
          reject(new CliError(`Failed to start local OAuth callback server: ${err.message}`))
        );
      });
    });
  }
}
