import { VERSION } from '../version.js';
import { CredentialFiles } from './credential-files.js';
import { validateServiceAccountKey } from './credential-validation.js';
import { Paths } from './paths.js';
import { Account, AccountStatus, VerificationRecord } from './types.js';

export interface VerifyOptions {
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

    switch (account.authType) {
      case 'oauth': {
        const payload = account.credentials?.keychainPayload;
        if (!payload || !payload.token || !payload.token.access_token) {
          return {
            status: 'invalid',
            verification: {
              checkedAt: now,
              source: 'local',
              message: 'Missing OAuth access token in keychain payload',
            },
            observedUpdatedAt,
          };
        }

        if (payload.token.expiry) {
          const expiryMs = Date.parse(payload.token.expiry);
          if (Number.isFinite(expiryMs) && now > expiryMs) {
            return {
              status: 'expired',
              verification: {
                checkedAt: now,
                source: 'local',
                message: `OAuth token expired at ${payload.token.expiry}`,
              },
              observedUpdatedAt,
            };
          }
        }

        return {
          status: 'unverified',
          verification: {
            checkedAt: now,
            source: 'local',
            message: 'Local OAuth payload structure is valid',
          },
          observedUpdatedAt,
        };
      }

      case 'service-account': {
        const key = account.credentials?.serviceAccountKey;
        if (!key) {
          return {
            status: 'invalid',
            verification: {
              checkedAt: now,
              source: 'local',
              message: 'Missing service account key payload',
            },
            observedUpdatedAt,
          };
        }

        const valid = validateServiceAccountKey(key);
        if (!valid.ok) {
          return {
            status: 'invalid',
            verification: {
              checkedAt: now,
              source: 'local',
              message: valid.reason,
            },
            observedUpdatedAt,
          };
        }

        if (key.client_email.trim().toLowerCase() !== account.email.trim().toLowerCase()) {
          return {
            status: 'invalid',
            verification: {
              checkedAt: now,
              source: 'local',
              message: `Service account email '${key.client_email}' does not match account email '${account.email}'`,
            },
            observedUpdatedAt,
          };
        }

        return {
          status: 'unverified',
          verification: {
            checkedAt: now,
            source: 'local',
            message: 'Local service account key is valid',
          },
          observedUpdatedAt,
        };
      }

      case 'adc': {
        const adcPath = account.credentials?.adcPath || Paths.gcloudAdcFile;
        try {
          CredentialFiles.loadAdcFile(adcPath);
          return {
            status: 'unverified',
            verification: {
              checkedAt: now,
              source: 'local',
              message: `Valid ADC file at ${adcPath}`,
            },
            observedUpdatedAt,
          };
        } catch (err) {
          return {
            status: 'invalid',
            verification: {
              checkedAt: now,
              source: 'local',
              message: err instanceof Error ? err.message : String(err),
            },
            observedUpdatedAt,
          };
        }
      }

      case 'api-key': {
        const apiKey = account.credentials?.apiKey;
        if (!apiKey || !apiKey.trim()) {
          return {
            status: 'invalid',
            verification: {
              checkedAt: now,
              source: 'local',
              message: 'Missing API key',
            },
            observedUpdatedAt,
          };
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
            return {
              status: 'valid',
              verification: {
                checkedAt: now,
                source: 'remote',
                message: 'API key verified against Google Gemini API',
              },
              observedUpdatedAt,
            };
          }

          if (response.status === 429) {
            return {
              status: 'rate-limited',
              verification: {
                checkedAt: now,
                source: 'remote',
                message: 'Rate limit exceeded (HTTP 429)',
              },
              observedUpdatedAt,
            };
          }

          if (response.status === 400 || response.status === 401) {
            return {
              status: 'invalid',
              verification: {
                checkedAt: now,
                source: 'remote',
                message: `API key rejected with HTTP ${response.status}`,
              },
              observedUpdatedAt,
            };
          }

          if (response.status === 403) {
            return {
              status: 'unknown',
              verification: {
                checkedAt: now,
                source: 'remote',
                message: 'API key request returned HTTP 403 (access restrictions or disabled API)',
              },
              observedUpdatedAt,
            };
          }

          return {
            status: 'unknown',
            verification: {
              checkedAt: now,
              source: 'remote',
              message: `Unexpected HTTP status ${response.status} from API verification`,
            },
            observedUpdatedAt,
          };
        } catch (err) {
          return {
            status: 'unknown',
            verification: {
              checkedAt: now,
              source: 'remote',
              message: err instanceof Error ? err.message : 'Network failure during verification',
            },
            observedUpdatedAt,
          };
        }
      }

      default:
        return {
          status: 'unknown',
          verification: {
            checkedAt: now,
            source: 'local',
            message: `Unknown authType '${String((account as Account).authType)}'`,
          },
          observedUpdatedAt,
        };
    }
  }

  /**
   * Verify multiple accounts in parallel, bounded to max 4 concurrent requests.
   * Converted rejected batch promises into per-account unknown results.
   */
  public static async verifyAccounts(
    accounts: Account[],
    options: VerifyOptions = {}
  ): Promise<Map<string, VerificationResult>> {
    const results = new Map<string, VerificationResult>();
    const concurrency = 4;

    for (let i = 0; i < accounts.length; i += concurrency) {
      const chunk = accounts.slice(i, i + concurrency);
      const outcomes = await Promise.allSettled(
        chunk.map((acc) => this.verifyAccount(acc, options))
      );

      for (let j = 0; j < chunk.length; j++) {
        const acc = chunk[j];
        const outcome = outcomes[j];
        if (outcome.status === 'fulfilled') {
          results.set(acc.id, outcome.value);
        } else {
          results.set(acc.id, {
            status: 'unknown',
            verification: {
              checkedAt: Date.now(),
              source: 'remote',
              message: 'Verification task failed',
            },
            observedUpdatedAt: acc.updatedAt,
          });
        }
      }
    }

    return results;
  }
}
