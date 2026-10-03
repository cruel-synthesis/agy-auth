import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function setup(): () => void {
  const rootDir = process.cwd();
  const beforeFiles = new Set(fs.readdirSync(rootDir));
  // The home every test worker starts in; see setup-hermetic.ts.
  const scratchHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hermetic-'));
  process.env.AGY_TEST_SCRATCH_HOME = scratchHome;

  return () => {
    fs.rmSync(scratchHome, { recursive: true, force: true });
    // Teardown hook invoked after all tests have completed
    const afterFiles = fs.readdirSync(rootDir);
    const unexpectedFiles = afterFiles.filter(
      (file) =>
        !beforeFiles.has(file) && !['dist', 'coverage', 'node_modules', '.git'].includes(file)
    );

    if (unexpectedFiles.length > 0) {
      throw new Error(
        `Test suite left unexpected files in repository root: ${unexpectedFiles.join(', ')}. Tests must isolate all file operations to temporary directories.`
      );
    }
  };
}
