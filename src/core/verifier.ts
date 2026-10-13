import { VERSION } from '../version.js';
import { CredentialFiles } from './credential-files.js';
import { validateServiceAccountKey } from './credential-validation.js';
import { Paths } from './paths.js';
import { settleEach } from './quota.js';
import { Account, AccountStatus, VerificationRecord } from './types.js';

interface VerifyOptions {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

export interface VerificationResult {
  status: AccountStatus;
  verification: VerificationRecord;
  observedUpdatedAt: number;
}

const GEMINI_MODELS_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

export class Verifier {
  /**
   * Verify an account without mutating it.
   * OAuth, Service Account, and ADC are validated locally with 0 network calls.
   * API keys are checked against the official Gemini models endpoint using header-based authentication.
   */
  public static async verifyAccount(
    account: Account,
    options: VerifyOptions = {}
  ): Promise<VerificationResult> {
    const now = Date.now();
    const fetchFn = options.fetchFn || globalThis.fetch;
    const timeoutMs = options.timeoutMs ?? 5000;
    const observedUpdatedAt = account.updatedAt;
    const result = (
      status: AccountStatus,
      source: VerificationRecord['source'],
      message: string
    ): VerificationResult => ({
      status,
      verification: { checkedAt: now, source, message },
      observedUpdatedAt,
    });

    switch (account.authType) {
      case 'oauth': {
        const payload = account.credentials?.keychainPayload;
        if (!payload?.token?.access_token) {
          return result('invalid', 'local', 'Missing OAuth access token in keychain payload');
        }

        if (payload.token.expiry) {
          const expiryMs = Date.parse(payload.token.expiry);
          if (Number.isFinite(expiryMs) && now > expiryMs) {
            return result('expired', 'local', `OAuth token expired at ${payload.token.expiry}`);
          }
        }

        return result('unverified', 'local', 'Local OAuth payload structure is valid');
      }

      case 'service-account': {
        const key = account.credentials?.serviceAccountKey;
        if (!key) {
          return result('invalid', 'local', 'Missing service account key payload');
        }

        const valid = validateServiceAccountKey(key);
        if (!valid.ok) {
          return result('invalid', 'local', valid.reason);
        }

        if (key.client_email.trim().toLowerCase() !== account.email.trim().toLowerCase()) {
          return result(
            'invalid',
            'local',
            `Service account email '${key.client_email}' does not match account email '${account.email}'`
          );
        }

        return result('unverified', 'local', 'Local service account key is valid');
      }

      case 'adc': {
        const adcPath = account.credentials?.adcPath || Paths.gcloudAdcFile;
        try {
          CredentialFiles.loadAdcFile(adcPath);
          return result('unverified', 'local', `Valid ADC file at ${adcPath}`);
        } catch (err) {
          return result('invalid', 'local', err instanceof Error ? err.message : String(err));
        }
      }

      case 'api-key': {
        const apiKey = account.credentials?.apiKey;
        if (!apiKey || !apiKey.trim()) {
          return result('invalid', 'local', 'Missing API key');
        }

        try {
          const response = await fetchFn(GEMINI_MODELS_ENDPOINT, {
            method: 'GET',
            headers: {
              'x-goog-api-key': apiKey.trim(),
              'x-goog-api-client': `agy-auth/${VERSION}`,
            },
            signal: AbortSignal.timeout(timeoutMs),
          });

          if (response.status === 200) {
            return result('valid', 'remote', 'API key verified against Google Gemini API');
          }

          if (response.status === 429) {
            return result('rate-limited', 'remote', 'Rate limit exceeded (HTTP 429)');
          }

          if (response.status === 400 || response.status === 401) {
            return result('invalid', 'remote', `API key rejected with HTTP ${response.status}`);
          }

          if (response.status === 403) {
            return result(
              'unknown',
              'remote',
              'API key request returned HTTP 403 (access restrictions or disabled API)'
            );
          }

          return result(
            'unknown',
            'remote',
            `Unexpected HTTP status ${response.status} from API verification`
          );
        } catch (err) {
          return result(
            'unknown',
            'remote',
            err instanceof Error ? err.message : 'Network failure during verification'
          );
        }
      }

      default:
        return result(
          'unknown',
          'local',
          `Unknown authType '${String((account as Account).authType)}'`
        );
    }
  }

  /**
   * Verify multiple accounts in parallel, bounded to max 4 concurrent requests.
   * Convert rejected batch promises into per-account unknown results.
   */
  public static async verifyAccounts(
    accounts: Account[],
    options: VerifyOptions = {}
  ): Promise<Map<string, VerificationResult>> {
    return settleEach(
      accounts,
      (acc) => this.verifyAccount(acc, options),
      (acc): VerificationResult => ({
        status: 'unknown',
        verification: {
          checkedAt: Date.now(),
          source: 'remote',
          message: 'Verification task failed',
        },
        observedUpdatedAt: acc.updatedAt,
      })
    );
  }
}
