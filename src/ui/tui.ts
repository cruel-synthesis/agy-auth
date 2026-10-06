import readline from 'node:readline';
import { CancellationError, UsageError } from '../core/errors.js';
import { Account } from '../core/types.js';
import { renderSelectMenu } from './table.js';

interface PromptSelectOptions {
  input?: NodeJS.ReadableStream & { setRawMode?: (mode: boolean) => void; isTTY?: boolean };
  output?: NodeJS.WritableStream;
  maxWidthOverride?: number;
}

export async function promptSelectAccount(
  accounts: Account[],
  activeAccountId: string | null,
  message = 'Select account to activate:',
  options: PromptSelectOptions = {}
): Promise<Account | null> {
  if (accounts.length === 0) return null;

  const input = (options.input || process.stdin) as NodeJS.ReadStream;
  const output = (options.output || process.stdout) as NodeJS.WriteStream;

  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    throw new UsageError('Interactive account picker requires an interactive TTY terminal.');
  }

  const initialIndex = activeAccountId ? accounts.findIndex((a) => a.id === activeAccountId) : 0;
  let selectedIndex = initialIndex >= 0 ? initialIndex : 0;
  let typedBuffer = '';
  let typedBufferTimeout: NodeJS.Timeout | null = null;
  let previousLineCount = 0;

  const render = (): void => {
    try {
      const rendered = renderSelectMenu(
        accounts,
        activeAccountId,
        selectedIndex,
        typedBuffer,
        message,
        options.maxWidthOverride
      );
      const lines = rendered.split('\n');

      if (previousLineCount > 0) {
        output.write(`\x1b[${previousLineCount}A\x1b[0J`);
      }

      output.write(`${lines.join('\n')}\n`);
      previousLineCount = lines.length;
    } catch {
      // Ignore render errors during rapid teardown
    }
  };

  const cleanup = (): void => {
    try {
      if (typedBufferTimeout) clearTimeout(typedBufferTimeout);
      output.write('\x1b[?25h'); // restore cursor
      if (typeof input.setRawMode === 'function') {
        input.setRawMode(false);
      }
      input.pause();
    } catch {
      // ignore teardown errors
    }
  };

  return new Promise<Account | null>((resolve, reject) => {
    try {
      readline.emitKeypressEvents(input);
      if (typeof input.setRawMode === 'function') {
        input.setRawMode(true);
      }
      input.resume();
      output.write('\x1b[?25l'); // hide cursor
      render();
    } catch (err) {
      cleanup();
      reject(err);
      return;
    }

    const onSigInt = (): void => {
      cleanup();
      input.removeListener('keypress', onKeypress);
      process.removeListener('SIGINT', onSigInt);
      reject(new CancellationError('Operation cancelled by user (SIGINT).'));
    };

    process.once('SIGINT', onSigInt);

    const onKeypress = (_str: string, key: readline.Key): void => {
      if (!key) return;

      // Handle Ctrl+C
      if (key.ctrl && key.name === 'c') {
        cleanup();
        input.removeListener('keypress', onKeypress);
        process.removeListener('SIGINT', onSigInt);
        reject(new CancellationError('Operation cancelled.'));
        return;
      }

      // Handle Escape or 'q'
      if (key.name === 'escape' || (_str === 'q' && !typedBuffer)) {
        cleanup();
        input.removeListener('keypress', onKeypress);
        process.removeListener('SIGINT', onSigInt);
        resolve(null);
        return;
      }

      // Handle Enter / Return
      if (key.name === 'return' || key.name === 'enter') {
        cleanup();
        input.removeListener('keypress', onKeypress);
        process.removeListener('SIGINT', onSigInt);
        resolve(accounts[selectedIndex]);
        return;
      }

      // Navigation: Up / Down or j / k
      if (key.name === 'up' || (_str === 'k' && !typedBuffer)) {
        selectedIndex = (selectedIndex - 1 + accounts.length) % accounts.length;
        render();
        return;
      }

      if (key.name === 'down' || (_str === 'j' && !typedBuffer)) {
        selectedIndex = (selectedIndex + 1) % accounts.length;
        render();
        return;
      }

      // Direct numeric jump (e.g. 1, 2, 3) or typing alias filter
      if (_str && _str.length === 1 && _str >= ' ' && _str <= '~') {
        typedBuffer += _str;
        if (typedBufferTimeout) clearTimeout(typedBufferTimeout);
        typedBufferTimeout = setTimeout(() => {
          typedBuffer = '';
          render();
        }, 1500);

        // Check if typedBuffer is a number (1-based)
        const num = parseInt(typedBuffer, 10);
        if (!Number.isNaN(num) && num >= 1 && num <= accounts.length) {
          selectedIndex = num - 1;
        } else {
          // Substring search on alias or email
          const matchIdx = accounts.findIndex(
            (a) =>
              a.alias?.toLowerCase().includes(typedBuffer.toLowerCase()) ||
              a.email.toLowerCase().includes(typedBuffer.toLowerCase())
          );
          if (matchIdx >= 0) {
            selectedIndex = matchIdx;
          }
        }
        render();
      }
    };

    input.on('keypress', onKeypress);
  });
}
