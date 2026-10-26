import test from 'tape';

import { legend } from '../../../fleet/commands/syntax.mjs';

const collapsedLegend = ['<details><summary><b>Commands</b></summary>', '', legend({ heading: false }), '', '</details>'].join('\n');
import { marker } from '../../../fleet/drift/marker.mjs';
import { maxPartLength, maxSummaryLength, report } from '../../../fleet/drift/report.mjs';

/** @typedef {import('../../../fleet/drift/check.mjs').Result} Result */

const gist = { html_url: 'https://gist.github.com/g', files: [{ name: 'workflow-drift.md', raw_url: 'https://gist.githubusercontent.com/u/g/raw/1/workflow-drift.md' }] }; // eslint-disable-line camelcase

/** @type {(n: number) => Result[]} */
function accounts(n) {
	return Array.from({ length: n }, (_, i) => ({
		repository: `${`account-${i}-`.padEnd(39, 'x')}/repo`,
		missing: ['rebase.yml'],
		unexpected: [],
		drifted: [],
		unreadable: [],
		error: null,
	}));
}

/** @type {(n: number) => { scope: string, message: string }[]} */
function failures(n) {
	return Array.from({ length: n }, (_, i) => ({ scope: `installation ${i}`, message: `could not be read (${'HTTP 502, '.repeat(5)}GraphQL: SOMETHING)` }));
}

/** @type {(text: string) => number} */
function accountRows(text) {
	return (text.match(/^\| `account-/gm) ?? []).length;
}

/** @type {(text: string) => number} */
function failureItems(text) {
	return (text.match(/^- installation \d+: /gm) ?? []).length;
}

test('report: the summary always fits, and the full report always has everything', (t) => {
	for (const [accountCount, failureCount] of [
		[1, 0],
		[100, 100],
		[2000, 0],
		[2000, 10],
		[0, 5000],
		[10, 5000],
		[2000, 5000],
	]) {
		const results = accounts(accountCount);
		const found = report(results, 3, failures(failureCount), { installed: accountCount + 3, external: 0 });
		const label = `${accountCount} accounts, ${failureCount} failures`;
		for (const forIssue of [true, false]) {
			const summary = found.summary(gist, forIssue);
			const where = `${label}, ${forIssue ? 'the issue' : 'the run summary'}`;
			t.ok(summary.length <= maxSummaryLength, `${where}: fits (${summary.length} characters)`);
			t.equal(summary.startsWith(`${marker}\n`), forIssue, `${where}: is marked only as the issue`);
			t.equal(summary.endsWith(`\n\n${collapsedLegend}`), forIssue, `${where}: ends with the collapsed commands only as the issue`);
			t.notOk(summary.includes('### Commands'), `${where}: never with the commands’ heading`);
			t.ok(summary.includes('**[The full report](https://gist.github.com/g)**'), `${where}: links the full report`);
			t.ok(summary.includes(' (3 of them private, so not listed).'), `${where}: counts private repositories`);

			const listsFailures = failureItems(summary) === failureCount;
			const countsFailures = summary.includes(`⚠️ ${failureCount} repositories or installations could not be checked, so this report is incomplete; [the full report](https://gist.github.com/g) lists them all.`);
			t.ok(failureCount === 0 ? !listsFailures || failureItems(summary) === 0 : listsFailures !== countsFailures, `${where}: lists every failure, or counts them`);
			if (countsFailures) {
				t.equal(failureItems(summary), 0, `${where}: and lists none when it counts them`);
			}
			const hasTable = accountRows(summary) === accountCount;
			const countsAccounts = summary.includes(`${accountCount} accounts have repositories with discrepancies; [the full report](https://gist.github.com/g) has a table for each.`);
			t.ok(accountCount === 0 || hasTable !== countsAccounts, `${where}: has every account’s row, or counts the accounts`);
		}

		const full = found.parts.join('\n');
		t.equal(failureItems(full), failureCount, `${label}: the full report lists every failure`);
		t.equal((full.match(/<details><summary><b>account-[^<]*<\/b>: 1 repository<\/summary>/g) ?? []).length, accountCount, `${label}: and has every account’s table`);
		t.ok(found.parts.every((part) => part.length <= maxPartLength && Buffer.byteLength(part) < 1000000), `${label}: in files that are each under 1 MB (${found.parts.length})`);
	}

	const someFailures = report(accounts(2000), 0, failures(10), { installed: 2000, external: 0 }).summary(gist, true);
	t.equal(failureItems(someFailures), 10, 'with too many accounts, failures that fit are still listed');
	t.equal(accountRows(someFailures), 0, 'and the accounts are counted instead');

	const many = {
		html_url: 'https://gist.github.com/g', // eslint-disable-line camelcase
		files: [1, 2, 3].map((i) => ({ name: `workflow-drift-00${i}.md`, raw_url: `https://gist.githubusercontent.com/u/g/raw/1/workflow-drift-00${i}.md` })), // eslint-disable-line camelcase
	};
	const inFiles = report(accounts(1), 0, [], { installed: 1, external: 0 }).summary(many, false);
	t.ok(inFiles.includes('It’s in 3 files, each small enough (under 1 MB) for GitHub to show in full; read them in order: [1](https://gist.githubusercontent.com/u/g/raw/1/workflow-drift-001.md) · [2](https://gist.githubusercontent.com/u/g/raw/1/workflow-drift-002.md) · [3](https://gist.githubusercontent.com/u/g/raw/1/workflow-drift-003.md).'), 'a report in several files links each, in order');
	t.notOk(report(accounts(1), 0, [], { installed: 1, external: 0 }).summary(gist, false).includes('It’s in'), 'one in one file doesn’t');
	const manyFiles = {
		html_url: 'https://gist.github.com/g', // eslint-disable-line camelcase
		files: Array.from({ length: 1000 }, (_, i) => ({ name: `workflow-drift-${i}.md`, raw_url: `https://gist.githubusercontent.com/u/g/raw/${'0'.repeat(40)}/workflow-drift-${i}.md` })), // eslint-disable-line camelcase
	};
	const tooMany = report(accounts(2000), 0, failures(5000), { installed: 2000, external: 0 }).summary(manyFiles, true);
	t.ok(tooMany.length <= maxSummaryLength, 'with too many files to link too, it still fits');
	t.ok(tooMany.includes('**[The full report](https://gist.github.com/g)** has every repository, every discrepancy, and every diff; it’s a secret gist, updated in place on every run. It’s in 1000 files, each small enough (under 1 MB) for GitHub to show in full; read them in order.'), 'saying how many files, linking the gist');

	const failed = report(accounts(1), 0, [], { installed: 1, external: 0 }).summary({ error: 'Resource not accessible by personal access token' }, true);
	t.match(failed, /\n⚠️ \*\*The full report could not be written to its gist\*\* \(`Resource not accessible by personal access token`\), so this run failed, and \[its log\]\([^)]+\/actions\/runs\/[^)]+\) has the error; the next run will try again\.\n/, 'a gist that couldn’t be written is said so, with the error');
	t.notOk(failed.includes('](https://gist'), 'with no link to a gist');
	const failedLong = report(accounts(1), 0, [], { installed: 1, external: 0 }).summary({ error: 'x'.repeat(100000) }, true);
	t.ok(failedLong.length <= maxSummaryLength, 'an error too long for it still fits');
	t.ok(failedLong.includes('⚠️ **The full report could not be written to its gist**, so this run failed, and [its log]'), 'leaving the error to the log');
	const failedCounted = report(accounts(1), 0, failures(5000), { installed: 1, external: 0 }).summary({ error: 'boom' }, true);
	t.ok(failedCounted.includes('⚠️ 5000 repositories or installations could not be checked, so this report is incomplete; the full report lists them all.'), 'counting what doesn’t fit, with no link');

	t.end();
});

