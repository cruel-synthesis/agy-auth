import { QuotaRefresh } from './quota.js';
import { RegistryManager } from './registry.js';
import { Account, Registry } from './types.js';
import { VerificationResult } from './verifier.js';

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function nextTimestamp(previous: number): number {
  return Math.max(Date.now(), previous + 1);
}

/** Quota-derived state worth persisting for this account, if any. */
export function hasApplicableQuotaState(refresh: QuotaRefresh): boolean {
  const { result, tokenUpdate } = refresh;
  return Boolean(
    result.rateLimit !== undefined ||
      result.quotaCheckedAt !== undefined ||
      result.plan !== undefined ||
      result.discoveredProject !== undefined ||
      result.status !== undefined ||
      tokenUpdate
  );
}

/**
 * Write only quota-derived fields onto an account. Credentials, aliases, models
 * and every other account setting are left exactly as the user configured them.
 */
function writeQuotaState(account: Account, refresh: QuotaRefresh): boolean {
  const { result, tokenUpdate } = refresh;
  let changed = false;

  if (result.rateLimit !== undefined) {
    account.rateLimit = clone(result.rateLimit);
    changed = true;
  }
  if (result.quotaCheckedAt !== undefined) {
    account.quotaCheckedAt = result.quotaCheckedAt;
    changed = true;
  }
  if (result.plan !== undefined && result.plan !== account.plan) {
    account.plan = result.plan;
    changed = true;
  }
  // Discovery fills a gap; it never overrides a project the user set.
  if (result.discoveredProject !== undefined && !account.gcpProject) {
    account.gcpProject = result.discoveredProject;
    changed = true;
  }
  if (result.status !== undefined && result.status !== account.status) {
    account.status = result.status;
    changed = true;
  }
  if (tokenUpdate && account.credentials?.keychainPayload) {
    account.credentials.keychainPayload.token = { ...tokenUpdate.token };
    changed = true;
  }

  return changed;
}

/**
 * Apply one quota result to a registry draft under optimistic concurrency: the
 * account must still exist and must not have been touched while the request was
 * in flight.
 */
export function applyQuotaResult(draft: Registry, refresh: QuotaRefresh): boolean {
  const account = draft.accounts.find((a) => a.id === refresh.result.accountId);
  if (!account) return false;
  if (account.updatedAt !== refresh.result.observedUpdatedAt) return false;

  if (!writeQuotaState(account, refresh)) return false;
  account.updatedAt = nextTimestamp(account.updatedAt);
  return true;
}

/**
 * Persist quota results in one locked batch. Routine cache refreshes take no
 * backup: they would otherwise rotate the managed backup set on every `list`.
 */
export async function applyQuotaResults(
  registry: RegistryManager,
  refreshes: QuotaRefresh[]
): Promise<number> {
  const pending = refreshes.filter(hasApplicableQuotaState);
  if (pending.length === 0) return 0;

  return registry.mutate((draft) =>
    pending.reduce((applied, refresh) => applied + (applyQuotaResult(draft, refresh) ? 1 : 0), 0)
  );
}

/**
 * Persist a `list --check` sweep in one locked batch.
 *
 * Status precedence is deterministic: the verifier result lands first, then a
 * decisive quota outcome (success, explicit scope failure, or authentication
 * failure) overrides it. A quota transport or schema failure carries no status,
 * so it can never overwrite a meaningful verifier verdict.
 */
export async function applyCheckResults(
  registry: RegistryManager,
  verifications: Map<string, VerificationResult>,
  quotas: Map<string, QuotaRefresh>
): Promise<number> {
  if (verifications.size === 0 && quotas.size === 0) return 0;

  return registry.mutate((draft) => {
    let applied = 0;

    for (const account of draft.accounts) {
      const verification = verifications.get(account.id);
      const quota = quotas.get(account.id);
      const verificationFresh =
        verification !== undefined && account.updatedAt === verification.observedUpdatedAt;
      const quotaFresh =
        quota !== undefined && account.updatedAt === quota.result.observedUpdatedAt;

      if (!verificationFresh && !quotaFresh) continue;

      let changed = false;
      if (verificationFresh && verification) {
        // `unverified` means the local shape was acceptable but no decisive
        // remote verdict was available. Keep a stronger existing status.
        if (
          verification.status !== 'unverified' ||
          account.status === 'invalid' ||
          account.status === 'unknown'
        ) {
          account.status = verification.status;
        }
        account.verification = verification.verification;
        changed = true;
      }
      if (quotaFresh && quota) {
        changed = writeQuotaState(account, quota) || changed;
      }

      if (changed) {
        account.updatedAt = nextTimestamp(account.updatedAt);
        applied++;
      }
    }

    return applied;
  });
}
