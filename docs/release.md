# Releasing

A release is a tag. Pushing `vX.Y.Z` makes GitHub Actions run
[`publish.yml`](../.github/workflows/publish.yml), which checks the tag, runs the
suite, and publishes to npm over **OIDC trusted publishing**. No npm token
exists on any machine or in any secret: npm accepts this one workflow, for two
minutes at a time, and signs a provenance attestation for every build.

Not translated: this is a maintainer checklist, like `docs/plan*.md`.

## The version lives in five places

| File | What it is |
|---|---|
| `package.json` → `version` | The authority. npm publishes this number. |
| `SKILL.md` → frontmatter `version: "X.Y.Z"` | The skill markets read it; a test asserts it tracks `package.json`. |
| `test/dsh-plugin.test.mjs` | One hardcoded `version: "X.Y.Z"` assertion in the frontmatter test. |
| `README.md` | The `dsh plugin --profile web add justskill-design@X.Y.Z` line. |
| `README.en.md` | The same line, English. |

## Steps

```bash
# 1. bump the five places above
# 2. prove the tree is releasable
npm test

# 3. one commit for the version, one tag for the release
git commit -am "chore: release X.Y.Z"
git tag -a vX.Y.Z -m "X.Y.Z — <one line>"
git push origin main
git push origin vX.Y.Z          # this is what publishes

# 4. watch it
gh run list --workflow=publish.yml --limit 1
gh run watch <run-id> --exit-status
```

The tag must point at a commit **that contains `publish.yml`**: GitHub reads the
workflow from the pushed ref, so a tag on an older commit runs nothing at all.

## What the workflow refuses to do

1. **Publish when the tag and `package.json` disagree.** A published version
   cannot be withdrawn cleanly, so this is checked first.
2. **Publish a version that is already on npm.** Checked in five seconds,
   before the tarball is built — npm itself only says so after packing.
3. **Publish with a red suite.**
4. **Take over `latest` with a prerelease.** A version containing `-` publishes
   under `next` instead.

## npm trusted publishing (one-time per package)

npmjs.com → the package → **Settings → Trusted publisher → GitHub Actions**:

| Field | Value |
|---|---|
| Organization or user | `justskill-ai` |
| Repository | `justskill-design` |
| Workflow filename | `publish.yml` — filename only, exact, with the extension |
| Environment name | empty |
| Allowed actions | **tick “Allow npm publish”** — the default is stage-only, and without it the job authenticates and then publishes nothing |

A new configuration must complete its first successful publish **within two
days** or it expires; the first publish is what validates it.

Once it works, harden the package: **Settings → Publishing access → Require
two-factor authentication and disallow tokens**. Trusted publishing keeps
working; long-lived tokens stop being able to publish.

`--provenance` is not in the workflow on purpose: trusted publishing generates
the attestation automatically, from a public repo.

## Verifying a release

```bash
npm view justskill-design version dist-tags --registry https://registry.npmjs.org/
npm view justskill-design@X.Y.Z _npmUser gitHead dist.attestations --registry https://registry.npmjs.org/

# optional: check what actually got packaged
npm pack justskill-design@X.Y.Z --registry https://registry.npmjs.org/
tar -xzf justskill-design-X.Y.Z.tgz && grep -c justskill-canvas package/dsh/client.js
```

What "right" looks like:

- `dist-tags.latest` = `X.Y.Z`
- `_npmUser` = `GitHub Actions <npm-oidc-no-reply@github.com>` (a human account
  here means it was published by hand, without provenance)
- `gitHead` = the commit the tag points at
- `dist.attestations` present, predicate `https://slsa.dev/provenance/v1`

## Traps, one per release that went wrong

| Symptom | Cause | Fix |
|---|---|---|
| Tag pushed, no run appears | The tag's commit has no `publish.yml` | Tag a commit that has it; delete and re-push the tag |
| `cannot publish over the previously published versions` | The version is already on npm | Bump the version |
| Green run, but `npm view` 404s and the npm page says `Validating` | npm's automated review of a new publish | Wait one or two minutes; do not re-release |
| `ENEEDAUTH` / `Unable to authenticate` | Trusted publisher fields do not match the workflow exactly, or “Allow npm publish” is unticked | Fix the npm configuration |
| `403 You do not have permission` | OIDC was not detected — `id-token: write` missing | Restore the permission |
| The job fails at *The version is not on npm yet* | That version was published by hand earlier | Bump the version |

**A version number is never reusable.** Unpublishing frees the tarball, not the
number: npm rejects any later publish of the same `X.Y.Z`. If 3.3.0 was
unpublished, the next release is 3.3.1, not a retried 3.3.0.

## Undoing a release

```bash
npm unpublish justskill-design@X.Y.Z --registry https://registry.npmjs.org/
```

Allowed within 72 hours when nothing depends on the version and it has fewer
than 300 downloads a week. Then **delete the git tag too**: the workbench's
update reminder reads GitHub tags, so a tag whose version cannot be installed
advertises an upgrade that always fails.

## Why trusted publishing instead of an npm token

An automation token that bypasses 2FA is a permanent credential with publish
rights on this package: leak it once and the package is someone else's until you
notice. Trusted publishing replaces it with a short-lived token minted per job,
scoped to this repository and this workflow file, which cannot be extracted or
reused — and it is also what attaches the provenance statement that lets anyone
check the published bytes were built from this commit.
