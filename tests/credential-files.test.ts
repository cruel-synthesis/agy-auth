import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CredentialFiles } from '../src/core/credential-files.js';
import {
  isEmail,
  validateAccountCredentials,
  validateAdcDocument,
  validateServiceAccountKey,
} from '../src/core/credential-validation.js';
import { generateSyntheticPrivateKey, setupTestEnvironment, TestEnv } from './test-utils.js';

describe('Credential Files Loader and Validation', () => {
  let testEnv: TestEnv;

  beforeEach(() => {
    testEnv = setupTestEnvironment();
  });

  afterEach(() => {
    testEnv.cleanup();
  });

  it('validates email addresses using isEmail', () => {
    expect(isEmail('user@example.com')).toBe(true);
    expect(isEmail('user.name+tag@sub.domain.org')).toBe(true);
    expect(isEmail('')).toBe(false);
    expect(isEmail('invalid-email')).toBe(false);
    expect(isEmail('user@')).toBe(false);
    expect(isEmail('@domain.com')).toBe(false);
    expect(isEmail('user @domain.com')).toBe(false);
  });

  it('validates account credential compatibility and rejects mixed or missing credentials', () => {
    // Missing credentials
    expect(validateAccountCredentials({ authType: 'api-key' }).ok).toBe(false);
    expect(validateAccountCredentials(null as unknown as { authType: 'api-key' }).ok).toBe(false);

    // Valid API Key
    expect(
      validateAccountCredentials({
        authType: 'api-key',
        credentials: { apiKey: 'AIzaSyValidKey' },
      }).ok
    ).toBe(true);

    // Invalid API Key (empty string)
    expect(
      validateAccountCredentials({
        authType: 'api-key',
        credentials: { apiKey: '' },
      }).ok
    ).toBe(false);

    // Invalid API Key (mixed with SA key)
    expect(
      validateAccountCredentials({
        authType: 'api-key',
        credentials: {
          apiKey: 'AIzaSyValidKey',
          serviceAccountKey: { type: 'service_account' },
        },
      }).ok
    ).toBe(false);

    // Valid OAuth
    expect(
      validateAccountCredentials({
        authType: 'oauth',
        credentials: {
          keychainPayload: {
            auth_method: 'consumer',
            token: { access_token: 'ya29.token', refresh_token: '1//refresh' },
          },
        },
      }).ok
    ).toBe(true);

    // Invalid OAuth (empty token)
    expect(
      validateAccountCredentials({
        authType: 'oauth',
        credentials: {
          keychainPayload: {
            auth_method: 'consumer',
            token: { access_token: '', refresh_token: '' },
          },
        },
      }).ok
    ).toBe(false);

    // Invalid OAuth (mixed with apiKey)
    expect(
      validateAccountCredentials({
        authType: 'oauth',
        credentials: {
          apiKey: 'key',
          keychainPayload: {
            auth_method: 'consumer',
            token: { access_token: 'ya29.token', refresh_token: '1//refresh' },
          },
        },
      }).ok
    ).toBe(false);

    // Valid Service Account
    const pem = generateSyntheticPrivateKey();
    expect(
      validateAccountCredentials({
        authType: 'service-account',
        credentials: {
          serviceAccountKey: {
            type: 'service_account',
            client_email: 'sa@proj.iam.gserviceaccount.com',
            project_id: 'proj',
            private_key: pem,
          },
        },
      }).ok
    ).toBe(true);

    // Invalid Service Account (missing key payload)
    expect(
      validateAccountCredentials({
        authType: 'service-account',
        credentials: {},
      }).ok
    ).toBe(false);

    // Valid ADC
    expect(
      validateAccountCredentials({
        authType: 'adc',
        credentials: { adcPath: '/path/to/adc.json' },
      }).ok
    ).toBe(true);

    // Invalid ADC (mixed with API key)
    expect(
      validateAccountCredentials({
        authType: 'adc',
        credentials: { adcPath: '/path/to/adc.json', apiKey: 'key' },
      }).ok
    ).toBe(false);

    // Unsupported authType
    expect(
      validateAccountCredentials({
        authType: 'unknown-auth' as unknown as 'api-key',
        credentials: {},
      }).ok
    ).toBe(false);
  });

  it('loads and cryptographically validates valid Service Account key JSON', () => {
    const pem = generateSyntheticPrivateKey();
    const saPayload = {
      type: 'service_account',
      project_id: 'sample-project-123',
      private_key_id: 'key123',
      private_key: pem,
      client_email: 'sa@sample-project-123.iam.gserviceaccount.com',
      client_id: '123456789',
      universe_domain: 'googleapis.com',
    };

    const filePath = path.join(testEnv.dir, 'valid-sa.json');
    fs.writeFileSync(filePath, JSON.stringify(saPayload));

    const loaded = CredentialFiles.loadServiceAccountKeyFile(filePath);
    expect(loaded.client_email).toBe(saPayload.client_email);
    expect(loaded.project_id).toBe(saPayload.project_id);
    expect(loaded.universe_domain).toBe('googleapis.com');
    expect(validateServiceAccountKey(loaded).ok).toBe(true);
  });

  it('rejects Service Account files with invalid PEM keys or missing fields', () => {
    const badSa = {
      type: 'service_account',
      client_email: 'sa@sample.iam.gserviceaccount.com',
      private_key: 'NOT-A-REAL-PEM-KEY',
    };

    const filePath = path.join(testEnv.dir, 'bad-sa.json');
    fs.writeFileSync(filePath, JSON.stringify(badSa));

    expect(() => CredentialFiles.loadServiceAccountKeyFile(filePath)).toThrow(
      /not a parseable PEM private key/
    );

    // Missing private_key
    expect(
      validateServiceAccountKey({
        type: 'service_account',
        client_email: 'sa@example.com',
      }).ok
    ).toBe(false);

    // Missing client_email
    expect(
      validateServiceAccountKey({
        type: 'service_account',
        private_key: generateSyntheticPrivateKey(),
      }).ok
    ).toBe(false);
  });

  it('loads and validates ADC files for authorized_user and rejects external_account', () => {
    const authorizedUserAdc = {
      type: 'authorized_user',
      client_id: 'client.apps.googleusercontent.com',
      client_secret: 'secret123',
      refresh_token: '1//refresh_token_abc',
    };

    const adcFile = path.join(testEnv.dir, 'gcloud_adc.json');
    fs.writeFileSync(adcFile, JSON.stringify(authorizedUserAdc));

    const loaded = CredentialFiles.loadAdcFile(adcFile);
    expect(loaded.type).toBe('authorized_user');
    expect(validateAdcDocument(loaded).ok).toBe(true);

    // Missing refresh_token in authorized_user
    expect(validateAdcDocument({ type: 'authorized_user', client_id: 'c' }).ok).toBe(false);
    const incompleteFile = path.join(testEnv.dir, 'incomplete_adc.json');
    fs.writeFileSync(
      incompleteFile,
      JSON.stringify({ type: 'authorized_user', client_id: 'client.apps.googleusercontent.com' })
    );
    expect(() => CredentialFiles.loadAdcFile(incompleteFile)).toThrow(/missing client_secret/);

    // Non-object document
    expect(validateAdcDocument(null).ok).toBe(false);

    // Test external_account rejection
    const externalAccount = {
      type: 'external_account',
      audience: '//iam.googleapis.com/...',
    };
    const extFile = path.join(testEnv.dir, 'external_adc.json');
    fs.writeFileSync(extFile, JSON.stringify(externalAccount));

    expect(() => CredentialFiles.loadAdcFile(extFile)).toThrow(
      /unsupported ADC credential type 'external_account'/i
    );
  });

  it('rejects symlink files for credential loaders', () => {
    if (process.platform === 'win32') return;

    const realFile = path.join(testEnv.dir, 'real-file.json');
    fs.writeFileSync(realFile, JSON.stringify({ type: 'service_account' }));

    const symlinkFile = path.join(testEnv.dir, 'symlink-sa.json');
    fs.symlinkSync(realFile, symlinkFile);

    expect(() => CredentialFiles.loadServiceAccountKeyFile(symlinkFile)).toThrow(/symbolic link/i);
  });
});
