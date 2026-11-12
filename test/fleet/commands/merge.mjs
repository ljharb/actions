import path from 'path';

import test from 'tape';

import { legend } from '../../../fleet/commands/syntax.mjs';
import { relockBranch, fixBranch } from '../../../fleet/lib/branches.mjs';
import { maxQueueBytes } from '../../../fleet/lib/merge.mjs';
import { installedRepo } from '../lib/helpers/github.mjs';
import {
	bot,
	checkRun,
	comment,
	entry,
	expectedDetails,
	expectedReply,
	failing,
	issueToken,
	matching,
	passing,
	pending,
	pr,
	reactions,
	replies,
	report,
	repo,
	runScript,
	writtenQueue,
} from './helpers/merge-run.mjs';
import { marker as saidMarker } from '../../../fleet/lib/said.mjs';
import { replyMarker } from '../../../fleet/commands/replies.mjs';
import { parseCommand } from '../../../fleet/commands/syntax.mjs';
import { botEmail, prCommit } from './helpers/merge.mjs';

/** @import { Scenario as GitHubScenario, Recorded } from '../lib/helpers/github.mjs' */
/** @import { CI, MergeScenario } from './helpers/merge.mjs' */
/** @import { Test } from 'tape' */

const script = path.join('fleet', 'commands', 'index.mjs');

/** @type {(n: number) => string} */
const url = (n) => `https://github.com/ljharb/a/pull/${n}`;
const needsUpdating = 'it needs updating: the App’s PRs must be one commit, on `main`’s tip, and the App rebases them onto it every 10 minutes, so run `/merge` again after that (not GitHub’s “Update branch”, whose commit isn’t the App’s, so `/merge` would never take it)';
const queuedText = 'its checks haven’t all finished, so it’ll be merged once they pass';

/** @type {(names: string[], privates?: string[]) => GitHubScenario} */
function github(names, privates = []) {
	return {
		installations: [{ id: 1, account: { login: 'ljharb' } }],
		installationRepos: { 1: [...names, ...privates].map((n) => installedRepo('ljharb', n, { private: privates.includes(n) })) },
		repos: Object.fromEntries([
			...names.map((n) => [`ljharb/${n}`, repo({ archived: n === 'archived' })]),
			...privates.map((n) => [`ljharb/${n}`, repo({ isPrivate: true })]),
		]),
	};
}

/** @type {(t: Test, line: string, options?: { github?: GitHubScenario, merge?: MergeScenario }) => ReturnType<typeof runScript>} */
function command(t, line, options = {}) {
	return runScript(t, script, {
		event: { issue: report, comment: comment(line) },
		github: options.github ?? github(['a']),
		merge: options.merge ?? {},
	});
}