test('report: a full report too big for one file is split between rows, each part reopening its table', (t) => {
	// each repository has a diff of about 100,000 characters, so 10 take more than 3 files
	const results = Array.from({ length: 10 }, (_, i) => ({
		repository: `big/repo-${i}`,
		missing: [],
		unexpected: [],
		drifted: [{ name: 'node.yml', diff: `-${'a'.repeat(50000)}\n+${'b'.repeat(50000)}` }],
		unreadable: [],
		error: null,
	}));
	const { parts } = report(results, 0, [], { installed: 10, external: 0 });
	t.ok(parts.length > 3, `it’s in several parts (${parts.length})`);
	parts.forEach((part, i) => {
		t.ok(part.length <= maxPartLength && Buffer.byteLength(part) < 1000000, `part ${i + 1} is under 1 MB`);
		if (i > 0) {
			t.ok(part.startsWith(`_continued (${i + 1}/${parts.length})_\n\n<details><summary><b>big</b>: 10 repositories (continued)</summary>\n\n<table>\n<tr><th>`), `part ${i + 1} reopens the table`);
		}
		if (i < parts.length - 1) {
			t.ok(part.endsWith(`</table>\n\n</details>\n\n_continued below (${i + 2}/${parts.length})_`), `part ${i + 1} closes it`);
		}
	});
	const full = parts.join('\n');
	t.equal((full.match(/<tr><td><a href="[^"]+"><code>big\/repo-\d<\/code><\/a><\/td>/g) ?? []).length, 10, 'every row is in one of them');
	t.equal((full.match(/a{50000}/g) ?? []).length + (full.match(/b{50000}/g) ?? []).length, 20, 'with every diff, whole');
	t.ok(parts.at(-1)?.endsWith(legend()), 'the last ends with the commands');
	t.end();
});
