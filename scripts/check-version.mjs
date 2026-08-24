import fs from 'node:fs';

const packageDocument = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')
);
const lockDocument = JSON.parse(
  fs.readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8')
);
const versionSource = fs.readFileSync(new URL('../src/version.ts', import.meta.url), 'utf8');
const changelog = fs.readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');

const packageVersion = packageDocument.version;
const runtimeMatch = versionSource.match(/VERSION\s*=\s*['"]([^'"]+)['"]/);
const changelogMatch = changelog.match(/^##\s+([^\s]+)\s+-/m);

const observed = {
  'package-lock.json': lockDocument.version,
  'package-lock.json root package': lockDocument.packages?.['']?.version,
  'src/version.ts': runtimeMatch?.[1],
  'CHANGELOG.md': changelogMatch?.[1],
};

for (const [source, version] of Object.entries(observed)) {
  if (version !== packageVersion) {
    throw new Error(
      `Version mismatch: package.json is ${packageVersion}, but ${source} is ${String(version)}.`
    );
  }
}

console.log(`Version sources agree on ${packageVersion}.`);