/** @type {(requests: Recorded[]) => string[]} */
function refUpdates(requests) {
	return matching(requests, 'PATCH', /\/git\/refs\//).map((r) => `${r.path} ${r.body.sha} force=${r.body.force}`);
}

/** @type {(stdout: string) => string[]} */
function annotations(stdout) {
	return stdout.split('\n').filter((l) => (/^::(?:warning|error|notice)/).test(l));
}

// what every scenario below has in `ljharb/a`: one of each kind of PR
const prs = {
	'ljharb/a': [
		pr('ljharb/a', 1, fixBranch),
		pr('ljharb/a', 2, relockBranch),
		pr('ljharb/a', 3, fixBranch, { user: 'mallory' }),
		pr('ljharb/a', 4, fixBranch, { headRepo: 'ljharb/a-fork' }),
		pr('ljharb/a', 5, 'some-branch'),
	],
};

test('fleet/commands: `/merge` rejects filters it can’t use, and anything unknown', (t) => {
	[
		['/merge ljharb rebase.yml', '`/merge` takes only repository (`owner/name`) and account (`owner`) filters, not `rebase.yml`.'],
		['/dry-run merge missing', '`/dry-run merge` takes only repository (`owner/name`) and account (`owner`) filters, not `missing`.'],
		['/merge', '`/merge` needs at least one filter: every repository at once is too broad.'],
		['/merge @x', 'Unknown filter: `@x`.'],
	].forEach(([line, message]) => {
		const { status, requests } = command(t, line);
		t.equal(status, 0, `${line}: exits successfully`);
		t.deepEqual(replies(requests), [`${message} Nothing was done.\n\n${legend()}`], `${line}: says why, with the legend`);
		t.deepEqual(reactions(requests), ['+eyes', '+confused', '-501'], `${line}: and swaps its 👀 for 😕`);
		t.deepEqual(matching(requests, 'GET', /^\/app\/installations/), [], `${line}: without discovering anything`);
	});
	t.end();
});

test('fleet/commands: `/dry-run merge`', (t) => {
	const {
		status,
		stdout,
		requests,
		summary,
	} = command(t, '/dry-run merge ljharb', {
		github: github(['a', 'archived', 'b', 'c', 'none'], ['secret']),
		merge: {
			openPulls: {
				...prs,
				'ljharb/archived': [pr('ljharb/archived', 1, fixBranch)],
				'ljharb/b': [pr('ljharb/b', 1, relockBranch)],
				'ljharb/c': [pr('ljharb/c', 1, fixBranch)],
				'ljharb/secret': [pr('ljharb/secret', 1, fixBranch)],
			},
			ci: {
				'a-1': passing,
				'a-2': pending,
				'b-1': failing,
				'secret-1': passing,
			},
			refs: { 'ljharb/c': 'moved-on' },
		},
	});
	t.equal(status, 0, 'exits successfully');
	const body = expectedReply(
		'/dry-run merge ljharb',
		[
			`| \`ljharb/a\` | would merge ${url(1)}<br>would queue ${url(2)}: its checks haven’t all finished, so it would be merged once they pass |`,
			'| `ljharb/b` | would not merge https://github.com/ljharb/b/pull/1: its checks failed (see below) |',
			`| \`ljharb/c\` | would not merge https://github.com/ljharb/c/pull/1: ${needsUpdating} |`,
		],
		true,
		[expectedDetails('ljharb/b', 1, 'failed', [['tests', 'failure']])],
	);
	t.deepEqual(replies(requests), [body], 'says what it would do with each PR the bot opened from its own branches; the others, an archived repository, one without any (unless named), and a private one, aren’t mentioned');
	t.equal(summary, body, 'the run summary has the same');
	t.deepEqual(refUpdates(requests), [], 'merges nothing');
	t.equal(writtenQueue(requests), undefined, 'queues nothing');
	t.deepEqual(matching(requests, 'GET', /\/actions\/variables\//), [], 'and never even reads the queue');
	t.deepEqual(reactions(requests), ['+eyes', '+rocket', '-501'], 'swaps its 👀 for 🚀');
	t.notOk([stdout, summary, ...replies(requests)].join('\n').includes('secret'), 'never naming the private repository');
	t.deepEqual(matching(requests, 'GET', /^\/repos\/ljharb\/archived\//), [], 'never reading the archived repository');

	const tokens = matching(requests, 'POST', /^\/app\/installations\/1\/access_tokens$/).filter((r) => r.body?.repositories);
	t.deepEqual(
		tokens.map((r) => r.body),
		['a', 'b', 'c', 'none', 'secret'].map((name) => ({
			repositories: [name],
			permissions: {
				contents: 'read',
				pull_requests: 'read', // eslint-disable-line camelcase
				checks: 'read',
				actions: 'read',
				statuses: 'read',
			},
		})),
		'each read with a token for only that repository, that can only read, a private one’s last',
	);
	t.end();
});

test('fleet/commands: `/merge` fast-forwards what passed, queues what’s pending, and says what failed', (t) => {
	const line = `/merge ${['a', 'b', 'c', 'none', 'refused', 'secret', 'secret-pending'].map((n) => `ljharb/${n}`).join(' ')}`;
	const { status, stdout, requests } = command(t, line, {
		github: github(['a', 'b', 'c', 'none', 'refused'], ['secret', 'secret-pending']),
		merge: {
			openPulls: {
				...prs,
				'ljharb/b': [pr('ljharb/b', 1, relockBranch)],
				'ljharb/c': [pr('ljharb/c', 1, fixBranch)],
				'ljharb/refused': [pr('ljharb/refused', 1, fixBranch)],
				'ljharb/secret': [pr('ljharb/secret', 1, fixBranch)],
				'ljharb/secret-pending': [pr('ljharb/secret-pending', 1, fixBranch)],
			},
			ci: {
				'a-1': passing,
				'a-2': pending,
				'b-1': failing,
				'refused-1': passing,
				'secret-1': passing,
				'secret-pending-1': {},
			},
			refs: { 'ljharb/c': 'moved-on' },
			refUpdates: { 'ljharb/refused': { status: 422, body: { message: 'Protected branch update failed: the secret-rule rule' } } },
		},
	});
	t.equal(status, 1, 'fails, since a public repository could not be merged');
	t.deepEqual(
		annotations(stdout),
		[
			'::error::1 repository could not be merged',
		],
		'saying how many',
	);
	t.deepEqual(
		refUpdates(requests),
		[
			'/repos/ljharb/a/git/refs/heads%2Fmain a-1 force=false',
			'/repos/ljharb/refused/git/refs/heads%2Fmain refused-1 force=false',
			'/repos/ljharb/secret/git/refs/heads%2Fmain secret-1 force=false',
		],
		'fast-forwards each passing PR’s base to its head, never forced, a private one’s too',
	);
	const writes = matching(requests, 'PATCH', /\/git\/refs\//);
	t.ok(writes.every((r) => r.authorization === 'token ghs_installation_1'), 'with the installation’s token');
	const writeTokens = matching(requests, 'POST', /^\/app\/installations\/1\/access_tokens$/).filter((r) => r.body?.permissions?.contents === 'write');
	t.deepEqual(writeTokens.map((r) => r.body), ['a', 'refused', 'secret'].map((name) => ({ repositories: [name], permissions: { contents: 'write', workflows: 'write' } })), 'which can push (and change workflow files), for only that repository, only asked for when merging');

	t.deepEqual(
		replies(requests),
		[expectedReply(
			line,
			[
				`| \`ljharb/a\` | merged ${url(1)}<br>queued ${url(2)}: ${queuedText} |`,
				'| `ljharb/b` | not merged https://github.com/ljharb/b/pull/1: its checks failed (see below) |',
				`| \`ljharb/c\` | not merged https://github.com/ljharb/c/pull/1: ${needsUpdating} |`,
				'| `ljharb/none` | nothing to merge |',
				'| `ljharb/refused` | not merged https://github.com/ljharb/refused/pull/1: GitHub refused to fast-forward `main` to it (HTTP 422), eg because of a branch protection rule |',
			],
			false,
			[expectedDetails('ljharb/b', 1, 'failed', [['tests', 'failure']])],
		)],
		'replies with what happened to each public PR, a named repository without any too, and never the refusal’s own message',
	);
	t.notOk(stdout.includes('secret'), 'never naming a private repository, or a refusal’s message');

	t.deepEqual(
		writtenQueue(requests),
		[
			entry('ljharb/a', 2, { commandFailed: true }),
			entry('ljharb/secret-pending', 1, { isPrivate: true, commandFailed: true }),
		],
		'queues the pending ones, a private one’s too, noting that the command already failed',
	);
	const queueWrite = matching(requests, 'POST', /^\/repos\/ljharb\/actions\/actions\/variables$/);
	t.equal(queueWrite.length, 1, 'creating the queue’s variable, which didn’t exist');
	t.equal(queueWrite[0].authorization, issueToken, 'with the App’s token for this repository');
	t.deepEqual(
		matching(requests, 'POST', /^\/app\/installations\/99\/access_tokens$/).map((r) => r.body),
		[
			{ repositories: ['actions'], permissions: { issues: 'write', metadata: 'read' } },
			{ repositories: ['actions'], permissions: { actions_variables: 'write' } }, // eslint-disable-line camelcase
		],
		'which can only read and write its Actions variables',
	);
	t.deepEqual(reactions(requests), ['+eyes'], 'and, since it queued a public PR, keeps its 👀 until the queue resolves it');
	t.end();
});

test('fleet/commands: `/merge` that resolves everything at once swaps its 👀', (t) => {
	const merged = command(t, '/merge ljharb/a', { merge: { openPulls: { 'ljharb/a': [pr('ljharb/a', 1, fixBranch)] }, ci: { 'a-1': passing } } });
	t.equal(merged.status, 0, 'exits successfully');
	t.deepEqual(replies(merged.requests), [expectedReply('/merge ljharb/a', [`| \`ljharb/a\` | merged ${url(1)} |`], false)], 'merged');
	t.deepEqual(reactions(merged.requests), ['+eyes', '+rocket', '-501'], 'all merged: 🚀');
	t.equal(writtenQueue(merged.requests), undefined, 'with nothing to change in the queue, it isn’t written');
	t.equal(matching(merged.requests, 'GET', /^\/repos\/ljharb\/actions\/actions\/variables\/FLEET_MERGE_QUEUE$/).length, 1, 'though it’s read');

	const nothing = command(t, '/merge ljharb');
	t.deepEqual(replies(nothing.requests), [expectedReply('/merge ljharb', [], false)], 'nothing to merge');
	t.deepEqual(reactions(nothing.requests), ['+eyes', '+rocket', '-501'], 'is 🚀 too');

	const failed = command(t, '/merge ljharb/a', { merge: { openPulls: { 'ljharb/a': [pr('ljharb/a', 1, fixBranch)] }, ci: { 'a-1': failing } } });
	t.equal(failed.status, 0, 'failed CI doesn’t fail the run');
	t.deepEqual(reactions(failed.requests), ['+eyes', '+confused', '-501'], 'but is 😕');

	const behind = command(t, '/merge ljharb/a', { merge: { openPulls: { 'ljharb/a': [pr('ljharb/a', 1, fixBranch)] }, refs: { 'ljharb/a': 'moved-on' } } });
	t.deepEqual(reactions(behind.requests), ['+eyes', '+confused', '-501'], 'as is needing updating');
	t.equal(writtenQueue(behind.requests), undefined, 'which is never queued');

	const privatePending = command(t, '/merge ljharb', {
		github: github([], ['secret']),
		merge: { openPulls: { 'ljharb/secret': [pr('ljharb/secret', 1, fixBranch)] }, ci: { 'secret-1': pending } },
	});
	t.deepEqual(writtenQueue(privatePending.requests), [entry('ljharb/secret', 1, { isPrivate: true })], 'a private PR is queued');
	t.deepEqual(reactions(privatePending.requests), ['+eyes', '+rocket', '-501'], 'but never keeps the 👀, which would show that it was');
	t.deepEqual(replies(privatePending.requests), replies(nothing.requests), 'and the reply is just what it is when nothing matches');
	t.end();
});

test('fleet/commands: `/merge` replaces a PR’s older queue entry, finishing the command that queued it', (t) => {
	const older = [
		{ ...entry('ljharb/a', 1, { commentId: 55, headSha: 'old' }), queuedAt: '2026-01-01T00:00:00.000Z' },
		{ ...entry('ljharb/a', 2, { commentId: 66 }), queuedAt: '2026-01-01T00:00:00.000Z' },
		{ ...entry('ljharb/a', 9, { commentId: 66 }), queuedAt: '2026-01-01T00:00:00.000Z' },
		{ ...entry('ljharb/z', 1, { commentId: 44, commandFailed: true }), queuedAt: '2026-01-01T00:00:00.000Z' },
		{ ...entry('ljharb/z', 2, { commentId: 44, isPrivate: true }), queuedAt: '2026-01-01T00:00:00.000Z' },
		{ ...entry('ljharb/secret', 1, { commentId: 33, isPrivate: true }), queuedAt: '2026-01-01T00:00:00.000Z' },
	];
	const { status, requests } = command(t, '/merge ljharb', {
		github: github(['a', 'z'], ['secret']),
		merge: {
			queue: JSON.stringify(older),
			openPulls: {
				'ljharb/a': [pr('ljharb/a', 1, fixBranch), pr('ljharb/a', 2, relockBranch)],
				'ljharb/z': [pr('ljharb/z', 1, fixBranch)],
				'ljharb/secret': [pr('ljharb/secret', 1, fixBranch)],
			},
			ci: {
				'a-1': pending,
				'a-2': passing,
				'z-1': passing,
				'secret-1': passing,
			},
			eyes: {
				55: [{ id: 601, content: 'eyes', user: { login: bot } }, { id: 602, content: 'eyes', user: { login: 'someone' } }],
				44: [{ id: 603, content: 'eyes', user: { login: 'Fleet-Bot[bot]' } }],
			},
		},
	});
	t.equal(status, 0, 'exits successfully');
	t.deepEqual(
		writtenQueue(requests),
		[
			entry('ljharb/a', 9, { commentId: 66 }),
			entry('ljharb/z', 2, { commentId: 44, isPrivate: true }),
			entry('ljharb/a', 1),
		],
		'the queue keeps only what no newer command resolved: a pending PR is queued again, as the newest command asked; what it merged now is dropped',
	);
	t.deepEqual(reactions(requests, 55), ['+rocket', '-601'], 'a command whose only PR another took over is finished, removing only the bot’s 👀');
	t.deepEqual(reactions(requests, 44), ['+confused', '-603'], 'one whose last public PR was merged now, but which had already failed, is 😕');
	t.deepEqual(reactions(requests, 66), [], 'one with a public PR still queued keeps its 👀');
	t.deepEqual(reactions(requests, 33), [], 'and one with only a private PR is never touched');
	t.deepEqual(reactions(requests), ['+eyes'], 'this command, having queued a public PR, keeps its 👀');
	t.deepEqual(matching(requests, 'PATCH', /^\/repos\/ljharb\/actions\/actions\/variables\/FLEET_MERGE_QUEUE$/).length, 1, 'updating the existing variable');
	t.end();
});

test('fleet/commands: `/merge` never lets the queue outgrow its variable', (t) => {
	const filler = { ...entry('ljharb/filler', 1, { commentId: 11 }), queuedAt: '2026-01-01T00:00:00.000Z' };
	const size = Buffer.byteLength(JSON.stringify(filler)) + 1;
	// so full that one more entry doesn't fit
	const queue = Array.from({ length: Math.floor((maxQueueBytes - 200) / size) }, (_, i) => ({ ...filler, number: 1000 + i }));
	const { status, requests } = command(t, '/merge ljharb', {
		github: github(['a'], ['secret']),
		merge: {
			queue: JSON.stringify(queue),
			openPulls: { 'ljharb/a': [pr('ljharb/a', 2, relockBranch)], 'ljharb/secret': [pr('ljharb/secret', 1, fixBranch)] },
			ci: { 'a-2': pending, 'secret-1': pending },
		},
	});
	t.equal(status, 0, 'exits successfully');
	t.deepEqual(replies(requests), [expectedReply('/merge ljharb', [`| \`ljharb/a\` | not queued ${url(2)}: the merge queue is full; run \`/merge\` again once it has room |`], false)], 'a PR that doesn’t fit isn’t queued, and says why; a private one is never mentioned');
	t.equal(writtenQueue(requests), undefined, 'the queue is left as it was');
	t.deepEqual(reactions(requests), ['+eyes', '+confused', '-501'], 'and the command is 😕');
	t.end();
});

test('fleet/commands: `/merge` queues what fits, and its queued PRs remember that the rest didn’t', (t) => {
	/** @type {(e: Record<string, unknown>) => Record<string, unknown>} */
	const timed = (e) => ({ ...e, queuedAt: '2026-01-01T00:00:00.000Z' });
	const first = Buffer.byteLength(JSON.stringify(timed(entry('ljharb/a', 2))));
	const second = Buffer.byteLength(JSON.stringify(timed(entry('ljharb/b', 1))));
	const filler = timed(entry('', 1, { commentId: 11 }));
	// one filler whose name leaves room for the first PR, but not for both
	const room = first + 1 + Math.floor(second / 2);
	filler.repository = 'x'.repeat(maxQueueBytes - room - Buffer.byteLength(JSON.stringify([filler])));
	const { requests } = command(t, '/merge ljharb', {
		github: github(['a', 'b']),
		merge: {
			queue: JSON.stringify([filler]),
			openPulls: { 'ljharb/a': [pr('ljharb/a', 2, relockBranch)], 'ljharb/b': [pr('ljharb/b', 1, fixBranch)] },
			ci: { 'a-2': pending, 'b-1': pending },
		},
	});
	t.deepEqual(
		replies(requests),
		[expectedReply(
			'/merge ljharb',
			[
				`| \`ljharb/a\` | queued ${url(2)}: ${queuedText} |`,
				'| `ljharb/b` | not queued https://github.com/ljharb/b/pull/1: the merge queue is full; run `/merge` again once it has room |',
			],
			false,
		)],
		'the first fits, and the second doesn’t',
	);
	const written = writtenQueue(requests);
	t.deepEqual(written?.slice(1), [entry('ljharb/a', 2, { commandFailed: true })], 'so the queued one is marked as from a command that failed');
	t.ok(Buffer.byteLength(JSON.stringify(JSON.parse(matching(requests, 'PATCH', /variables\/FLEET_MERGE_QUEUE$/)[0].body.value))) <= maxQueueBytes, 'and the queue still fits');
	t.deepEqual(reactions(requests), ['+eyes'], 'keeping its 👀 until that one is resolved');
	t.end();
});

test('fleet/commands: `/merge` without the Variables permission fails, naming it', (t) => {
	/** @type {[string, Record<string, Record<string, any>[]>][]} */
	const cases = [['something to queue', { 'ljharb/a': [pr('ljharb/a', 2, relockBranch)] }], ['nothing to queue', {}]];
	cases.forEach(([label, openPulls]) => {
		const { status, stdout, requests } = runScript(t, script, {
			event: { issue: report, comment: comment('/merge ljharb') },
			github: { ...github(['a']), deniedPermissions: ['actions_variables'] },
			merge: { openPulls, ci: { 'a-2': pending } },
		});
		t.equal(status, 1, `${label}: fails`);
		t.ok(stdout.split('\n').includes('::error::the fleet GitHub App could not get a token to read and write Actions variables in `ljharb/actions` (HTTP 422): the App needs the “Variables: Read and write” repository permission, for the merge queue (the `FLEET_MERGE_QUEUE` variable), and must be installed on `ljharb/actions`. After that permission is added to the App, its installation on `ljharb` must approve it (from the account’s settings, under “Applications”, or from GitHub’s email about it) before the App can use it.'), `${label}: naming the permission`);
		t.deepEqual(reactions(requests), ['+eyes', '+confused', '-501'], `${label}: 😕`);
		if (label === 'something to queue') {
			t.deepEqual(replies(requests), [expectedReply('/merge ljharb', [`| \`ljharb/a\` | not queued ${url(2)}: the merge queue could not be written |`], false)], `${label}: the reply says it wasn’t queued`);
		}
	});
	t.end();
});

test('fleet/commands: `/merge` in a repository it can’t read, or without the permissions to inspect CI', (t) => {
	const denied = runScript(t, script, {
		event: { issue: report, comment: comment('/merge ljharb/a ljharb/gone') },
		github: { ...github(['a', 'gone']), deniedPermissions: ['checks'], repos: { 'ljharb/a': repo() } },
	});
	t.equal(denied.status, 1, 'fails');
	t.deepEqual(
		replies(denied.requests),
		[expectedReply(
			'/merge ljharb/a ljharb/gone',
			[
				'| `ljharb/a` | failed: `the fleet GitHub App could not get a token for it (HTTP 422): the App needs the “Contents: Read-only”, “Pull requests: Read-only”, “Checks: Read-only”, “Actions: Read-only”, “Commit statuses: Read-only” repository permissions, approved by its installation` |',
				'| `ljharb/gone` | failed: `could not read the repository’s state` |',
			],
			false,
		)],
		'saying which permissions it needs, and which repository couldn’t be read',
	);
	t.match(denied.stdout, /^::error::2 repositories could not be merged$/m, 'counting both');

	const privateDenied = runScript(t, script, {
		event: { issue: report, comment: comment('/merge ljharb') },
		github: { ...github([], ['secret']), deniedPermissions: ['checks'] },
	});
	t.equal(privateDenied.status, 0, 'a private repository’s failure never fails the run');
	t.deepEqual(replies(privateDenied.requests), [expectedReply('/merge ljharb', [], false)], 'nor shows');
	t.deepEqual(annotations(privateDenied.stdout), [], 'anywhere');
	t.end();
});

test('fleet/commands: `/merge` notes failures that `continue-on-error` hides, which never block it, and treats no CI at all as pending', (t) => {
	// as tape-testing/tape#625 had: a step whose failure `continue-on-error` hides, in two runs of the same workflow, which only its check run's `failure` annotations show
	const hidden = {
		checkRuns: [5, 6].map((id) => ({
			...checkRun('tests / non-latest - 0.9'),
			id,
			app: { slug: 'github-actions' },
			url: `https://api.github.com/check-runs/${id}`,
			annotations: [{ annotation_level: 'failure', message: 'Process completed with exit code 1.' }], // eslint-disable-line camelcase
		})),
		runs: [5, 6].map((id) => ({ id, jobs: [{ name: 'tests / non-latest - 0.9', check_run_url: `https://api.github.com/check-runs/${id}`, steps: [{ name: 'tests', conclusion: 'success' }] }] })), // eslint-disable-line camelcase
	};
	const note = '; optional jobs failed, which doesn’t block merging (see below)';
	const hiddenDetails = expectedDetails('ljharb/a', 1, 'optional', [['tests / non-latest - 0.9', 'Process completed with exit code 1.']]);
	const dryRun = command(t, '/dry-run merge ljharb', {
		merge: {
			openPulls: { 'ljharb/a': [pr('ljharb/a', 1, fixBranch), pr('ljharb/a', 2, relockBranch), pr('ljharb/a', 3, fixBranch)] },
			ci: {
				'a-1': hidden,
				// a job whose `continue-on-error` hides its failure: its check run failed, but its workflow run succeeded
				'a-3': {
					checkRuns: [{ ...checkRun('optional', 'failure'), app: { slug: 'github-actions' }, check_suite: { id: 70 } }, checkRun('tests', 'failure')], // eslint-disable-line camelcase
					runs: [{ id: 7, check_suite_id: 70, jobs: [] }], // eslint-disable-line camelcase
				},
			},
		},
	});
	t.deepEqual(
		replies(dryRun.requests),
		[expectedReply(
			'/dry-run merge ljharb',
			[
				`| \`ljharb/a\` | would merge ${url(1)}${note}<br>would queue ${url(2)}: its checks haven’t all finished, so it would be merged once they pass<br>would not merge ${url(3)}: its checks failed (see below)${note} |`,
			],
			true,
			[
				hiddenDetails,
				expectedDetails('ljharb/a', 3, 'failed', [['tests', 'failure']]),
				expectedDetails('ljharb/a', 3, 'optional', [['optional', 'failure']]),
			],
		)],
		'a step that failed under `continue-on-error` doesn’t fail CI, and is noted once; nor does a job that did, which is noted beside a real failure; no checks at all is pending',
	);

	const merged = command(t, '/merge ljharb/a', { merge: { openPulls: { 'ljharb/a': [pr('ljharb/a', 1, fixBranch)] }, ci: { 'a-1': hidden } } });
	t.equal(merged.status, 0, 'exits successfully');
	t.deepEqual(refUpdates(merged.requests), ['/repos/ljharb/a/git/refs/heads%2Fmain a-1 force=false'], 'merging it');
	t.deepEqual(replies(merged.requests), [expectedReply('/merge ljharb/a', [`| \`ljharb/a\` | merged ${url(1)}${note} |`], false, [hiddenDetails])], 'noting what failed that doesn’t block it');
	t.end();
});

test('fleet/commands: `/merge`’s reply is split only between whole collapsed sections, or a section too long for any comment is shown in pieces', (t) => {
	// each short enough to be noted whole
	/** @type {(id: number, count: number) => string[]} */
	const messages = (id, count) => Array.from({ length: count }, (_, i) => `${id}.${i} ${'`'.repeat(4)} ${'x'.repeat(80)}`);
	/** @type {(id: number, count: number) => CI} */
	const hidden = (id, count) => ({
		checkRuns: [
			{
				...checkRun(`job ${id}`),
				id,
				app: { slug: 'github-actions' },
				annotations: messages(id, count).map((message) => ({ annotation_level: 'failure', message })), // eslint-disable-line camelcase
			},
		],
	});

	const several = command(t, '/dry-run merge ljharb/a', {
		merge: {
			openPulls: { 'ljharb/a': [1, 2, 3].map((n) => pr('ljharb/a', n, fixBranch)) },
			ci: {
				'a-1': hidden(11, 250),
				'a-2': hidden(12, 250),
				'a-3': hidden(13, 250),
			},
		},
	});
	const parts = replies(several.requests);
	t.ok(parts.length > 1, `too long for one comment, the reply is in ${parts.length}`);
	t.ok(parts.every((part) => part.length <= 60e3), 'each of which fits');
	[1, 2, 3].forEach((n) => {
		const job = /** @type {[string, ...string[]]} */ ([`job ${n + 10}`].concat(messages(n + 10, 250)));
		const block = expectedDetails('ljharb/a', n, 'optional', [job]).replace(/^```$/gm, '`````');
		t.equal(parts.filter((part) => part.includes(block)).length, 1, `#${n}’s collapsed section is whole, in one comment, fenced longer than any backtick run in it`);
	});
	t.ok(parts.every((part) => (part.match(/^<details>/gm) ?? []).length === (part.match(/^<\/details>$/gm) ?? []).length), 'no comment has a section that another one finishes');

	const huge = command(t, '/dry-run merge ljharb/a', {
		merge: {
			openPulls: { 'ljharb/a': [pr('ljharb/a', 1, fixBranch)] },
			ci: { 'a-1': hidden(21, 700) },
		},
	});
	const hugeParts = replies(huge.requests);
	const job = /** @type {[string, ...string[]]} */ (['job 21'].concat(messages(21, 700)));
	const block = expectedDetails('ljharb/a', 1, 'optional', [job]).replace(/^```$/gm, '`````');
	t.ok(hugeParts[0].includes(`| \`ljharb/a\` | would merge ${url(1)}; optional jobs failed, which doesn’t block merging (see below) |`), 'a section too long for any comment still leaves the table in the first');
	const sources = hugeParts.flatMap((part) => {
		const match = part.match(/_✂️ This item is too long to fit in one part, so it’s shown as its source, in \d+ pieces: this is piece \d+ of \d+\._\n\n(?<ticks>`{3,})\n(?<source>[^]*)\n\k<ticks>/u);
		return match ? [match.groups?.source ?? ''] : [];
	});
	t.ok(sources.length > 1, `and is shown as its source, in ${sources.length} pieces, each in a comment of its own`);
	t.equal(sources.join(''), block, 'which are the whole section, in order');
	t.end();
});

test('fleet/commands: `/merge` whose reply fails after it queued a public PR keeps its 👀', (t) => {
	const queued = command(t, '/merge ljharb/a', {
		github: { ...github(['a']), commentErrorAfter: 0 },
		merge: { openPulls: { 'ljharb/a': [pr('ljharb/a', 2, relockBranch)] }, ci: { 'a-2': pending } },
	});
	t.equal(queued.status, 1, 'fails, since it could not reply');
	t.deepEqual(writtenQueue(queued.requests), [entry('ljharb/a', 2)], 'having queued the PR');
	t.deepEqual(reactions(queued.requests), ['+eyes'], 'so its 👀 stays, for the queue to swap once it resolves the PR, rather than conflicting with it');

	const merged = command(t, '/merge ljharb/a', {
		github: { ...github(['a']), commentErrorAfter: 0 },
		merge: { openPulls: { 'ljharb/a': [pr('ljharb/a', 1, fixBranch)] }, ci: { 'a-1': passing } },
	});
	t.equal(merged.status, 1, 'with nothing queued, it fails too');
	t.deepEqual(reactions(merged.requests), ['+eyes', '+confused', '-501'], 'but its 👀 is swapped for 😕, since its reply failed');
	t.end();
});

test('fleet/commands: `/merge` takes only PRs of the App’s bot’s own commits, once every check suite has finished', (t) => {
	const someoneElse = 'it has commits by someone else; review and merge it yourself';
	const names = ['author', 'committer', 'email', 'many', 'suite-pending', 'suite-failed', 'suite-empty', 'suite-stuck'];
	const merge = {
		openPulls: Object.fromEntries([...names, 'secret'].map((n) => [`ljharb/${n}`, [pr(`ljharb/${n}`, 1, fixBranch)]])),
		commits: {
			'ljharb/author#1': [prCommit('x', { author: 'mallory' }), prCommit('author-1')],
			'ljharb/committer#1': [prCommit('committer-1', { committer: 'mallory' })],
			'ljharb/email#1': [prCommit('email-1', { author: null, committer: null, authorEmail: botEmail, committerEmail: botEmail })],
			'ljharb/many#1': Array.from({ length: 300 }, (_, i) => prCommit(i === 299 ? 'many-1' : `c${i}`)),
			'ljharb/secret#1': [prCommit('secret-1', { committer: 'mallory' })],
		},
		ci: {
			'author-1': pending,
			'committer-1': pending,
			'email-1': passing,
			'many-1': passing,
			'suite-pending-1': { ...passing, checkSuites: [{ id: 1, status: 'in_progress', conclusion: null, latest_check_runs_count: 0 }] }, // eslint-disable-line camelcase
			'suite-failed-1': { ...passing, checkSuites: [{ id: 2, status: 'completed', conclusion: 'timed_out', latest_check_runs_count: 3 }] }, // eslint-disable-line camelcase
			'suite-empty-1': { ...passing, checkSuites: [{ id: 3, status: 'completed', conclusion: null, latest_check_runs_count: 0 }] }, // eslint-disable-line camelcase
			'suite-stuck-1': { ...passing, checkSuites: [{ id: 4, status: 'queued', conclusion: null, latest_check_runs_count: 0, created_at: '2026-01-01T00:00:00Z', app: { name: 'Codecov' } }, { id: 5, status: 'queued', conclusion: null, latest_check_runs_count: 0, created_at: '2026-01-01T00:00:00Z', app: { name: 'Renovate' } }] }, // eslint-disable-line camelcase
			'secret-1': pending,
		},
	};
	const line = `/merge ${names.map((n) => `ljharb/${n}`).join(' ')} ljharb/secret`;
	const { status, stdout, requests } = command(t, line, { github: github(names, ['secret']), merge });
	t.equal(status, 0, 'exits successfully');
	t.deepEqual(
		refUpdates(requests),
		[
			'/repos/ljharb/email/git/refs/heads%2Fmain email-1 force=false',
			'/repos/ljharb/suite-empty/git/refs/heads%2Fmain suite-empty-1 force=false',
			'/repos/ljharb/suite-stuck/git/refs/heads%2Fmain suite-stuck-1 force=false',
		],
		'merges only the PRs whose commits are all the bot’s (by its noreply email, when GitHub links them to no user), whose check suites have all finished, an empty one with no conclusion too, and ignoring suites with no check runs that apps left queued long ago',
	);
	t.deepEqual(writtenQueue(requests), [entry('ljharb/suite-pending', 1, { commandFailed: true })], 'queues only the one with an unfinished check suite: never one with someone else’s commits, even while its CI is pending, nor a private one’s');
	t.deepEqual(
		replies(requests),
		[expectedReply(
			line,
			[
				`| \`ljharb/author\` | not merged https://github.com/ljharb/author/pull/1: ${someoneElse} |`,
				`| \`ljharb/committer\` | not merged https://github.com/ljharb/committer/pull/1: ${someoneElse} |`,
				'| `ljharb/email` | merged https://github.com/ljharb/email/pull/1 |',
				'| `ljharb/many` | not merged https://github.com/ljharb/many/pull/1: it has at least 250 commits, more than GitHub lists, so they can’t all be checked to be the App’s own; review and merge it yourself |',
				'| `ljharb/suite-empty` | merged https://github.com/ljharb/suite-empty/pull/1 |',
				'| `ljharb/suite-failed` | not merged https://github.com/ljharb/suite-failed/pull/1: its checks failed (see below) |',
				`| \`ljharb/suite-pending\` | queued https://github.com/ljharb/suite-pending/pull/1: ${queuedText} |`,
				'| `ljharb/suite-stuck` | merged https://github.com/ljharb/suite-stuck/pull/1 |',
			],
			false,
			[expectedDetails('ljharb/suite-failed', 1, 'failed', [['check suite 2', 'timed_out']])],
		)],
		'saying why each public one wasn’t merged',
	);
	t.notOk(stdout.includes('secret'), 'never mentioning the private one');
	t.deepEqual(matching(requests, 'GET', /\/repos\/ljharb\/(?:author|committer|many)\/(?:compare|commits\/)/), [], 'never even reading CI, or comparing, for one it won’t merge for its commits');

	const dry = command(t, '/dry-run merge ljharb/author', { github: github(names), merge });
	t.deepEqual(replies(dry.requests), [expectedReply('/dry-run merge ljharb/author', [`| \`ljharb/author\` | would not merge https://github.com/ljharb/author/pull/1: ${someoneElse} |`], true)], 'a dry run says it wouldn’t merge it');
	t.end();
});

test('fleet/commands: `/merge` hides, as resolved, what’s only about a repository once it merges the App’s last open PR there', (t) => {
	/** @type {(id: number, body: string, login?: string) => Record<string, unknown>} */
	const listed = (id, body, login = bot) => ({
		id,
		node_id: `IC_${id}`, // eslint-disable-line camelcase
		body,
		user: { login },
	});
	/** @type {(line: string) => string} */
	const answer = (line) => {
		const parsed = parseCommand(line);
		if (parsed.type !== 'fix' && parsed.type !== 'merge') {
			throw new TypeError(line);
		}
		return `${replyMarker(parsed)}\n\`${line}\` (…):`;
	};
	const issue = [
		listed(60, '/dry-run merge ljharb/a', 'maintainer'),
		listed(61, answer('/dry-run merge ljharb/a')),
		listed(62, '/fix LJHarb/A rebase.yml', 'someone'),
		listed(63, answer('/fix ljharb/a rebase.yml')),
		listed(64, '/merge ljharb/b', 'maintainer'),
		listed(65, answer('/merge ljharb/b')),
		listed(66, '/merge ljharb/a ljharb/b', 'maintainer'),
		listed(67, answer('/merge ljharb/a ljharb/b')),
		listed(68, '/merge ljharb/secret', 'maintainer'),
		listed(69, 'thanks for merging ljharb/a!', 'maintainer'),
	];
	const merge = {
		openPulls: {
			'ljharb/a': [pr('ljharb/a', 1, fixBranch)],
			'ljharb/b': [pr('ljharb/b', 1, fixBranch), pr('ljharb/b', 2, relockBranch)],
			'ljharb/secret': [pr('ljharb/secret', 1, fixBranch)],
		},
		ci: {
			'a-1': passing,
			'b-1': passing,
			'b-2': pending,
			'secret-1': passing,
		},
	};
	/** @type {(line: string, options?: { github?: GitHubScenario }) => ReturnType<typeof runScript>} */
	const merging = (line, options = {}) => runScript(t, script, {
		event: { issue: report, comment: comment(line) },
		github: { ...github(['a', 'b'], ['secret']), ...options.github },
		commands: {
			permissions: { maintainer: 'write' },
			comments: {
				'ljharb/actions#9': issue.concat(listed(77, line, 'maintainer')),
				'ljharb/a#1': [
					listed(1, `${saidMarker('stuck', 'abc0')}\nneeds a person`),
					listed(2, `${saidMarker('stuck', 'abc0')}\nquoting the bot`, 'mallory'),
					listed(3, 'no marker'),
				],
				'ljharb/b#1': [listed(4, `${saidMarker('conflict', 'abc0', 'ba5e')}\nconflicted`)],
				'ljharb/secret#1': [listed(5, `${saidMarker('stuck', 'abc0')}\nneeds a person`)],
			},
		},
		merge,
	});
	/** @type {(requests: Recorded[]) => [string, string][]} */
	const hidden = (requests) => matching(requests, 'POST', /^\/graphql$/).filter((r) => r.body.variables.classifier).map((r) => [r.body.variables.id, r.body.variables.classifier]);

	const all = merging('/merge ljharb');
	t.equal(all.status, 0, 'exits successfully');
	t.deepEqual(refUpdates(all.requests).map((u) => u.split(' ')[0]), ['/repos/ljharb/a/git/refs/heads%2Fmain', '/repos/ljharb/b/git/refs/heads%2Fmain', '/repos/ljharb/secret/git/refs/heads%2Fmain'], 'merging what’s ready');
	t.deepEqual(
		hidden(all.requests),
		[
			['IC_1', 'RESOLVED'],
			['IC_4', 'RESOLVED'],
			['IC_5', 'RESOLVED'],
			['IC_60', 'RESOLVED'],
			['IC_61', 'RESOLVED'],
			['IC_62', 'RESOLVED'],
			['IC_63', 'RESOLVED'],
		],
		'hiding what the App said on each PR it merged, a private one’s too; then, once it’s replied, on the report, every command only about a public repository it merged its last open PR in, and the App’s replies to those, but never its own new reply, nor anything about a repository with an open PR left, about another repository too, or about a private one',
	);
	t.deepEqual(
		matching(all.requests, 'POST', /^\/app\/installations\/1\/access_tokens$/).map((r) => r.body).filter((b) => b.permissions.pull_requests === 'write'),
		['a', 'b', 'secret'].map((n) => ({ repositories: [n], permissions: { pull_requests: 'write' } })), // eslint-disable-line camelcase
		'hiding what’s on a PR with a token for only its repository, that can only do that',
	);
	t.match(all.stdout, /^hid 4 comments about a repository whose PRs the App has all merged as resolved$/m, 'logging only how many');
	t.notOk(all.stdout.includes('secret'), 'never naming a private repository');

	const one = merging('/merge ljharb/a');
	t.deepEqual(
		hidden(one.requests).map(([id]) => id),
		[
			'IC_1',
			'IC_61',
			'IC_60',
			'IC_61',
			'IC_62',
			'IC_63',
			'IC_77',
		],
		'the command itself too, when it’s only about that repository (after hiding, as outdated, the App’s reply to a dry run of it)',
	);

	const dry = merging('/dry-run merge ljharb/a');
	t.deepEqual(hidden(dry.requests), [['IC_61', 'OUTDATED']], 'a dry run merges nothing, so hides nothing as resolved');

	const refused = merging('/merge ljharb/a', { github: { minimized: ['IC_60'], minimizeFails: ['IC_1', 'IC_61'] } });
	t.equal(refused.status, 0, 'failing to hide one fails nothing');
	t.deepEqual(hidden(refused.requests).map(([id]) => id), ['IC_1', 'IC_61', 'IC_61', 'IC_62', 'IC_63', 'IC_77'], 'trying the rest, but none already hidden');
	t.match(refused.stdout, /^::warning::could not hide 1 of the App’s comments on a PR it merged as resolved \(FORBIDDEN\)$/m, 'on the PR too');
	t.match(refused.stdout, /^::warning::could not hide 1 of the comments about a repository whose PRs the App has all merged as resolved \(FORBIDDEN\)$/m, 'only warning, never naming it');
	t.end();
});
