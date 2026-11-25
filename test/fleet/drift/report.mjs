import test from 'tape';

import { legend } from '../../../fleet/commands/syntax.mjs';

const collapsedLegend = ['<details><summary><b>Commands</b></summary>', '', legend({ heading: false }), '', '</details>'].join('\n');
import { marker } from '../../../fleet/drift/marker.mjs';
import { maxPartLength, maxSummaryLength, report } from '../../../fleet/drift/report.mjs';

/** @import { Drift, Result } from '../../../fleet/drift/check.mjs' */

const gist = { html_url: 'https://gist.github.com/g', pages: 1, files: [{ name: 'workflow-drift.md', html_url: 'https://gist.github.com/g#file-workflow-drift-md' }] }; // eslint-disable-line camelcase

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
	[
		[1, 0],
		[100, 100],
		[2000, 0],
		[2000, 10],
		[0, 5000],
		[10, 5000],
		[2000, 5000],
	].forEach(([accountCount, failureCount]) => {
		const results = accounts(accountCount);
		const found = report(results, 3, failures(failureCount), { installed: accountCount + 3, external: 0 });
		const label = `${accountCount} accounts, ${failureCount} failures`;
		[true, false].forEach((forIssue) => {
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
		});

		const full = found.parts.join('\n');
		t.equal(failureItems(full), failureCount, `${label}: the full report lists every failure`);
		t.equal((full.match(/<details><summary><b>account-[^<]*<\/b>: 1 repository<\/summary>/g) ?? []).length, accountCount, `${label}: and has every account’s table`);
		t.ok(found.parts.every((part) => part.length <= maxPartLength && Buffer.byteLength(part) < 1000000), `${label}: in files that are each under 1 MB (${found.parts.length})`);
	});

	const someFailures = report(accounts(2000), 0, failures(10), { installed: 2000, external: 0 }).summary(gist, true);
	t.equal(failureItems(someFailures), 10, 'with too many accounts, failures that fit are still listed');
	t.equal(accountRows(someFailures), 0, 'and the accounts are counted instead');

	const many = {
		html_url: 'https://gist.github.com/g', // eslint-disable-line camelcase
		pages: 2,
		files: [1, 2, 3].map((i) => ({ name: `workflow-drift-00${i}.md`, html_url: `https://gist.github.com/g${i < 3 ? '' : '/rev1'}#file-workflow-drift-00${i}-md` })), // eslint-disable-line camelcase
	};
	const inFiles = report(accounts(1), 0, [], { installed: 1, external: 0 }).summary(many, false);
	t.ok(inFiles.includes('**[The full report](https://gist.github.com/g)** has every repository, every discrepancy, and every diff; it’s a secret gist, updated in place on every run. It’s in 3 files, on 2 pages (GitHub shows only a gist’s first 900 KiB, so each page after the first is an earlier revision of the gist, which the page before it links to), so that GitHub shows each in full; read them in order: [1](https://gist.github.com/g#file-workflow-drift-001-md) · [2](https://gist.github.com/g#file-workflow-drift-002-md) · [3](https://gist.github.com/g/rev1#file-workflow-drift-003-md).'), 'a report in several files, on several pages, links each where GitHub shows it, in order');
	t.notOk(report(accounts(1), 0, [], { installed: 1, external: 0 }).summary(gist, false).includes('It’s in'), 'one in one file doesn’t');
	const manyFiles = {
		html_url: 'https://gist.github.com/g', // eslint-disable-line camelcase
		pages: 334,
		files: Array.from({ length: 1000 }, (_, i) => ({ name: `workflow-drift-${i}.md`, html_url: `https://gist.github.com/${'0'.repeat(32)}#file-workflow-drift-${i}-md` })), // eslint-disable-line camelcase
	};
	const tooMany = report(accounts(2000), 0, failures(5000), { installed: 2000, external: 0 }).summary(manyFiles, true);
	t.ok(tooMany.length <= maxSummaryLength, 'with too many files to link too, it still fits');
	t.ok(tooMany.includes('**[The full report](https://gist.github.com/g)** has every repository, every discrepancy, and every diff; it’s a secret gist, updated in place on every run. It’s in 1000 files, on 334 pages (GitHub shows only a gist’s first 900 KiB, so each page after the first is an earlier revision of the gist, which the page before it links to), so that GitHub shows each in full; read them in order.'), 'saying how many files, linking the gist');

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
	// each repository has a diff of about 100,000 characters, its own, so 10 take more than 3 files
	const results = Array.from({ length: 10 }, (_, i) => ({
		repository: `big/repo-${i}`,
		missing: [],
		unexpected: [],
		drifted: [{ name: 'node.yml', diff: `-${'a'.repeat(50000)}\n+${'b'.repeat(50000)}${i}` }],
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

/** @type {(repository: string, drifted: Drift[]) => Result} */
function drifting(repository, drifted) {
	return {
		repository,
		missing: [],
		unexpected: [],
		drifted,
		unreadable: [],
		error: null,
	};
}

/** @type {(text: string, find: string) => number} */
function occurrences(text, find) {
	return text.split(find).length - 1;
}

/** @type {(repository: string, name: string) => string} */
function fileItem(repository, name) {
	return `<li><a href="https://github.com/${repository}/blob/HEAD/.github/workflows/${name}"><code>${repository}</code></a></li>`;
}

test('report: a diff that several repositories share is shown once, listing them all', (t) => {
	const shared = '@@ -1,2 +1,3 @@\n name: rebase\n+permissions: {}\n on: [pull_request_target]';
	const unique = '@@ -4 +4 @@\n-    uses: x\n+    uses: y';
	const results = [
		drifting('ljharb/a', [{ name: 'rebase.yml', diff: shared }, { name: 'node.yml', diff: unique }]),
		drifting('ljharb/b', [{ name: 'rebase.yml', diff: shared }]),
		drifting('inspect-js/c', [{ name: 'rebase.yml', diff: shared }, { name: 'node-pretest.yml', diff: shared }]),
		// the same file with a diff that differs only in its hunk header isn't the same diff
		drifting('inspect-js/d', [{ name: 'rebase.yml', diff: shared.replace('@@ -1,2 +1,3 @@', '@@ -2,2 +2,3 @@') }]),
	];
	const full = report(results, 0, [], { installed: 4, external: 0 }).parts.join('\n');

	t.equal(occurrences(full, `\`\`\`diff\n${shared}\n\`\`\``), 2, 'the shared diff is shown once, and the same diff of another file once, on its own');
	t.equal(occurrences(full, '## Shared diffs'), 1, 'in a section of shared diffs');
	t.ok(full.includes([
		'<details><summary><b>Shared diff 1</b>: <code>rebase.yml</code>, in 3 repositories</summary>',
		'',
		`\`\`\`diff\n${shared}\n\`\`\``,
		'',
		'<ul>',
		fileItem('ljharb/a', 'rebase.yml'),
		fileItem('ljharb/b', 'rebase.yml'),
		fileItem('inspect-js/c', 'rebase.yml'),
		'</ul>',
		'',
		'</details>',
	].join('\n')), 'numbered, with its file’s name, and every repository it’s in, each linking to its file');
	t.notOk(full.includes('Shared diff 2'), 'and no other diff is shared');
	['ljharb/a', 'ljharb/b', 'inspect-js/c'].forEach((repository) => {
		t.ok(full.includes(`<li><a href="https://github.com/${repository}/blob/HEAD/.github/workflows/rebase.yml"><code>rebase.yml</code></a> (shared diff 1)</li>`), `${repository}’s row links its file, and names its shared diff`);
	});
	[
		['ljharb/a', 'node.yml', unique],
		['inspect-js/c', 'node-pretest.yml', shared],
		['inspect-js/d', 'rebase.yml', shared.replace('@@ -1,2 +1,3 @@', '@@ -2,2 +2,3 @@')],
	].forEach(([repository, name, diff]) => {
		t.ok(full.includes(`<li><details><summary><a href="https://github.com/${repository}/blob/HEAD/.github/workflows/${name}"><code>${name}</code></a></summary>\n\n\`\`\`diff\n${diff}\n\`\`\`\n\n</details></li>`), `${repository}’s ${name}, a diff no other repository has, is in its row`);
	});
	t.ok(full.indexOf('## Shared diffs') > full.lastIndexOf('</table>'), 'the shared diffs come after the tables');
	t.ok(full.endsWith(legend()), 'and before the commands');

	const none = report([results[0], results[3]], 0, [], { installed: 2, external: 0 }).parts.join('\n');
	t.notOk(none.includes('hared diff'), 'with no diff shared, there’s no section of them');
	t.end();
});

test('report: shared diffs are ordered by how many repositories share them, then by file name, then by diff', (t) => {
	/** @type {(name: string, diff: string) => Drift} */
	const drift = (name, diff) => ({ name, diff });
	const results = [
		drifting('b/one', [drift('m.yml', '+m'), drift('a.yml', '+2')]),
		drifting('a/two', [drift('a.yml', '+2'), drift('z.yml', '+z')]),
		drifting('a/three', [drift('a.yml', '+1'), drift('z.yml', '+z'), drift('m.yml', '+m')]),
		drifting('B/four', [drift('a.yml', '+1'), drift('z.yml', '+z')]),
	];
	const full = report(results, 0, [], { installed: 4, external: 0 }).parts.join('\n');
	const order = Array.from(full.matchAll(/<b>Shared diff (?<number>\d+)<\/b>: <code>(?<name>[^<]+)<\/code>, in (?<count>\d) repositories<\/summary>\n\n```diff\n(?<diff>[^\n]+)\n/g), (m) => Object.values(m.groups ?? {}).join(' '));
	t.deepEqual(order, [
		'1 z.yml 3 +z',
		'2 a.yml 2 +1',
		'3 a.yml 2 +2',
		'4 m.yml 2 +m',
	], 'most repositories first, then by file name, then by diff');
	t.ok(full.includes(['<ul>', fileItem('B/four', 'z.yml'), fileItem('a/two', 'z.yml'), fileItem('a/three', 'z.yml'), '</ul>'].join('\n')), 'each listing its repositories in the order the tables have them');
	// b's table (b/one, then B/four), then a's (a/two, then a/three)
	t.deepEqual(Array.from(full.matchAll(/<code>(?<name>[^<]+)<\/code><\/a> \(shared diff (?<number>\d)\)/g), (m) => `${m.groups?.name} ${m.groups?.number}`), [
		'm.yml 4',
		'a.yml 3',
		'a.yml 2',
		'z.yml 1',
		'a.yml 3',
		'z.yml 1',
		'a.yml 2',
		'z.yml 1',
		'm.yml 4',
	], 'and each row names its shared diffs by those numbers');
	t.end();
});

test('report: a shared diff with too many repositories for one file is split between them, each part reopening its list', (t) => {
	const diff = '@@ -1 +1,2 @@\n name: rebase\n+permissions: {}';
	const results = Array.from({ length: 3000 }, (_, i) => drifting(`${'o'.repeat(39)}/${`repo-${i}-`.padEnd(100, 'x')}`, [{ name: 'rebase.yml', diff }]));
	const { parts } = report(results, 0, [], { installed: 3000, external: 0 });
	const label = '<b>Shared diff 1</b>: <code>rebase.yml</code>, in 3000 repositories';
	const listParts = parts.filter((part) => part.includes(`<details><summary>${label}`));
	t.ok(listParts.length > 1, `the list is in several parts (${listParts.length} of ${parts.length})`);
	listParts.forEach((part, i) => {
		const n = parts.indexOf(part);
		t.ok(part.length <= maxPartLength && Buffer.byteLength(part) < 1000000, `part ${n + 1} is under 1 MB`);
		if (i > 0) {
			t.ok(part.startsWith(`_continued (${n + 1}/${parts.length})_\n\n<details><summary>${label} (continued)</summary>\n\n<ul>\n<li>`), `part ${n + 1} reopens the list`);
		}
		if (i < listParts.length - 1) {
			t.ok(part.endsWith(`</li>\n</ul>\n\n</details>\n\n_continued below (${n + 2}/${parts.length})_`), `part ${n + 1} closes it`);
		}
	});
	const full = parts.join('\n');
	t.equal(occurrences(full, `\`\`\`diff\n${diff}\n\`\`\``), 1, 'the diff is shown once');
	t.ok(results.every(({ repository }) => occurrences(full, fileItem(repository, 'rebase.yml')) === 1), 'and every repository is listed, once');
	t.ok(parts.at(-1)?.endsWith(legend()), 'the last part ends with the commands');
	t.end();
});
