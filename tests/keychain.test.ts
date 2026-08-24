import { describe, expect, it, vi } from 'vitest';
import { KeychainManager, parseAgyKeychainPayload } from '../src/core/keychain.js';

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

  it('validates and normalizes Keychain payloads via parseAgyKeychainPayload', () => {
    // Missing auth_method
    expect(parseAgyKeychainPayload({ token: { access_token: 'ya29.tok' } })).toBeNull();

    // Empty or whitespace-only auth_method
    for (const badAuth of ['', '   ', '\t\n ']) {
      expect(
        parseAgyKeychainPayload({ auth_method: badAuth, token: { access_token: 'ya29.tok' } })
      ).toBeNull();
    }

    // Empty or whitespace-only access_token
    for (const badTok of ['', '   ', '\t\n ']) {
      expect(
        parseAgyKeychainPayload({ auth_method: 'consumer', token: { access_token: badTok } })
      ).toBeNull();
    }

    // Non-object or invalid types
    expect(parseAgyKeychainPayload(null)).toBeNull();
    expect(parseAgyKeychainPayload('string')).toBeNull();
    expect(parseAgyKeychainPayload([])).toBeNull();

    // Valid payload with omitted optional refresh_token -> safely normalized
    const normalized = parseAgyKeychainPayload({
      auth_method: 'consumer',
      token: { access_token: 'ya29.exact-token-val' },
    });
    expect(normalized).not.toBeNull();
    expect(normalized?.auth_method).toBe('consumer');
    expect(normalized?.token.access_token).toBe('ya29.exact-token-val');
    expect(normalized?.token.refresh_token).toBe('');

    // Exact preservation of access token without mutation or trimming
    const tokenWithSpecialChars = 'ya29.test-token/special==';
    const parsed = parseAgyKeychainPayload({
      auth_method: 'consumer',
      token: { access_token: tokenWithSpecialChars, refresh_token: '1//ref' },
    });
    expect(parsed?.token.access_token).toBe(tokenWithSpecialChars);
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

    // 7. Empty and whitespace-only access tokens
    for (const badToken of ['', '   ', '\t\n ']) {
      const payload = {
        auth_method: 'consumer',
        token: { access_token: badToken, refresh_token: '' },
      };
      const badTokenB64 = Buffer.from(JSON.stringify(payload)).toString('base64');
      const badTokenExec = vi
        .spyOn(KeychainManager, 'execSecurity')
        .mockReturnValue({ stdout: `go-keyring-base64:${badTokenB64}\n` });

      const res = KeychainManager.readAgyTokenState();
      expect(res.status).toBe('error');
      expect(res).not.toMatchObject({ status: 'found' });
      badTokenExec.mockRestore();
    }

    // 8. Missing and whitespace-only auth_method
    for (const badAuth of [undefined, '', '   ', '\t\n ']) {
      const payload = {
        ...(badAuth !== undefined ? { auth_method: badAuth } : {}),
        token: { access_token: 'ya29.tok', refresh_token: '' },
      };
      const badAuthB64 = Buffer.from(JSON.stringify(payload)).toString('base64');
      const badAuthExec = vi
        .spyOn(KeychainManager, 'execSecurity')
        .mockReturnValue({ stdout: `go-keyring-base64:${badAuthB64}\n` });

      const res = KeychainManager.readAgyTokenState();
      expect(res.status).toBe('error');
      expect(res).not.toMatchObject({ status: 'found' });
      badAuthExec.mockRestore();
    }

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

      // Invalid payload (missing token)
      expect(
        KeychainManager.writeAgyToken({ auth_method: 'consumer' } as unknown as typeof payload)
      ).toBe(false);

      // Missing or whitespace-only auth_method when writing
      for (const badAuth of ['', '   ', '\t\n ']) {
        expect(
          KeychainManager.writeAgyToken({
            auth_method: badAuth,
            token: { access_token: 'ya29.tok', refresh_token: '' },
          })
        ).toBe(false);
      }

      // Rejects empty or whitespace-only access tokens when writing
      for (const badToken of ['', '   ', '\t\n ']) {
        expect(
          KeychainManager.writeAgyToken({
            auth_method: 'consumer',
            token: { access_token: badToken, refresh_token: '' },
          })
        ).toBe(false);
      }
    } finally {
      isSupportedSpy.mockRestore();
      execSpy.mockRestore();
    }
  });
});
