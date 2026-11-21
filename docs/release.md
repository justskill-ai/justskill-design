# Releasing

A release is a tag. Pushing `vX.Y.Z` makes GitHub Actions run
[`publish.yml`](../.github/workflows/publish.yml): it checks the tag against
`package.json`, runs the suite, and publishes to npm over OIDC trusted
publishing. No npm token exists on any machine or in any secret, and the workflow
file documents the one-time npm configuration it relies on.

Not translated: a maintainer checklist, like `docs/plan*.md`.

## Bump the version

`package.json` is the authority; `npm test` fails unless the other three agree
with it.

| File | What reads it |
|---|---|
| `SKILL.md` → frontmatter `version` | the skill markets |
| `README.md` | the install line a reader copies and runs |
| `README.en.md` | the same line, English |

## Tag and push

```bash
npm test
git commit -am "chore: release X.Y.Z"
git tag -a vX.Y.Z -m "X.Y.Z — <one line>"
git push origin main
git push origin vX.Y.Z          # this is what publishes
gh run list --workflow=publish.yml --limit 1
```

The tag must point at a commit **that contains `publish.yml`**: GitHub reads the
workflow from the pushed ref, so a tag on an older commit publishes nothing.

A prerelease (`X.Y.Z-rc.1`) publishes under `next` rather than `latest`.

## Check it landed

```bash
npm view justskill-design version dist-tags --registry https://registry.npmjs.org/
npm view justskill-design@X.Y.Z _npmUser gitHead dist.attestations --registry https://registry.npmjs.org/
```

- `dist-tags.latest` is the new version
- `_npmUser` is `GitHub Actions <npm-oidc-no-reply@github.com>`; a human account
  means it was published by hand, without provenance
- `gitHead` is the commit the tag points at, and `dist.attestations` exists

The npm page may list the version as `Validating` for a minute or two — npm's
automated review. `latest` has not moved yet. Wait; do not re-release.

## When it fails

| Symptom | Cause | Fix |
|---|---|---|
| Tag pushed, no run | the tag's commit has no `publish.yml` | tag a commit that has it |
| `cannot publish over the previously published versions` | the version exists; **npm never reuses a version number, not even after `npm unpublish`** | bump |
| `ENEEDAUTH` | trusted publisher fields do not match the workflow exactly, or “Allow npm publish” is unticked | fix the npm-side configuration |
| `403 You do not have permission` | `id-token: write` missing, so OIDC was never detected | restore the permission |

## Undoing

```bash
npm unpublish justskill-design@X.Y.Z --registry https://registry.npmjs.org/
```

Allowed within 72 hours when nothing depends on the version and it has fewer than
300 weekly downloads. Delete the git tag as well: the workbench's update reminder
reads GitHub tags, so a tag whose version cannot be installed advertises an
upgrade that always fails.

## Losing a device, or handing over

Publishing needs nothing from your account — CI holds the only credential and it
lives for minutes. A lost 2FA device therefore blocks *account settings*, not
releases. Still worth two minutes:

- **Recovery codes**, from the npm 2FA settings, stored somewhere that is not the
  2FA device. A code gets you in, but it also starts a 72-hour hold on publishing
  and settings changes: it recovers the account, not the afternoon.
- **A linked GitHub account** (Account → Linked Accounts & Recovery Option), the
  fallback once the codes are gone.
- **A second security key** on another device, if npm offers it. One passkey is a
  single point of failure; two are not.

Never add a bypass-2FA automation token as a backup. It trades “I lost my device”
for “someone else holds a permanent publish credential”, which is worse, and
silent.
