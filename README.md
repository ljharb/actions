# actions
GitHub actions I use for CI.

## `cache-mode`

The reusable workflows declare a least-privilege [`cache-mode`](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#cache-mode) on each job.

- `node`, `node-majors`, `node-esm`, `browser`, and `bun`: test jobs declare `read`, so callers must not set `cache-mode` to `none` or `write-only` on the calling job or workflow — the run would fail validation. Callers that pass `build-output-dir` must also not cap at `read`: the `build` job relies on the trigger's default (`write`) to save the build output.
- `pretest` and `rebase`: every job declares `none`, which is compatible with any caller setting.

## The fleet GitHub App

A GitHub App, installed on the repositories to manage, lets scheduled jobs in this repo work across all of them, with no per-repository workflow.

### Setup

1. Create a GitHub App (no webhook needed) with these repository permissions: Contents (read), Metadata (read), and Issues (read and write), which its bot uses to keep the [workflow drift report](#workflow-drift-report) issue up to date, and to react to and reply to [commands](#commands) on it. For the [commands](#commands), it also needs Pull requests (read) for a dry run, and Contents (write), Pull requests (write), and Workflows (write) to open PRs. When a permission is added to an existing App, each installation’s account must approve it (in its settings, under “Applications”, or from GitHub’s email about it) before the App can use it.
2. Install it on each account, for all or selected repositories, including this repo, which holds the report issue. Installing it is what opts a repository in. (Installing it on more than one account requires making it public, which lets anyone install it; see `FLEET_ACCOUNTS`.)
3. In this repo, set the `FLEET_APP_ID` Actions variable to the App’s ID or client ID, and the `FLEET_APP_PRIVATE_KEY` Actions secret to one of its private keys. Without `FLEET_APP_ID`, the fleet workflows (`fleet-drift.yml` and `fleet-commands.yml`) are skipped.
4. Set the `FLEET_ACCOUNTS` Actions variable to the space-separated accounts (users and organizations) whose installations may be processed, eg `ljharb es-shims inspect-js`. Installations on any other account are ignored. When unset, only this repo’s owner is allowed.
5. Optionally, set the `FLEET_SOURCE_ACCOUNTS` Actions variable to the space-separated accounts whose repositories may be checked as the source of a fork (see below).
6. Set the `FLEET_GIST_TOKEN` Actions secret to a token that can read and write the gists of the user it belongs to: a fine-grained personal access token with the “Gists” account permission set to “Read and write” (it needs no repository access), or a classic one with the `gist` scope. The [workflow drift report](#workflow-drift-report) keeps its full report in a secret gist of that user’s; without this secret, it fails before checking anything, saying so.

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
When that repository is private, its defaults apply only to the account’s private repositories (see [Private repositories](#private-repositories)).

Forks are never checked. A fork’s source is checked instead (by the workflow drift report only, since the App isn’t installed on it) when it’s public, unarchived, not ignored, its owner is in the `FLEET_SOURCE_ACCOUNTS` Actions variable (space-separated accounts; unset means none) and has no installation of the App, and its default branch has a commit whose committer is this repo’s owner. The App can’t see anyone’s permissions on a repository it isn’t installed on, so that commit stands in for write access; it also counts commits from a PR merged with a merge commit, so `FLEET_SOURCE_ACCOUNTS` is the real gate. A source’s account defaults aren’t read. A private fork’s source isn’t checked, since that it’s checked at all would show the fork exists.

### Private repositories

This repo is public, and so is everything its fleet workflows output: run logs (including the inputs GitHub shows for each step, and job names), annotations, summaries, step outputs, and the drift report (including its gist, which, though secret, anyone with its link can read) and its replies. So private repositories the App is installed on are processed like any other, but nothing about any one of them is ever output; at most, how many there are, and how many had each kind of outcome (and for [commands](#commands), not even that):

- None is ever named, nor are its files, contents, branches, PRs, errors, or tool output shown. Each has no log line of its own: its outcome is at most counted, in a line after all the public repositories’, so that neither where one would fall among them by name, nor how long one took, is shown.
- An error is only shown for a public repository; a private one’s is at most counted, and never fails anything else. An error not about any one repository (eg, an installation that couldn’t be read) shows only its HTTP status or GraphQL error types, never its message, which could quote what it couldn’t read.
- A [command](#commands) fixes (or, in a dry run, plans) the private repositories its filters match, exactly as it does public ones, so a private repository can be named. But since its filters can be as narrow as one repository, its output says nothing about them at all, not even how many matched or failed: whether any private repository matched, exists, or failed is never confirmed. Its reply always ends with the same sentence saying that any matching private repositories were processed too, so a reply for filters that match only private repositories is identical to one for filters that match nothing. They’re fixed after every public one, with no log line, warning, or annotation of their own, and a private repository’s failure never fails the run; it only shows in that repository itself (eg, as its PR not being opened or updated).
- A private `.github` repository’s defaults apply only to its account’s private repositories: any effect on a public one (a file it requires, ignores, or forbids; or its being invalid) would show in that one’s public report or fix, and so would show what’s in the private file. Its account’s public repositories are treated as if it had no defaults; to share defaults with them, make the `.github` repository public. When those defaults are invalid, a private repository’s error only says so, not what’s wrong.
- An installation on an account that isn’t allowed is skipped without naming the account, which may have installed the App only on its private repositories.

An account’s `.github` repository is skipped by the workflow drift report unless its own `.github/ljharb-actions.json`
(that is, `.github/ljharb-actions.json` inside the `.github` repository, eg `{ "workflows": true }`)
sets `workflows`; the account defaults in its root `ljharb-actions.json` don’t opt it in.
Archived repositories are always skipped.

### Workflow drift report

`fleet-drift.yml`, in this repo, runs daily
(and on `workflow_dispatch`, optionally as a dry run).
It compares the workflow files of every repository the App is installed on against the templates in `fleet/drift/templates`,
keeps the full report in a secret gist (see `FLEET_GIST_TOKEN`, in [Setup](#setup)),
and keeps a single issue in this repo up to date with a summary of the discrepancies that links to it
(reopening it as needed, and closing it when there are none).
It only reads; it never changes another repository.

The issue is written by the App’s bot (eg, `ljharb-fleet[bot]`), with a token for only this repo, that can only write issues; the job’s own `GITHUB_TOKEN` can’t write issues at all.
The report issue is the newest one, open or closed, marked as the report, and opened by either the App’s bot or `github-actions[bot]`: a report opened before the App wrote it was opened by `github-actions[bot]`, and since GitHub can’t change an issue’s author, the App’s bot adopts it, editing it from then on. An issue anyone else opens is never written to, even if it’s marked as the report.
If the App can’t get that token (without the Issues permission, or before its installation has approved it, or when it isn’t installed on this repo), the run summary is still written, and then the run fails, saying what the App needs.

- `rebase.yml`, `node-pretest.yml`, and `require-allow-edits.yml` are expected in every repository.
- node tests go in `node.yml`, split into one workflow file per decade of node majors (`node-aught.yml` for `< 10`, including io.js, then `node-tens.yml`, `node-twenties.yml`, and so on) only when one file’s job matrix would exceed GitHub’s limit of 256 jobs. Which of them a repository should have comes from its `package.json`’s `engines.node`, the matrix `type` its node workflow files use (`minors` unless they all use `majors`), and the released versions that the `node/matrix` action uses: `node.yml` when all of the versions that satisfy `engines.node` fit in one file; otherwise, one file per decade from the first with such a version, until the last, open-ended one fits. Any other such file is unexpected. Without `engines.node`, they’re only compared when present.
- Template placeholders (`{{range}}`, `{{type}}`, `{{command}}`, `{{label}}`) match any one-line value, so legitimately per-repository values aren’t drift; a placeholder that appears twice must have the same value both times.
- Other workflow files are not reported.
- Nothing is ever left out of the full report, whatever its length: every failure, every repository with discrepancies, and every diff, whole. It groups repositories by account, each a collapsed table. Every file it lists links to that file (a missing one, to its template, when there is one), and each drifted file expands to show its full diff.
- The full report is in one secret gist of `FLEET_GIST_TOKEN`’s user: the one whose description is exactly `ljharb/actions fleet workflow drift report`, and that holds nothing but the report’s files. It’s found on every run, and updated in place (it’s created when there’s none; a public gist, or one with any other description or files, is never written to). When there are no discrepancies, it says so.
- GitHub cuts a gist file short past 1 MB, so a report that’s longer is split, only between rows, into as many files as it takes, each under 1 MB (`workflow-drift-001.md`, `workflow-drift-002.md`, and so on; a table that continues into the next file is reopened there), each written in a request of its own; files a previous, longer report needed are deleted. The issue then says how many files there are, and links each.
- Dry runs write the full report too, since it’s where a dry run’s results are, but to a gist of their own (described `ljharb/actions fleet workflow drift report (dry runs)`), so a dry run never changes what the issue’s link shows.
- If the gist can’t be written, the issue and the run summary are still updated, saying so (without a link), and then the run fails.
- The issue, and the run’s summary, are a short summary that always fits in GitHub’s limits: the counts, a link to the full report, the failures, and, for each account, how many of its repositories have discrepancies, and how many files are missing, unexpected, or drifted. When there are too many failures, or accounts, or files of the full report to link, for that, it counts them instead, and the full report has them all. The issue ends with a collapsed legend of the [commands](#commands) that act on it.
- [Private repositories](#private-repositories) are only counted, never named, since the issue, the summary, and the gist are public. A run that couldn’t check every repository says so, and never closes the issue.

### Commands

`fleet-commands.yml`, in this repo, runs on every new comment on an issue here, and acts only on a comment on the workflow drift report whose first line is one of:

- `/fix <filters>`: in each matching repository, open (or update) a PR that makes its workflow files match the templates.
- `/dry-run fix <filters>`: reply with what `/fix` would do (which PR it would create, update, or reopen, and with which files), without changing anything.

At least one filter is required, since every repository at once is too broad. Filters are separated by spaces (or commas), and are case-insensitive; each is one of:

- `owner/name`: a repository
- `owner`: an account
- a workflow file name (`*.yml` or `*.yaml`): only that file
- `missing`, `drifted`, or `unexpected`: only that kind of discrepancy

Filters of the same kind match any one of them; filters of different kinds must all match. For example, `/fix ljharb es-shims rebase.yml missing` adds `rebase.yml` wherever it’s missing in `ljharb`’s and `es-shims`’ repositories, and changes nothing else. A repository with nothing matching the filters is only listed when it’s named. Anything else starting with `/` gets a reply explaining the commands.

They act only on the report issue: the one marked as the report, and opened by the App’s bot or (for the report it adopted) `github-actions[bot]`. The App’s bot checks the commenter’s permission, and reacts and replies, with a token for only this repo, that can only write issues (and read its metadata, which is all checking the permission needs); without the App’s Issues permission, the run fails, saying so, and does nothing else.

Only people with write (or maintain, or admin) permission on this repo can run them: a command from anyone else gets a reply saying so, and does nothing else. A bot’s comment is never a command, so the App’s own replies (which, unlike `GITHUB_TOKEN`’s comments, do start workflow runs) never run one. Every command from someone allowed gets a 👀 reaction; one that runs then gets a reply with a table of what happened in each public repository, which is also the run’s summary. Nothing is ever left out of a reply: one too long for a comment goes on in as many more as it takes, each saying which part it is, split only between rows (a single row, or a quoted command, too long for any one comment is shown as its source, in marked pieces). A reply over 1 MiB is too long for a run summary, which then has as many of its comments as fit, whole, and links the comments with the rest (or, if they couldn’t be posted, says so); the reply is never in the run’s log, which never mentions anything a command names. [Private repositories](#private-repositories) that match are fixed too, but are never listed, counted, or otherwise mentioned, beyond one sentence that every such reply ends with whether or not any matched. The run fails if any public repository could not be fixed, after trying every other one; a private repository’s failure only shows in that repository.

Commands run one at a time, in order. GitHub keeps only one waiting behind the one running, though: a command posted while one runs and another waits cancels the waiting one, which then gets no reaction and no reply, so post it again once the first is done.

Only the repositories the App is installed on are fixed; fork sources never are. In each, `/fix` works on a `fleet/workflows` branch, and its PR into the default branch:

- Missing files are written from their templates, drifted ones are rewritten from their templates (keeping the values of their placeholders, where it can recover them), and unexpected ones are deleted. When a node test file is added after an existing one whose version range is open-ended, that range is closed where the added file’s starts. A file that can’t be written (eg, with no template, or no way to know its node version range) is left as it is, and listed as such.
- An open PR from that branch is updated, and a closed, unmerged one is reopened; once one is merged, the next `/fix` opens a new one. The branch is always built on its current tip, merged with the default branch, and is never force-pushed.
- A workflow file (or a directory on the way to it) that is a symbolic link is never written through: a linked file is replaced with a regular one, and a linked directory fails that repository.
- The commits are the App’s own. If the branch has commits by anyone else, or changes to any file other than the ones being fixed, nothing is pushed: fix or delete the branch, and run the command again. So while a PR is open, a later `/fix` for that repository must cover every file the PR already changes (eg, by filtering by repository rather than by file).
