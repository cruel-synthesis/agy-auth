import { describe, expect, it, vi } from 'vitest';
import { KeychainManager } from '../src/core/keychain.js';

describe('KeychainManager Subsystem', () => {
  it('detects platform support and returns unsupported / false when unsupported', () => {
    const isSupportedSpy = vi.spyOn(KeychainManager, 'isSupported').mockReturnValue(false);

    expect(KeychainManager.readAgyTokenState()).toEqual({ status: 'unsupported' });
    expect(
      KeychainManager.writeAgyToken({
        auth_method: 'consumer',
        token: { access_token: 'a', refresh_token: 'r' },
      })
    ).toBe(false);
    expect(KeychainManager.deleteAgyToken()).toBe(false);

    isSupportedSpy.mockRestore();
  });

  it('handles readAgyTokenState with mocked security CLI outputs', () => {
    const isSupportedSpy = vi.spyOn(KeychainManager, 'isSupported').mockReturnValue(true);

    // 1. Missing password (status 44)
    const missingExec = vi
      .spyOn(KeychainManager, 'execSecurity')
      .mockReturnValue({ error: new Error('Missing'), status: 44 });
    expect(KeychainManager.readAgyTokenState().status).toBe('missing');
    missingExec.mockRestore();

    // 2. Generic error
    const errExec = vi
      .spyOn(KeychainManager, 'execSecurity')
      .mockReturnValue({ error: new Error('Denied') });
    expect(KeychainManager.readAgyTokenState().status).toBe('error');
    errExec.mockRestore();

    // 3. Empty stdout
    const emptyExec = vi.spyOn(KeychainManager, 'execSecurity').mockReturnValue({ stdout: '   ' });
    expect(KeychainManager.readAgyTokenState().status).toBe('missing');
    emptyExec.mockRestore();

    // 4. Valid base64 payload
    const validPayload = {
      auth_method: 'consumer',
      token: { access_token: 'ya29.keychain-tok', refresh_token: '1//ref' },
    };
    const b64 = Buffer.from(JSON.stringify(validPayload)).toString('base64');
    const validExec = vi
      .spyOn(KeychainManager, 'execSecurity')
      .mockReturnValue({ stdout: `go-keyring-base64:${b64}\n` });

    const state = KeychainManager.readAgyTokenState();
    expect(state.status).toBe('found');
    if (state.status === 'found') {
      expect(state.payload.token.access_token).toBe('ya29.keychain-tok');
    }
    validExec.mockRestore();

    // 5. Invalid JSON payload
    const invalidJsonB64 = Buffer.from('invalid-json').toString('base64');
    const invalidExec = vi
      .spyOn(KeychainManager, 'execSecurity')
      .mockReturnValue({ stdout: invalidJsonB64 });
    expect(KeychainManager.readAgyTokenState().status).toBe('error');
    invalidExec.mockRestore();

    // 6. Valid JSON but invalid schema payload
    const badSchemaB64 = Buffer.from(JSON.stringify({ not_token: 123 })).toString('base64');
    const badSchemaExec = vi
      .spyOn(KeychainManager, 'execSecurity')
      .mockReturnValue({ stdout: badSchemaB64 });
    expect(KeychainManager.readAgyTokenState().status).toBe('error');
    badSchemaExec.mockRestore();

    isSupportedSpy.mockRestore();
  });

  it('handles writeAgyToken and deleteAgyToken via security CLI', () => {
    const isSupportedSpy = vi.spyOn(KeychainManager, 'isSupported').mockReturnValue(true);
    const execSpy = vi.spyOn(KeychainManager, 'execSecurity').mockReturnValue({ stdout: '' });

    try {
      const payload = {
        auth_method: 'consumer',
        token: { access_token: 'ya29.tok', refresh_token: '1//tok' },
      };
      expect(KeychainManager.writeAgyToken(payload)).toBe(true);
      expect(KeychainManager.deleteAgyToken()).toBe(true);

      // Invalid payload
      expect(
        KeychainManager.writeAgyToken({ auth_method: 'consumer' } as unknown as typeof payload)
      ).toBe(false);
    } finally {
      isSupportedSpy.mockRestore();
      execSpy.mockRestore();
    }
  });

  it('rejects whitespace-only Keychain tokens and authentication methods', () => {
    const supportSpy = vi.spyOn(KeychainManager, 'isSupported').mockReturnValue(true);
    const execSpy = vi.spyOn(KeychainManager, 'execSecurity').mockReturnValue({ stdout: '' });

    try {
      for (const accessToken of ['   ', '\t\n ']) {
        const encoded = Buffer.from(
          JSON.stringify({
            auth_method: 'consumer',
            token: { access_token: accessToken, refresh_token: '' },
          })
        ).toString('base64');
        execSpy.mockReturnValue({ stdout: `go-keyring-base64:${encoded}\n` });

        expect(KeychainManager.readAgyTokenState().status).toBe('error');
        expect(
          KeychainManager.writeAgyToken({
            auth_method: 'consumer',
            token: { access_token: accessToken, refresh_token: '' },
          })
        ).toBe(false);
      }

      for (const authMethod of ['   ', '\t\n ']) {
        expect(
          KeychainManager.writeAgyToken({
            auth_method: authMethod,
            token: { access_token: 'synthetic-access-token', refresh_token: '' },
          })
        ).toBe(false);
      }
    } finally {
      supportSpy.mockRestore();
      execSpy.mockRestore();
    }
  });
});
