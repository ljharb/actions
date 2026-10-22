# actions
GitHub actions I use for CI.

## `cache-mode`

The reusable workflows declare a least-privilege [`cache-mode`](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#cache-mode) on each job.

- `node`, `node-majors`, `node-esm`, `browser`, and `bun`: test jobs declare `read`, so callers must not set `cache-mode` to `none` or `write-only` on the calling job or workflow — the run would fail validation. Callers that pass `build-output-dir` must also not cap at `read`: the `build` job relies on the trigger's default (`write`) to save the build output.
- `pretest` and `rebase`: every job declares `none`, which is compatible with any caller setting.

## The fleet GitHub App

A GitHub App, installed on the repositories to manage, lets scheduled jobs in this repo work across all of them, with no per-repository workflow.

### Setup

1. Create a GitHub App (no webhook needed) with these repository permissions: Contents (read) and Metadata (read).
2. Install it on each account, for all or selected repositories. Installing it is what opts a repository in. (Installing it on more than one account requires making it public, which lets anyone install it; see `FLEET_ACCOUNTS`.)
3. In this repo, set the `FLEET_APP_ID` Actions variable to the App’s ID or client ID, and the `FLEET_APP_PRIVATE_KEY` Actions secret to one of its private keys. Without `FLEET_APP_ID`, the fleet workflows are skipped.
4. Set the `FLEET_ACCOUNTS` Actions variable to the space-separated accounts (users and organizations) whose installations may be processed, eg `ljharb es-shims inspect-js`. Installations on any other account are ignored. When unset, only this repo’s owner is allowed.
5. Optionally, set the `FLEET_SOURCE_ACCOUNTS` Actions variable to the space-separated accounts whose repositories may be checked as the source of a fork (see below).

### Configuration

Optionally, `.github/ljharb-actions.json` on a repository’s default branch, and `ljharb-actions.json` at the root of the default branch of an account’s `.github` repository, which sets defaults for every repository in that account:

```json
{
  "workflows": { "node-twenties.yml": true, "rebase.yml": false }
}
```

- `workflows`: `false` to opt out of the workflow drift report; `true`, or an object mapping workflow file names to `true` (expected: report it if missing) or `false` (ignored: never report it), to opt in.

A repository’s own file takes precedence over its account’s defaults, key by key:
a key the repository doesn’t set uses the account’s default,
a `false` from the repository always wins,
and when both set an object, the two are merged,
with the repository’s entries winning.
The account’s defaults are only read if the App can read its `.github` repository:
install it there too, or keep that repository public.

Forks are never checked. A fork’s source is checked instead (by the workflow drift report only, since the App isn’t installed on it) when it’s public, unarchived, not ignored, its owner is in the `FLEET_SOURCE_ACCOUNTS` Actions variable (space-separated accounts; unset means none) and has no installation of the App, and its default branch has a commit whose committer is this repo’s owner. The App can’t see anyone’s permissions on a repository it isn’t installed on, so that commit stands in for write access; it also counts commits from a PR merged with a merge commit, so `FLEET_SOURCE_ACCOUNTS` is the real gate. A source’s account defaults aren’t read.

An account’s `.github` repository is skipped by the workflow drift report unless its own `.github/ljharb-actions.json`
(that is, `.github/ljharb-actions.json` inside the `.github` repository, eg `{ "workflows": true }`)
sets `workflows`; the account defaults in its root `ljharb-actions.json` don’t opt it in.
Archived repositories are always skipped.

### Workflow drift report

`fleet-drift.yml`, in this repo, runs daily
(and on `workflow_dispatch`, optionally as a dry run).
It compares the workflow files of every repository the App is installed on against the templates in `fleet/drift/templates`,
and keeps a single issue in this repo up to date with the discrepancies
(reopening it as needed, and closing it when there are none).
It only reads; it never changes another repository.

- `rebase.yml`, `node-pretest.yml`, and `require-allow-edits.yml` are expected in every repository.
- node tests go in `node.yml`, split into one workflow file per decade of node majors (`node-aught.yml` for `< 10`, including io.js, then `node-tens.yml`, `node-twenties.yml`, and so on) only when one file’s job matrix would exceed GitHub’s limit of 256 jobs. Which of them a repository should have comes from its `package.json`’s `engines.node`, the matrix `type` its node workflow files use (`minors` unless they all use `majors`), and the released versions that the `node/matrix` action uses: `node.yml` when all of the versions that satisfy `engines.node` fit in one file; otherwise, one file per decade from the first with such a version, until the last, open-ended one fits. Any other such file is unexpected. Without `engines.node`, they’re only compared when present.
- Template placeholders (`{{range}}`, `{{type}}`, `{{command}}`, `{{label}}`) match any one-line value, so legitimately per-repository values aren’t drift; a placeholder that appears twice must have the same value both times.
- Other workflow files are not reported.
- Private repositories are only counted, never named, since the issue is public. A run that couldn’t check every repository says so, and never closes the issue.
