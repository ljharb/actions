import test from 'tape';

import { legend } from '../../../fleet/commands/syntax.mjs';
import { maxPartLength, maxSummaryLength } from '../../../fleet/lib/report.mjs';
import { marker } from '../../../fleet/readme/marker.mjs';
import { report } from '../../../fleet/readme/report.mjs';
import { marker as workflowMarker } from '../../../fleet/drift/marker.mjs';

/** @import { Result } from '../../../fleet/readme/check.mjs' */

const collapsedLegend = ['<details><summary><b>Commands</b></summary>', '', legend({ heading: false, report: 'readme' }), '', '</details>'].join('\n');

const gist = { html_url: 'https://gist.github.com/g', files: [{ name: 'readme-drift.md', raw_url: 'https://gist.githubusercontent.com/u/g/raw/1/readme-drift.md' }] }; // eslint-disable-line camelcase

/** @type {(n: number) => Result[]} */
function accounts(n) {
	return Array.from({ length: n }, (_, i) => ({
		repository: `${`account-${i}-`.padEnd(39, 'x')}/repo`,
		drifted: ['badges'],
		diff: '',
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

// Markdown's text outside its code spans, which is all that could render as HTML
/** @type {(text: string) => string} */
function outsideCode(text) {
	return text.replace(/(?<ticks>`+)[^`][\s\S]*?\k<ticks>/g, '');
}

/** @type {(text: string) => number} */
function failureItems(text) {
	return (text.match(/^- installation \d+: /gm) ?? []).length;
}

test('report: the title counts every repository with discrepancies, private ones included, of every one checked', (t) => {
	const found = report(accounts(2), 3, [], { installed: 7, external: 2 });
	t.equal(found.title, 'README drift: 5 of 9 repositories', 'of those installed on, and sources of forks');
	t.equal(report([], 0, [], { installed: 1, external: 0 }).title, 'README drift: 0 of 1 repositories', 'none');
	t.ok(found.parts[0].startsWith('# README drift: 5 of 9 repositories\n'), 'the full report is headed with it');

	t.end();
});

test('report: private repositories are only counted', (t) => {
	const found = report([{
		repository: 'ljharb/public', drifted: ['heading'], diff: '-a\n+b', error: null,
	}], 2, [], { installed: 3, external: 0 });
	[true, false].forEach((forIssue) => {
		const summary = found.summary(gist, forIssue);
		t.ok(summary.includes('3 have discrepancies (2 of them private, so not listed).'), `${forIssue ? 'the issue' : 'the run summary'} counts them`);
	});
	const full = found.parts.join('\n');
	t.ok(full.includes('3 have discrepancies (2 of them private, so not listed).'), 'as does the full report');
	t.equal((full.match(/<tr><td><a /g) ?? []).length, 1, 'which lists only the public one');
	t.notOk(report(accounts(1), 0, [], { installed: 1, external: 0 }).summary(gist, true).includes('private'), 'with none, it says nothing about them');

	t.end();
});

test('report: the issue is marked as the README report, with its own commands', (t) => {
	const found = report(accounts(1), 0, [], { installed: 1, external: 0 });
	const issue = found.summary(gist, true);
	t.ok(issue.startsWith(`${marker}\n`), 'the issue starts with the README report’s marker');
	t.notOk(issue.includes(workflowMarker), 'not the workflow report’s');
	t.ok(issue.endsWith(`\n\n${collapsedLegend}`), 'and ends with the README report’s commands, collapsed');
	t.notOk(issue.includes('### Commands'), 'without their heading');
	t.ok(issue.includes('This issue is updated in place on every run, and closed when there are none.'), 'saying it’s updated in place');

	const summary = found.summary(gist, false);
	t.notOk(summary.includes(marker), 'the run summary isn’t marked');
	t.notOk(summary.includes('<b>Commands</b>'), 'and has no commands');
	t.ok(found.parts.at(-1)?.endsWith(legend({ report: 'readme' })), 'the full report ends with the README report’s commands, with their heading');

	t.end();
});

test('report: the full report has each repository’s row, discrepancies, diff, and error', (t) => {
	const { parts } = report([
		{
			repository: 'ljharb/a', drifted: ['heading', 'links'], diff: '--- README.md (actual)\n+++ README.md (expected)\n-# x\n+# a', error: null,
		},
		{
			repository: 'ljharb/b', drifted: [], diff: '', error: 'there is no `README.md`',
		},
	], 0, [], { installed: 2, external: 0 });
	const full = parts.join('\n');
	t.ok(full.includes('<details><summary><b>ljharb</b>: 2 repositories</summary>'), 'one table for the account');
	t.ok(full.includes('<tr><th>Repository</th><th>Drifted</th><th>Diff</th><th>Other</th></tr>'), 'with its header');
	t.match(full, /<a href="[^"]*\/ljharb\/a\/blob\/HEAD\/README\.md"><code>ljharb\/a<\/code><\/a>/, 'linking each repository’s README');
	t.ok(full.includes('<ul>\n<li><code>heading</code></li>\n<li><code>links</code></li>\n</ul>'), 'listing what drifted');
	t.ok(full.includes('<details><summary>diff</summary>\n\n```diff\n--- README.md (actual)\n+++ README.md (expected)\n-# x\n+# a\n```\n\n</details>'), 'with the diff, fenced');
	t.ok(full.includes('<code>there is no `README.md`</code>'), 'and the error');

	t.end();
});

test('report: third-party text is inert', (t) => {
	const { parts, summary } = report([{
		repository: '<img src=x>/repo|x',
		drifted: ['badges'],
		diff: '-```\n+</td></table>\n\n# @everyone',
		error: '<script>alert(1)</script>\n\n# not a heading',
	}], 0, [{ scope: 'installation 1', message: '`code` | @mention\n# heading' }], { installed: 1, external: 0 }, ['<b>owner</b>']);
	const full = parts.join('\n');
	t.notOk(full.includes('<img src=x>'), 'an account name isn’t HTML in the full report');
	t.ok(full.includes('<b>&#60;img src=x&#62;</b>'), 'it’s escaped');
	t.notOk(full.includes('<script>'), 'nor is an error');
	t.ok(full.includes('<code>&#60;script&#62;alert(1)&#60;/script&#62; # not a heading</code>'), 'which is escaped, and kept to one line');
	t.ok(full.includes('````diff\n-```\n+</td></table>\n\n# @everyone\n````'), 'a diff is fenced with more backticks than it has');
	t.notOk(full.includes('\n# heading'), 'a failure’s message is kept to one line');

	const issue = summary(gist, true);
	t.notOk(outsideCode(issue).includes('<img src=x>'), 'an account name isn’t HTML in the issue');
	t.ok(issue.includes('| `<img src=x>` | 1 | 0 | 1 | 0 | 1 |'), 'it’s code in the accounts table');
	t.notOk(outsideCode(issue).includes('<b>owner</b>'), 'nor is a waiting account');
	t.ok(issue.includes('`<b>owner</b>`'), 'which is code too');

	t.end();
});

test('report: the accounts table counts each kind of discrepancy per account', (t) => {
	const summary = report([
		{
			repository: 'ljharb/a', drifted: ['heading', 'badges', 'links'], diff: 'x', error: null,
		},
		{
			repository: 'LJHarb/b', drifted: ['badges'], diff: 'x', error: 'boom',
		},
		{
			repository: 'ljharb/c', drifted: [], diff: '', error: 'there is no `README.md`',
		},
		{
			repository: 'es-shims/d', drifted: ['links'], diff: 'x', error: null,
		},
	], 0, [], { installed: 10, external: 0 }).summary(gist, true);
	t.ok(summary.includes([
		'| Account | Repositories with discrepancies | Heading | Badges | Links | Repositories with other problems |',
		'| --- | --: | --: | --: | --: | --: |',
		'| `ljharb` | 3 | 1 | 2 | 1 | 2 |',
		'| `es-shims` | 1 | 0 | 0 | 1 | 0 |',
	].join('\n')), 'a row per account, case-insensitively, in order');

	t.end();
});

test('report: the summary always fits, and the full report always has everything', (t) => {
	[
		[1, 0],
		[100, 100],
		[2000, 0],
		[2000, 10],
		[0, 5000],
		[10, 5000],
		[2000, 5000],
	].forEach(([accountCount, failureCount]) => {
		const found = report(accounts(accountCount), 3, failures(failureCount), { installed: accountCount + 3, external: 0 });
		const label = `${accountCount} accounts, ${failureCount} failures`;
		[true, false].forEach((forIssue) => {
			const summary = found.summary(gist, forIssue);
			const where = `${label}, ${forIssue ? 'the issue' : 'the run summary'}`;
			t.ok(summary.length <= maxSummaryLength, `${where}: fits (${summary.length} characters)`);
			t.equal(summary.startsWith(`${marker}\n`), forIssue, `${where}: is marked only as the issue`);
			t.equal(summary.endsWith(`\n\n${collapsedLegend}`), forIssue, `${where}: ends with the collapsed commands only as the issue`);
			t.ok(summary.includes('**[The full report](https://gist.github.com/g)**'), `${where}: links the full report`);

			const listsFailures = failureItems(summary) === failureCount;
			const countsFailures = summary.includes(`⚠️ ${failureCount} repositories or installations could not be checked, so this report is incomplete; [the full report](https://gist.github.com/g) lists them all.`);
			t.ok(failureCount === 0 ? failureItems(summary) === 0 : listsFailures !== countsFailures, `${where}: lists every failure, or counts them`);
			const hasTable = accountRows(summary) === accountCount;
			const countsAccounts = summary.includes(`${accountCount} accounts have repositories with discrepancies; [the full report](https://gist.github.com/g) has a table for each.`);
			t.ok(accountCount === 0 || hasTable !== countsAccounts, `${where}: has every account’s row, or counts the accounts`);
		});

		const full = found.parts.join('\n');
		t.equal(failureItems(full), failureCount, `${label}: the full report lists every failure`);
		t.equal((full.match(/<details><summary><b>account-[^<]*<\/b>: 1 repository<\/summary>/g) ?? []).length, accountCount, `${label}: and has every account’s table`);
		t.ok(found.parts.every((part) => part.length <= maxPartLength && Buffer.byteLength(part) < 1000000), `${label}: in files that are each under 1 MB (${found.parts.length})`);
	});

	const someFailures = report(accounts(2000), 0, failures(10), { installed: 2000, external: 0 }).summary(gist, true);
	t.equal(failureItems(someFailures), 10, 'with too many accounts, failures that fit are still listed');
	t.equal(accountRows(someFailures), 0, 'and the accounts are counted instead');

	const manyFiles = {
		html_url: 'https://gist.github.com/g', // eslint-disable-line camelcase
		files: Array.from({ length: 1000 }, (_, i) => ({ name: `readme-drift-${i}.md`, raw_url: `https://gist.githubusercontent.com/u/g/raw/${'0'.repeat(40)}/readme-drift-${i}.md` })), // eslint-disable-line camelcase
	};
	const tooMany = report(accounts(2000), 0, failures(5000), { installed: 2000, external: 0 }).summary(manyFiles, true);
	t.ok(tooMany.length <= maxSummaryLength, 'with too many files to link too, it still fits');
	t.ok(tooMany.includes('**[The full report](https://gist.github.com/g)** has every repository, every discrepancy, and every diff; it’s a secret gist, updated in place on every run. It’s in 1000 files, each small enough (under 1 MB) for GitHub to show in full; read them in order.'), 'saying how many files, linking the gist');

	const failed = report(accounts(1), 0, [], { installed: 1, external: 0 }).summary({ error: 'Resource not accessible by personal access token' }, true);
	t.match(failed, /\n⚠️ \*\*The full report could not be written to its gist\*\* \(`Resource not accessible by personal access token`\), so this run failed/, 'a gist that couldn’t be written is said so, with the error');
	t.notOk(failed.includes('](https://gist'), 'with no link to a gist');

	t.end();
});

test('report: accounts waiting on permission approval are said once, but aren’t failures', (t) => {
	const line = '⏳ Waiting on permission approval: `es-shims`, `inspect-js`. Until each of these accounts approves the App’s permissions (in its settings, under “Applications”, or from GitHub’s email about them), its repositories aren’t checked.';
	const found = report(accounts(1), 0, [], { installed: 1, external: 0 }, ['es-shims', 'inspect-js']);
	[true, false].forEach((forIssue) => {
		const summary = found.summary(gist, forIssue);
		t.equal(summary.split(line).length, 2, `${forIssue ? 'the issue' : 'the run summary'} lists them once`);
		t.notOk(summary.includes('incomplete'), `${forIssue ? 'the issue' : 'the run summary'} lists no failures`);
	});
	t.equal(found.parts.join('\n').split(line).length, 2, 'as does the full report');

	const counted = report(accounts(2000), 0, failures(5000), { installed: 2000, external: 0 }, ['es-shims', 'inspect-js']).summary(gist, true);
	t.ok(counted.length <= maxSummaryLength, 'with too many failures, it still fits');
	t.ok(counted.includes('\n\n⏳ 2 accounts are waiting on permission approval, so their repositories weren’t checked; [the full report](https://gist.github.com/g) lists them.\n\n'), 'counting them, as it counts the failures');
	t.notOk(report(accounts(1), 0, [], { installed: 1, external: 0 }).summary(gist, true).includes('⏳'), 'with none, it says nothing about them');

	t.end();
});

test('report: a full report too big for one file is split between rows, each part reopening its table', (t) => {
	const results = Array.from({ length: 10 }, (_, i) => ({
		repository: `big/repo-${i}`,
		drifted: /** @type {Result['drifted']} */ (['badges']), // eslint-disable-line no-extra-parens
		diff: `-${'a'.repeat(50000)}\n+${'b'.repeat(50000)}`,
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

	t.end();
});
