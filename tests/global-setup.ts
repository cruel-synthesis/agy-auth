import fs from 'node:fs';

export function setup(): () => void {
  const rootDir = process.cwd();
  const beforeFiles = new Set(fs.readdirSync(rootDir));

  return () => {
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
