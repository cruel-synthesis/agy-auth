import EventEmitter from 'node:events';
import { describe, expect, it } from 'vitest';
import { CancellationError, UsageError } from '../src/core/errors.js';
import { Account } from '../src/core/types.js';
import { promptSelectAccount } from '../src/ui/tui.js';

class MockStream extends EventEmitter {
  public isTTY = true;
  public written: string[] = [];
  public rawMode = false;

  setRawMode(mode: boolean) {
    this.rawMode = mode;
  }

  write(chunk: string) {
    this.written.push(chunk);
    return true;
  }

  pause() {}
  resume() {}
}

describe('TUI Account Picker', () => {
  const accounts: Account[] = [
    {
      id: 'acc_1',
      email: 'first@example.com',
      alias: 'primary',
      authType: 'oauth',
      status: 'valid',
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: 'acc_2',
      email: 'second@example.com',
      alias: 'secondary',
      authType: 'api-key',
      status: 'valid',
      createdAt: 2,
      updatedAt: 2,
    },
  ];

  it('fails with UsageError in non-TTY mode', async () => {
    const nonTtyInput = new MockStream();
    nonTtyInput.isTTY = false;
    const output = new MockStream();

    await expect(
      promptSelectAccount(accounts, 'acc_2', 'Select:', {
        input: nonTtyInput as unknown as NodeJS.ReadStream,
        output: output as unknown as NodeJS.WriteStream,
      })
    ).rejects.toThrow(UsageError);
  });

  it('selects account on Enter keypress and restores cursor', async () => {
    const input = new MockStream();
    const output = new MockStream();

    const promptPromise = promptSelectAccount(accounts, 'acc_1', 'Select:', {
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
    });

    // Send enter
    input.emit('keypress', '\r', { name: 'return' });

    const result = await promptPromise;
    expect(result?.id).toBe('acc_1');
    expect(input.rawMode).toBe(false);
    // Cursor restored
    expect(output.written.some((w) => w.includes('\x1b[?25h'))).toBe(true);
  });

  it('navigates with up/down arrows and j/k keys and selects with numbers', async () => {
    const input = new MockStream();
    const output = new MockStream();

    const promptPromise = promptSelectAccount(accounts, 'acc_1', 'Select:', {
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
    });

    // Navigate down with down arrow
    input.emit('keypress', '', { name: 'down' });
    // Navigate up with up arrow
    input.emit('keypress', '', { name: 'up' });
    // Navigate down with 'j'
    input.emit('keypress', 'j', { name: 'j' });
    // Navigate up with 'k'
    input.emit('keypress', 'k', { name: 'k' });
    // Jump with numeric key '2'
    input.emit('keypress', '2', { name: '2' });
    // Select
    input.emit('keypress', '\n', { name: 'enter' });

    const result = await promptPromise;
    expect(result?.id).toBe('acc_2');
  });

  it('filters account by typed characters', async () => {
    const input = new MockStream();
    const output = new MockStream();

    const promptPromise = promptSelectAccount(accounts, 'acc_1', 'Select:', {
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
    });

    // Type 's' then 'e'
    input.emit('keypress', 's', { name: 's' });
    input.emit('keypress', 'e', { name: 'e' });
    // Select
    input.emit('keypress', '\r', { name: 'return' });

    const result = await promptPromise;
    expect(result?.id).toBe('acc_2');
  });

  it('resolves null on Escape or q keypress and restores cursor', async () => {
    const input = new MockStream();
    const output = new MockStream();

    const promptPromise = promptSelectAccount(accounts, 'acc_1', 'Select:', {
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
    });

    input.emit('keypress', 'q', { name: 'q' });

    const result = await promptPromise;
    expect(result).toBeNull();
    expect(input.rawMode).toBe(false);
    expect(output.written.some((w) => w.includes('\x1b[?25h'))).toBe(true);
  });

  it('resolves null on Escape key', async () => {
    const input = new MockStream();
    const output = new MockStream();

    const promptPromise = promptSelectAccount(accounts, 'acc_1', 'Select:', {
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
    });

    input.emit('keypress', '', { name: 'escape' });

    const result = await promptPromise;
    expect(result).toBeNull();
  });

  it('throws CancellationError on Ctrl+C and restores cursor', async () => {
    const input = new MockStream();
    const output = new MockStream();

    const promptPromise = promptSelectAccount(accounts, 'acc_1', 'Select:', {
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
    });

    input.emit('keypress', '\x03', { ctrl: true, name: 'c' });

    await expect(promptPromise).rejects.toThrow(CancellationError);
    expect(input.rawMode).toBe(false);
    expect(output.written.some((w) => w.includes('\x1b[?25h'))).toBe(true);
  });
});
