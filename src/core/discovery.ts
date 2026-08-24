import fs from 'node:fs';
import { CredentialFiles } from './credential-files.js';
import { isEmail } from './credential-validation.js';
import { Paths } from './paths.js';
import { AccountCredentials, AuthType } from './types.js';

export interface AntigravitySettings {
  gcp?: {
    project?: string;
    location?: string;
  };
  model?: string;
  [key: string]: unknown;
}

export interface DiscoveredAccount {
  email?: string;
  authType: AuthType;
  gcpProject?: string;
  credentials?: AccountCredentials;
}

export class Discovery {
  public static discoverFromAdc(): DiscoveredAccount | null {
    const adcPath = Paths.gcloudAdcFile;
    try {
      const record = CredentialFiles.loadAdcFile(adcPath) as Record<string, unknown>;
      if (record.type === 'service_account') {
        return {
          email: String(record.client_email),
          authType: 'adc',
          gcpProject: typeof record.project_id === 'string' ? record.project_id : undefined,
          credentials: {
            adcPath,
          },
        };
      }

      if (record.type === 'authorized_user') {
        return {
          email:
            typeof record.account === 'string' && isEmail(record.account)
              ? record.account.trim()
              : undefined,
          authType: 'adc',
          gcpProject:
            typeof record.quota_project_id === 'string' ? record.quota_project_id : undefined,
          credentials: {
            adcPath,
          },
        };
      }
    } catch {
      // ignore
    }

    return null;
  }

  public static readAntigravitySettings(): AntigravitySettings | null {
    const settingsPath = Paths.antigravitySettingsFile;
    if (!fs.existsSync(settingsPath)) return null;

    try {
      const raw = fs.readFileSync(settingsPath, 'utf-8');
      return JSON.parse(raw) as AntigravitySettings;
    } catch {
      return null;
    }
  }
}
