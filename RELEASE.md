# Release Process

Use semver for every release:

- Patch (`x.y.Z`) for bug fixes only.
- Minor (`x.Y.0`) for new features or non-breaking additions.
- Major (`X.0.0`) for breaking changes.

## 1. Prepare The Release

Update `package.json` and `CHANGELOG.md` with the new version and release notes.

Run the checks:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
```

Commit the release changes:

```bash
git add package.json CHANGELOG.md
git commit -m "Prepare v0.8.3 release"
```

## 2. Tag The Release

Create an annotated tag from the release commit:

```bash
git tag -a v0.8.3 -m "v0.8.3"
```

Push `main` and the tag:

```bash
git push origin main
git push origin v0.8.3
```

## 3. Update The Release Branch

Fast-forward the release branch to the tagged commit:

```bash
git switch release
git merge --ff-only v0.8.3
git push origin release
git switch main
```

If `--ff-only` fails, stop and inspect the branch history before continuing.

## 4. Publish Via CI

Publishing is handled by CI after the release tag is pushed. Do not publish locally unless CI is unavailable and the release owner explicitly approves a manual publish.

The manual fallback command is:

```bash
pnpm publish --access public
```

`prepublishOnly` runs `pnpm run build` automatically during publish, but running `pnpm build` before tagging keeps failures local and obvious.

## 5. Verify

Check that the package and tag are available:

```bash
npm view @hexoplon/oxlint-tailwindcss version
git ls-remote --tags origin v0.8.3
```
