import test from 'tape';

import { maxPartLength, maxSummaryLength } from '../../../fleet/lib/report.mjs';
import { marker, report } from '../../../fleet/optional/report.mjs';

/** @import { Result } from '../../../fleet/optional/report.mjs' */

const gist = { html_url: 'https://gist.github.com/g', files: [{ name: 'optional-failures.md', raw_url: 'https://gist.githubusercontent.com/u/g/raw/1/optional-failures.md' }] }; // eslint-disable-line camelcase

/** @type {(accounts: number, repos: number, jobs: number) => Result[]} */
function results(accounts, repos, jobs) {
	return Array.from({ length: accounts }, (_, a) => Array.from({ length: repos }, (__, r) => ({
		repository: `account-${a}/repo-${r}`,
		head: `sha${a}x${r}`,
		jobs: Array.from({ length: jobs }, (___, j) => ({
			file: `.github/workflows/w${j}.yml`,
			job: `job ${j}`,
			messages: ['failure', `step s${j}: failure`],
		})),
	}))).flat();
}

/** @type {(n: number) => { scope: string, message: string }[]} */
function failures(n) {
	return Array.from({ length: n }, (_, i) => ({ scope: `installation ${i}`, message: 'could not be read (HTTP 502)' }));
}

test('optional report: the summary always fits, and the full report always has everything', (t) => {
	[
		[1, 1, 1, 0],
		[3, 5, 2, 3],
		[50, 20, 5, 0],
		[2000, 1, 1, 10],
		[0, 0, 0, 5000],
		[3000, 2, 2, 5000],
	].forEach(([accountCount, repoCount, jobCount, failureCount]) => {
		const all = results(accountCount, repoCount, jobCount);
		const found = report(all, 2, failures(failureCount), { installed: all.length + 5, external: 0 });
		const label = `${accountCount} accounts of ${repoCount} repositories of ${jobCount} jobs, ${failureCount} failures`;
		t.equal(found.title, `Optional-job failures: ${all.length + 2} of ${all.length + 5} repositories`, `${label}: titled with the counts`);
		[true, false].forEach((forIssue) => {
			const summary = found.summary(gist, forIssue);
			const where = `${label}, ${forIssue ? 'the issue' : 'the run summary'}`;
			t.ok(summary.length <= maxSummaryLength, `${where}: fits (${summary.length} characters)`);
			t.equal(summary.startsWith(`${marker}\n`), forIssue, `${where}: is marked only as the issue`);
			t.ok(summary.includes('**[The full report](https://gist.github.com/g)** has every repository, and every job, with every one of its failures'), `${where}: links the full report`);
		});
		t.ok(found.parts.every((part) => part.length <= maxPartLength), `${label}: every file of the full report fits in a gist file`);
		const full = found.parts.join('\n');
		t.ok(all.every((r) => full.includes(`[\`${r.repository}\`](https://github.com/${r.repository}/commit/${r.head})`)), `${label}: the full report links every repository’s commit`);
		t.equal((full.match(/^ {2}- \[`\.github\/workflows\//gm) ?? []).length, accountCount * repoCount * jobCount, `${label}: and lists every job`);
		t.equal((full.match(/^- installation \d+: /gm) ?? []).length, failureCount, `${label}: and every failure`);
		t.notOk(full.includes(marker), `${label}: the full report isn’t marked as the issue`);
	});

	t.end();
});

test('optional report: the summary lists every job when it fits, then each account’s counts, then only how many accounts', (t) => {
	const small = report(results(2, 1, 1), 0, [], { installed: 4, external: 1 });
	const listed = small.summary(gist, true);
	t.ok(listed.includes('<details><summary><b>account-0</b>: 1 repository</summary>\n\n- [`account-0/repo-0`](https://github.com/account-0/repo-0/commit/sha0x0)\n  - [`.github/workflows/w0.yml`](https://github.com/account-0/repo-0/blob/sha0x0/.github/workflows/w0.yml), `job 0`: `failure`, `step s0: failure`\n\n</details>'), 'grouped by account, then repository, each job with its workflow file, linked at that commit, and its messages, each inert code');
	t.ok(listed.includes('checked CI on the tip of the default branch of 4 repositories the fleet App is installed on, and 1 sources of forks it’s installed on, for failures that `continue-on-error` hides'), 'counting the sources of forks');
	t.notOk(listed.includes('⚠️'), 'complete, with nothing that couldn’t be checked');

	const counted = report(results(30, 20, 5), 0, [], { installed: 600, external: 0 }).summary(gist, true);
	t.ok(counted.includes('| Account | Repositories with failures | Jobs with failures |\n| --- | --: | --: |\n| `account-0` | 20 | 100 |'), 'too many jobs for the summary: each account’s counts');
	t.notOk(counted.includes('account-0/repo-0'), 'without naming any repository');

	const accounts = report(results(5000, 1, 1), 0, [], { installed: 5000, external: 0 }).summary(gist, false);
	t.ok(accounts.includes('5000 accounts have repositories with such failures; [the full report](https://gist.github.com/g) lists them all.'), 'too many accounts for their counts: only how many');

	const many = report(results(5000, 1, 1), 0, failures(5000), { installed: 5000, external: 0 });
	const files = Array.from({ length: 3000 }, (_, i) => ({ name: `optional-failures-${i}.md`, raw_url: `https://gist.githubusercontent.com/u/g/raw/1/optional-failures-${i}.md` })); // eslint-disable-line camelcase
	const terse = many.summary({ html_url: 'https://gist.github.com/g', files }, true); // eslint-disable-line camelcase
	t.ok(terse.length <= maxSummaryLength, 'with too many files to link too, it still fits');
	t.ok(terse.includes('It’s in 3000 files, each small enough (under 1 MB) for GitHub to show in full; read them in order.'), 'counting the files, without linking each');
	t.ok(terse.includes('⚠️ 5000 repositories or installations could not be checked, so this report is incomplete; [the full report](https://gist.github.com/g) lists them all.'), 'and the failures');

	const privates = report(results(5000, 1, 1), 0, failures(2), { installed: 5007, external: 0 }, [], 5);
	const privateFull = privates.parts.join('\n');
	t.ok(privateFull.includes('- 5 private repositories: `could not be checked`'), 'private repositories that couldn’t be checked are counted in the full report, not named');
	const privateTerse = privates.summary({ html_url: 'https://gist.github.com/g', files }, true); // eslint-disable-line camelcase
	t.ok(privateTerse.includes('⚠️ 7 repositories or installations could not be checked, so this report is incomplete'), 'and, when only counted in the summary, each of them is counted');

	const unwritten = small.summary({ error: 'HttpError: nope' }, false);
	t.ok(unwritten.includes('⚠️ **The full report could not be written to its gist** (`HttpError: nope`)'), 'a gist that couldn’t be written is said');
	t.ok(unwritten.includes('- [`account-0/repo-0`]'), 'with the rest of the summary');

	t.end();
});

test('optional report: third-party names are inert, and a job whose workflow file is unknown says so', (t) => {
	const found = report(
		[{
			repository: 'o<b>/r',
			head: 'abc',
			jobs: [
				{ file: '.github/workflows/a (b).yml', job: 'x`y', messages: ['failure'] },
				{ file: null, job: 'lost', messages: ['boom | `b`'] },
			],
		}],
		0,
		[],
		{ installed: 1, external: 0 },
		['waiter'],
	);
	const full = found.parts.join('\n');
	t.ok(full.includes('<details><summary><b>o&#60;b&#62;</b>: 1 repository</summary>'), 'the account is escaped in HTML');
	t.ok(full.includes(', ``x`y``: `failure`'), 'a job’s name is inert code');
	t.ok(full.includes('/blob/abc/.github/workflows/a%20%28b%29.yml)'), 'a workflow file’s path is encoded, parentheses too, so its link never ends early');
	t.ok(full.includes('  - an unknown workflow file, `lost`: `` boom \\| `b` ``'), 'a job whose workflow file is unknown says so; a message is inert code too');
	t.ok(full.includes('⏳ Waiting on permission approval: `waiter`.'), 'an account waiting on permission approval is listed');
	t.end();
});
