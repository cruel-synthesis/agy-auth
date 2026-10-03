import { createPrivateKey } from 'node:crypto';
import { AccountSchema } from './types.js';

export type CredentialValidation = { ok: true } | { ok: false; reason: string };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** An address the registry will accept, so a value that passes here can be saved. */
export function isEmail(value: unknown): boolean {
  return typeof value === 'string' && AccountSchema.shape.email.safeParse(value.trim()).success;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function validateServiceAccountKey(value: unknown): CredentialValidation {
  if (!isRecord(value)) {
    return { ok: false, reason: 'credential payload must be a JSON object' };
  }
  if (value.type !== 'service_account') {
    return { ok: false, reason: "credential type must be 'service_account'" };
  }
  if (!isEmail(value.client_email)) {
    return { ok: false, reason: 'client_email must be a valid email address' };
  }
  if (!isNonEmptyString(value.private_key)) {
    return { ok: false, reason: 'private_key is missing' };
  }

  try {
    createPrivateKey(value.private_key);
  } catch {
    return { ok: false, reason: 'private_key is not a parseable PEM private key' };
  }

  return { ok: true };
}

export function validateAdcDocument(value: unknown): CredentialValidation {
  if (!isRecord(value)) {
    return { ok: false, reason: 'credential file must contain a JSON object' };
  }

  if (value.type === 'service_account') {
    return validateServiceAccountKey(value);
  }

  if (value.type === 'authorized_user') {
    for (const field of ['client_id', 'client_secret', 'refresh_token'] as const) {
      if (!isNonEmptyString(value[field])) {
        return { ok: false, reason: `authorized_user credentials are missing ${field}` };
      }
    }
    return { ok: true };
  }

  if (value.type === 'external_account') {
    return {
      ok: false,
      reason:
        "unsupported ADC credential type 'external_account' (Workload Identity Federation is not supported in v0.1)",
    };
  }

  return {
    ok: false,
    reason: `unsupported ADC credential type '${String(value.type ?? 'missing')}'`,
  };
}

export function validateAccountCredentials(
  account:
    | {
        authType: string;
        credentials?: Record<string, unknown>;
      }
    | null
    | undefined
): CredentialValidation {
  if (!account || typeof account !== 'object') {
    return { ok: false, reason: 'account object is missing' };
  }
  const creds = account.credentials;
  if (!creds || !isRecord(creds)) {
    return { ok: false, reason: 'account credentials object is missing' };
  }

  const { apiKey, keychainPayload, serviceAccountKey, adcPath, ...rest } = creds;

  const extraKeys = Object.keys(rest);
  if (extraKeys.length > 0) {
    return {
      ok: false,
      reason: `credentials object contains unexpected fields: ${extraKeys.join(', ')}`,
    };
  }

  switch (account.authType) {
    case 'api-key': {
      if (
        keychainPayload !== undefined ||
        serviceAccountKey !== undefined ||
        adcPath !== undefined
      ) {
        return {
          ok: false,
          reason: 'api-key account must not contain keychainPayload, serviceAccountKey, or adcPath',
        };
      }
      if (!isNonEmptyString(apiKey)) {
        return { ok: false, reason: 'api-key account must contain a non-empty apiKey' };
      }
      return { ok: true };
    }

    case 'oauth': {
      if (apiKey !== undefined || serviceAccountKey !== undefined || adcPath !== undefined) {
        return {
          ok: false,
          reason: 'oauth account must not contain apiKey, serviceAccountKey, or adcPath',
        };
      }
      if (!isRecord(keychainPayload) || !isRecord(keychainPayload.token)) {
        return {
          ok: false,
          reason: 'oauth account must contain a valid keychainPayload with token',
        };
      }
      const token = keychainPayload.token as Record<string, unknown>;
      if (!isNonEmptyString(token.access_token)) {
        return {
          ok: false,
          reason: 'oauth token must contain a non-empty access_token',
        };
      }
      if (token.refresh_token !== undefined && typeof token.refresh_token !== 'string') {
        return {
          ok: false,
          reason: 'oauth token refresh_token must be a string',
        };
      }
      return { ok: true };
    }

    case 'service-account': {
      if (apiKey !== undefined || keychainPayload !== undefined || adcPath !== undefined) {
        return {
          ok: false,
          reason: 'service-account account must not contain apiKey, keychainPayload, or adcPath',
        };
      }
      if (!isRecord(serviceAccountKey)) {
        return {
          ok: false,
          reason: 'service-account account must contain serviceAccountKey payload',
        };
      }
      return validateServiceAccountKey(serviceAccountKey);
    }

    case 'adc': {
      if (
        apiKey !== undefined ||
        keychainPayload !== undefined ||
        serviceAccountKey !== undefined
      ) {
        return {
          ok: false,
          reason: 'adc account must not contain apiKey, keychainPayload, or serviceAccountKey',
        };
      }
      return { ok: true };
    }

    default:
      return { ok: false, reason: `unsupported authType '${account.authType}'` };
  }
}
