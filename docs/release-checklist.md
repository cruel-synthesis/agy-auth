# Release Checklist

Follow this checklist before publishing a new release of `@cruel-synthesis/agy-auth`.

---

## 1. Automated Verification Gates

Run the local verification pipeline:

```bash
npm run check
```

Verify that:
- [ ] Version sources agree (`package.json`, `src/version.ts`)
- [ ] `CHANGELOG.md` has the release version and date
- [ ] Biome formatting check passes (`npm run format:check`)
- [ ] Biome linter passes (`npm run lint`)
- [ ] TypeScript compilation passes (`npm run typecheck`)
- [ ] All tests pass and coverage gates are met
- [ ] Repository root is clean after testing

---

## 2. Packaging Verification

Inspect package contents via dry-run:

```bash
npm pack --dry-run
```

Verify that:
- [ ] Package name is `@cruel-synthesis/agy-auth`
- [ ] Binary entry points to `bin/agy-auth.js`
- [ ] No `tests/`, `.github/`, or development config files are included in the tarball
- [ ] Built bundle `dist/cli-bin.js` is included

*(Note: `npm pack --dry-run` is used solely for package-content inspection. Exactly one actual candidate tarball is generated during publication.)*

---

## 3. First Release Bootstrap (`v0.1.0`)

npm Trusted Publishing requires an existing package in the npm registry before repository publishers can be configured. The initial `v0.1.0` release follows this fail-closed bootstrap procedure:

### Step A: Prerequisites & Environment Assertion

Before running commands, confirm that any credential ever exposed in private development history has been revoked and that no private Git history will be copied into the public repository. Confirm `npm whoami` returns `cruel-synthesis` and that account 2FA is active.

```bash
set -euo pipefail

# 1. Assert Node.js 24
node_version="$(node -v)"
if [[ "${node_version}" != v24.* ]]; then
  echo "ERROR: Node.js 24 required, found ${node_version}" >&2
  exit 1
fi

# 2. Clean install dependencies
npm ci

# 3. Verify clean working tree
if [ -n "$(git status --porcelain)" ]; then
  echo "ERROR: Working tree is not clean" >&2
  exit 1
fi

# 4. Verify origin is the intended public repository
origin_url="$(git remote get-url origin)"
if [ "${origin_url}" != "https://github.com/cruel-synthesis/agy-auth.git" ] && \
   [ "${origin_url}" != "git@github.com:cruel-synthesis/agy-auth.git" ]; then
  echo "ERROR: Unexpected origin remote '${origin_url}'" >&2
  exit 1
fi
```

### Step B: Build and Verification

```bash
set -euo pipefail
npm run check
```

### Step C: Build & Validate Single Candidate Tarball

Execute exactly one packaging command and capture the tarball filename and integrity hash:

```bash
set -euo pipefail

pack_json="$(npm pack --ignore-scripts --json)"
tarball="$(node -e 'console.log(JSON.parse(process.argv[1])[0].filename)' "${pack_json}")"
candidate_integrity="$(node -e 'console.log(JSON.parse(process.argv[1])[0].integrity)' "${pack_json}")"

if [ "${tarball}" != "cruel-synthesis-agy-auth-0.1.0.tgz" ]; then
  echo "ERROR: Expected tarball 'cruel-synthesis-agy-auth-0.1.0.tgz', got '${tarball}'" >&2
  exit 1
fi

if [ -z "${candidate_integrity}" ]; then
  echo "ERROR: Candidate integrity hash is empty" >&2
  exit 1
fi
```

If any tracked file changes after this point, discard the candidate tarball and restart at Step A. Do not publish an artifact built from an earlier tree.

### Step D: Push Main Branch and Await CI

```bash
set -euo pipefail
git push origin main
```

Wait until every required GitHub Actions CI matrix job (Ubuntu, macOS, Windows on Node 22 and 24) completes and passes on `main`.

### Step E: Create and Push Verified Release Tag

```bash
set -euo pipefail

git tag v0.1.0
head_commit="$(git rev-parse HEAD)"
tag_commit="$(git rev-parse v0.1.0^{commit})"

if [ "${head_commit}" != "${tag_commit}" ]; then
  echo "ERROR: Tag v0.1.0 (${tag_commit}) does not match HEAD (${head_commit})" >&2
  exit 1
fi

git push origin v0.1.0
```

### Step F: Publish Initial Tarball with 2FA

Publish the verified candidate tarball interactively using the `cruel-synthesis` npm account authenticated with 2FA:

```bash
npm publish "./${tarball}" --access public --ignore-scripts
```

*(Note: This initial bootstrap publication is authenticated with account 2FA and does not carry GitHub Actions OIDC provenance.)*

### Step G: Verify Registry Availability and Integrity

Retrieve published metadata from npm and confirm exact integrity match:

```bash
set -euo pipefail

registry_version="$(npm view @cruel-synthesis/agy-auth@0.1.0 version 2>/dev/null || true)"
registry_integrity="$(npm view @cruel-synthesis/agy-auth@0.1.0 dist.integrity 2>/dev/null || true)"

if [ -z "${registry_version}" ] || [ -z "${registry_integrity}" ]; then
  echo "Registry metadata is not yet exposed by npm. Please wait a moment and rerun this step." >&2
  exit 1
fi

if [ "${registry_version}" != "0.1.0" ]; then
  echo "ERROR: Expected version 0.1.0, got '${registry_version}'" >&2
  exit 1
fi

if [ "${registry_integrity}" != "${candidate_integrity}" ]; then
  echo "ERROR: Registry integrity mismatch (${registry_integrity} != ${candidate_integrity})" >&2
  exit 1
fi

echo "Integrity match confirmed: ${registry_integrity}"
```

### Step H: Configure npm Trusted Publishing

In npm package settings (`@cruel-synthesis/agy-auth` -> Settings -> Trusted Publishers -> Add Publisher):
- **Provider**: GitHub Actions
- **GitHub Organization/User**: `cruel-synthesis`
- **Repository Name**: `agy-auth`
- **Workflow Filename**: `release.yml`
- **Environment Name**: `release`
- **Allowed action**: `npm publish`

### Step I: Dispatch Release Workflow

Trigger the GitHub Actions `Release` workflow with input `tag: v0.1.0`. The workflow will:
- Check out the `v0.1.0` tag in GitHub Actions.
- Run `npm run check` and pack the candidate tarball.
- Confirm candidate integrity matches `dist.integrity` on npm, skip duplicate npm publication, and create the official GitHub Release with release notes.

---

## 4. Subsequent Releases (`v0.1.1+`)

All subsequent releases utilize tokenless GitHub Actions Trusted Publishing with automatic OIDC provenance:

1. Tag the release commit and push to GitHub:
   ```bash
   git tag v<version>
   git push origin v<version>
   ```
2. In GitHub Actions, dispatch the `Release` workflow with input `tag: v<version>`.
3. The workflow runs automated checks, publishes the verified tarball with OIDC provenance and lifecycle scripts disabled, and creates the GitHub Release.
