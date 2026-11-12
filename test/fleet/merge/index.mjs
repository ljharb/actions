import path from 'path';

import test from 'tape';

import { fixBranch, relockBranch } from '../../../fleet/lib/branches.mjs';
import { replyMarker } from '../../../fleet/commands/replies.mjs';
import { parseCommand } from '../../../fleet/commands/syntax.mjs';
import { marker as saidMarker } from '../../../fleet/lib/said.mjs';
import { botEmail, prCommit } from '../commands/helpers/merge.mjs';
import {
	bot,
	entry,
	expectedDetails,
	failing,
	issueToken,
	matching,
	passing,
	pending,
	pr,
	reactions,
	replies,
	runScript,
	runURL,
	writtenQueue,
} from '../commands/helpers/merge-run.mjs';

/** @import { Scenario as GitHubScenario } from '../lib/helpers/github.mjs' */
/** @import { MergeScenario, CI } from '../commands/helpers/merge.mjs' */
/** @import { Test } from 'tape' */

const script = path.join('fleet', 'merge', 'index.mjs');
// recently enough that nothing queued has been waiting too long
const queuedAt = new Date(Date.now() - (60 * 60 * 1000)).toISOString();
const privateNote = 'Queued PRs in private repositories, if any, were also checked; nothing about them is shown here.';

/** @type {(...entries: Record<string, unknown>[]) => string} */
function queue(...entries) {
	return JSON.stringify(entries.map((e) => ({ ...e, queuedAt })));
}

/** @type {(t: Test, merge: MergeScenario, github?: GitHubScenario) => ReturnType<typeof runScript>} */
function run(t, merge, github = {}) {
	return runScript(t, script, { merge, github });
}

/** @type {(commentId: number) => string} */
function row(commentId) {
	return `(queued by [this comment](https://github.com/ljharb/actions/issues/9#issuecomment-${commentId}))`;
}

/** @type {(rows: string[], details?: string[]) => string} */
function expectedReply(rows, details = []) {
	return /** @type {string[]} */ ([]).concat(
		`The merge queue, as of [this run](${runURL}):`,
		'',
		'| Repository | Outcome |',
		'| --- | --- |',
		rows,
		details.flatMap((text) => ['', text]),
		'',
		privateNote,
	).join('\n');
}

test('fleet/merge: an empty queue is only read, and then there are no PRs to keep up to date', (t) => {
	[['no variable', undefined], ['an empty list', '[]'], ['nothing that’s an entry', '[1]']].forEach(([label, value]) => {
		const { status, stdout, requests } = run(t, typeof value === 'string' ? { queue: value } : {});
		t.equal(status, 0, `${label}: exits successfully`);
		t.match(stdout, /^the merge queue is empty$/m, `${label}: says so`);
		t.match(stdout, /^no open PRs from the App’s branches to keep up to date$/m, `${label}: and that there are no PRs to keep up to date`);
		t.deepEqual(
			requests.map((r) => `${r.method} ${r.path}`),
			[
				'GET /repos/ljharb/actions/installation',
				'POST /app/installations/99/access_tokens',
				'GET /repos/ljharb/actions/actions/variables/FLEET_MERGE_QUEUE',
				'GET /app/installations?per_page=100',
			],
			`${label}: having only read the queue, and listed the App’s installations`,
		);
		t.deepEqual(requests[1].body, { repositories: ['actions'], permissions: { actions_variables: 'write' } }, `${label}: with a token that can only read and write this repository’s variables`); // eslint-disable-line camelcase
	});
	t.end();
});

test('fleet/merge: without the Variables permission, fails naming it', (t) => {
	const { status, stdout, requests } = run(t, { queue: queue(entry('ljharb/a', 1)) }, { deniedPermissions: ['actions_variables'] });
	t.equal(status, 1, 'fails');
	t.ok(stdout.split('\n').includes('::error::Error: the fleet GitHub App could not get a token to read and write Actions variables in `ljharb/actions` (HTTP 422): the App needs the “Variables: Read and write” repository permission, for the merge queue (the `FLEET_MERGE_QUEUE` variable), and must be installed on `ljharb/actions`. After that permission is added to the App, its installation on `ljharb` must approve it (from the account’s settings, under “Applications”, or from GitHub’s email about it) before the App can use it.'), 'naming the permission');
	t.deepEqual(requests.slice(2).map((r) => `${r.method} ${r.path}`), ['GET /app/installations?per_page=100'], 'having done nothing else with the queue, but still keeping the App’s PRs up to date');
	t.end();
});

test('fleet/merge: re-checks each queued PR, merging, keeping, or dropping it', (t) => {
	const closed = { state: 'closed' };
	const {
		status,
		stdout,
		requests,
		summary,
	} = run(t, {
		queue: queue(
			entry('ljharb/a', 1),
			entry('ljharb/a', 2),
			entry('ljharb/b', 1, { commentId: 66 }),
			entry('ljharb/c', 1, { commentId: 66 }),
			entry('ljharb/d', 1, { commentId: 55 }),
			entry('ljharb/e', 1, { commentId: 44 }),
			entry('ljharb/f', 1, { commentId: 33 }),
			entry('ljharb/secret', 1, { commentId: 22, isPrivate: true }),
			entry('stranger/x', 1, { commentId: 11 }),
			entry('ljharb/gone', 1, { commentId: 10 }),
			entry('ljharb/flaky', 1, { commentId: 10 }),
			entry('ljharb/refused', 1, { commentId: 10 }),
			entry('ljharb/secret-gone', 1, { commentId: 22, isPrivate: true }),
		),
		prs: {
			'ljharb/a#1': { ...pr('ljharb/a', 1, fixBranch), ...closed, merged_at: queuedAt }, // eslint-disable-line camelcase
			'ljharb/a#2': pr('ljharb/a', 2, relockBranch, { sha: 'pushed-since' }),
			'ljharb/b#1': pr('ljharb/b', 1, fixBranch),
			'ljharb/c#1': pr('ljharb/c', 1, fixBranch),
			'ljharb/d#1': pr('ljharb/d', 1, fixBranch),
			'ljharb/e#1': pr('ljharb/e', 1, fixBranch),
			'ljharb/f#1': { ...pr('ljharb/f', 1, fixBranch), ...closed },
			'ljharb/secret#1': { ...pr('ljharb/secret', 1, fixBranch), base: { ref: 'main', repo: { private: true } } },
			'ljharb/flaky#1': pr('ljharb/flaky', 1, fixBranch),
			'ljharb/refused#1': pr('ljharb/refused', 1, fixBranch),
		},
		ci: {
			'b-1': failing,
			'c-1': pending,
			'd-1': passing,
			'secret-1': passing,
			'refused-1': passing,
		},
		refs: { 'ljharb/e': 'moved-on', 'ljharb/flaky': { status: 502, body: { message: 'Bad Gateway' } } },
		refUpdates: { 'ljharb/refused': { status: 422, body: {} } },
		eyes: {
			77: [{ id: 701, user: { login: bot } }],
			55: [{ id: 702, user: { login: bot } }],
			44: [{ id: 703, user: { login: bot } }],
			33: [{ id: 704, user: { login: bot } }],
			10: [{ id: 705, user: { login: bot } }],
		},
	});

	t.equal(status, 1, 'fails, since a public PR could not be checked, and another could not be merged');
	const annotations = stdout.split('\n').filter((l) => (/^::(?:warning|error)/).test(l));
	t.equal(annotations.length, 2, 'two annotations');
	t.match(annotations[0], /^::warning::ljharb\/flaky#1: Bad Gateway/, 'warning about the one that could not be checked');
	t.equal(annotations[1], '::error::2 queued PRs could not be checked or merged', 'and failing, counting it and the refused one');
	t.notOk(stdout.includes('secret') || stdout.includes('stranger') || stdout.includes('shh'), 'never naming a private repository, or an account that isn’t allowed');

	t.deepEqual(
		matching(requests, 'PATCH', /\/git\/refs\//).map((r) => `${r.path} ${r.body.sha} ${r.body.force}`),
		[
			'/repos/ljharb/d/git/refs/heads%2Fmain d-1 false',
			'/repos/ljharb/refused/git/refs/heads%2Fmain refused-1 false',
			'/repos/ljharb/secret/git/refs/heads%2Fmain secret-1 false',
		],
		'fast-forwards the ones whose CI passed to the commit that was queued, never forced, a private one’s last',
	);
	t.deepEqual(matching(requests, 'GET', /^\/repos\/stranger\//), [], 'never touching an account that’s no longer allowed');

	t.deepEqual(
		writtenQueue(requests),
		[
			entry('ljharb/c', 1, { commentId: 66, commandFailed: true }),
			entry('ljharb/flaky', 1, { commentId: 10, commandFailed: true }),
		],
		'keeps the pending one, and the one that could not be checked (each of whose commands has now failed); drops the rest',
	);

	const body = expectedReply(
		[
			`| \`ljharb/a\` | already merged https://github.com/ljharb/a/pull/1 ${row(77)} |`,
			`| \`ljharb/a\` | not merged https://github.com/ljharb/a/pull/2: the PR changed after \`/merge\`; run \`/merge\` again ${row(77)} |`,
			`| \`ljharb/b\` | not merged https://github.com/ljharb/b/pull/1: its checks failed (see below) ${row(66)} |`,
			`| \`ljharb/d\` | merged https://github.com/ljharb/d/pull/1 ${row(55)} |`,
			`| \`ljharb/e\` | not merged https://github.com/ljharb/e/pull/1: it needs updating: the App’s PRs must be one commit, on \`main\`’s tip, and the App rebases them onto it every 10 minutes, so run \`/merge\` again after that (not GitHub’s “Update branch”, whose commit isn’t the App’s, so \`/merge\` would never take it) ${row(44)} |`,
			`| \`ljharb/f\` | not merged https://github.com/ljharb/f/pull/1: it was closed ${row(33)} |`,
			`| \`ljharb/gone\` | not merged https://github.com/ljharb/gone/pull/1: it could not be read (HTTP 404) ${row(10)} |`,
			`| \`ljharb/refused\` | not merged https://github.com/ljharb/refused/pull/1: GitHub refused to fast-forward \`main\` to it (HTTP 422), eg because of a branch protection rule ${row(10)} |`,
		],
		[expectedDetails('ljharb/b', 1, 'failed', [['tests', 'failure']])],
	);
	t.deepEqual(replies(requests), [body], 'one reply, on the issue they were queued from, listing what happened to each public PR it resolved');
	t.equal(summary, body, 'which is also the run summary');
	t.ok(matching(requests, 'POST', /^\/repos\/ljharb\/actions\/issues\/9\/comments$/).every((r) => r.authorization === issueToken), 'as the App’s bot');

	t.deepEqual(reactions(requests, 77), ['+confused', '-701'], 'a command whose PRs are all resolved, one of them unmerged, is 😕');
	t.deepEqual(reactions(requests, 55), ['+rocket', '-702'], 'one whose PRs were all merged is 🚀');
	t.deepEqual(reactions(requests, 44), ['+confused', '-703'], 'one that needs updating is 😕');
	t.deepEqual(reactions(requests, 33), ['+confused', '-704'], 'as is one that was closed');
	t.deepEqual(reactions(requests, 66), [], 'one with a PR still queued keeps its 👀');
	t.deepEqual(reactions(requests, 10), [], 'as does one with a PR that could not be checked');
	t.deepEqual(reactions(requests, 22), [], 'and one with only a private PR is never touched');
	t.deepEqual(reactions(requests, 11), ['+confused'], 'one for an account that’s no longer allowed is 😕, though nothing is said about its PR');

	const tokens = matching(requests, 'POST', /^\/app\/installations\/99\/access_tokens$/).map((r) => r.body);
	t.deepEqual(
		tokens.filter((b) => b.repositories[0] === 'd'),
		[
			{ repositories: ['d'], permissions: { contents: 'read', pull_requests: 'read', checks: 'read', actions: 'read', statuses: 'read' } }, // eslint-disable-line camelcase
			{ repositories: ['d'], permissions: { contents: 'write', workflows: 'write' } },
		],
		'each repository is read, and merged, with tokens for only it',
	);
	t.end();
});

test('fleet/merge: a run that resolves nothing changes nothing, and says nothing', (t) => {
	const { status, requests } = run(t, {
		queue: queue(entry('ljharb/c', 1), entry('ljharb/secret', 1, { isPrivate: true })),
		prs: { 'ljharb/c#1': pr('ljharb/c', 1, fixBranch), 'ljharb/secret#1': pr('ljharb/secret', 1, fixBranch) },
		ci: { 'c-1': pending, 'secret-1': {} },
	});
	t.equal(status, 0, 'exits successfully');
	t.equal(writtenQueue(requests), undefined, 'the queue isn’t written');
	t.deepEqual(replies(requests), [], 'nothing is posted');
	t.deepEqual(reactions(requests), [], 'nor reacted to');
	t.end();
});

test('fleet/merge: failures that `continue-on-error` hides never keep a queued PR from being merged, and are noted', (t) => {
	/** @type {(extra?: Record<string, unknown>[]) => CI} */
	const optional = (extra = []) => ({
		checkRuns: [
			{
				id: 1,
				name: 'optional',
				status: 'completed',
				conclusion: 'failure',
				app: { slug: 'github-actions' },
				check_suite: { id: 70 }, // eslint-disable-line camelcase
			},
			...extra,
		],
		runs: [{ id: 7, check_suite_id: 70, jobs: [] }], // eslint-disable-line camelcase
	});
	const { status, requests } = run(t, {
		queue: queue(entry('ljharb/g', 1, { commentId: 66 }), entry('ljharb/h', 1, { commentId: 66 })),
		prs: { 'ljharb/g#1': pr('ljharb/g', 1, fixBranch), 'ljharb/h#1': pr('ljharb/h', 1, fixBranch) },
		ci: {
			'g-1': optional(),
			'h-1': optional([{ id: 2, name: 'tests', status: 'completed', conclusion: 'failure' }]),
		},
	});
	t.equal(status, 0, 'exits successfully');
	t.deepEqual(matching(requests, 'PATCH', /\/git\/refs\//).map((r) => r.path), ['/repos/ljharb/g/git/refs/heads%2Fmain'], 'merging the one whose only failure is hidden');
	const note = '; optional jobs failed, which doesn’t block merging (see below)';
	t.deepEqual(
		replies(requests),
		[expectedReply(
			[
				`| \`ljharb/g\` | merged https://github.com/ljharb/g/pull/1${note} ${row(66)} |`,
				`| \`ljharb/h\` | not merged https://github.com/ljharb/h/pull/1: its checks failed (see below)${note} ${row(66)} |`,
			],
			[
				expectedDetails('ljharb/g', 1, 'optional', [['optional', 'failure']]),
				expectedDetails('ljharb/h', 1, 'failed', [['tests', 'failure']]),
				expectedDetails('ljharb/h', 1, 'optional', [['optional', 'failure']]),
			],
		)],
		'noting the hidden failures of each, beside the other’s real one',
	);
	t.end();
});

test('fleet/merge: what failed on a private queued PR is never listed', (t) => {
	const { status, stdout, requests } = run(t, {
		queue: queue(entry('ljharb/b', 1), entry('ljharb/secret', 1, { isPrivate: true, commentId: 22 })),
		prs: { 'ljharb/b#1': pr('ljharb/b', 1, fixBranch), 'ljharb/secret#1': pr('ljharb/secret', 1, fixBranch) },
		ci: { 'b-1': failing, 'secret-1': failing },
	});
	t.equal(status, 0, 'exits successfully');
	t.ok(matching(requests, 'GET', /^\/repos\/ljharb\/secret\/commits\/secret-1\/check-runs/).length > 0, 'the private one’s CI is read');
	t.deepEqual(
		replies(requests),
		[expectedReply([`| \`ljharb/b\` | not merged https://github.com/ljharb/b/pull/1: its checks failed (see below) ${row(77)} |`], [expectedDetails('ljharb/b', 1, 'failed', [['tests', 'failure']])])],
		'only the public one is listed, with what failed on it below the table',
	);
	t.notOk([stdout].concat(replies(requests)).join('\n').includes('secret'), 'the private one, whose checks failed too, is never mentioned, nor what failed on it');
	t.end();
});

test('fleet/merge: a run that resolves only private PRs says nothing', (t) => {
	const { status, stdout, requests } = run(t, {
		queue: queue(entry('ljharb/c', 1), entry('ljharb/secret', 1, { isPrivate: true, commentId: 22 })),
		prs: { 'ljharb/c#1': pr('ljharb/c', 1, fixBranch), 'ljharb/secret#1': pr('ljharb/secret', 1, fixBranch) },
		ci: { 'c-1': pending, 'secret-1': passing },
	});
	t.equal(status, 0, 'exits successfully');
	t.deepEqual(writtenQueue(requests), [entry('ljharb/c', 1)], 'the merged private PR is dropped');
	t.deepEqual(replies(requests), [], 'with no reply');
	t.deepEqual([...reactions(requests), ...reactions(requests, 22)], [], 'and no reaction');
	t.equal(matching(requests, 'GET', /^\/repos\/ljharb\/actions\/installation$/).length, 1, 'never even getting a token to write issues');
	t.notOk(stdout.includes('secret'), 'nor any mention of it');
	t.end();
});

test('fleet/merge: a public PR whose repository became private is no longer shown', (t) => {
	const { requests } = run(t, {
		queue: queue(entry('ljharb/now-secret', 1, { commentId: 66 })),
		prs: { 'ljharb/now-secret#1': { ...pr('ljharb/now-secret', 1, fixBranch), base: { ref: 'main', repo: { private: true } } } },
		ci: { 'now-secret-1': passing },
		eyes: { 66: [{ id: 801, user: { login: bot } }] },
	});
	t.equal(matching(requests, 'PATCH', /\/git\/refs\//).length, 1, 'it is merged');
	t.deepEqual(replies(requests), [], 'but not mentioned');
	t.deepEqual(reactions(requests, 66), ['+rocket', '-801'], 'though its command, which named it when it was public, is finished');
	t.end();
});

test('fleet/merge: says which rule refused merging a public repository’s queued PR', (t) => {
	const classic = { status: 422, body: { message: 'Protected branch update failed for refs/heads/main.\n\nAt least 1 approving review is required by reviewers with write access.', documentation_url: 'https://docs.github.com/rest/git/refs#update-a-reference' } }; // eslint-disable-line camelcase
	/** @type {(message: string) => typeof classic} */
	const secretly = (message) => ({ ...classic, body: { ...classic.body, message } });
	const {
		status,
		stdout,
		requests,
		summary,
	} = run(t, {
		queue: queue(
			entry('ljharb/classic', 1),
			entry('ljharb/ruleset', 1),
			entry('ljharb/secret', 1, { isPrivate: true }),
			entry('ljharb/now-secret', 1),
		),
		prs: {
			'ljharb/classic#1': pr('ljharb/classic', 1, fixBranch),
			'ljharb/ruleset#1': pr('ljharb/ruleset', 1, fixBranch),
			'ljharb/secret#1': { ...pr('ljharb/secret', 1, fixBranch), base: { ref: 'main', repo: { private: true } } },
			'ljharb/now-secret#1': { ...pr('ljharb/now-secret', 1, fixBranch), base: { ref: 'main', repo: { private: true } } },
		},
		ci: {
			'classic-1': passing,
			'ruleset-1': passing,
			'secret-1': passing,
			'now-secret-1': passing,
		},
		refUpdates: {
			'ljharb/classic': classic,
			'ljharb/ruleset': { status: 422, body: { message: 'Repository rule violations found\n\nChanges must be made through a pull request.\n\nRequired status check "tests" is expected.\n\n' } },
			'ljharb/secret': secretly('Protected branch update failed for refs/heads/main.\n\nCommits must have verified signatures.'),
			'ljharb/now-secret': secretly('Repository rule violations found\n\nCannot update this protected ref.\n\n'),
		},
	});
	t.equal(status, 1, 'fails, since a public PR could not be merged');
	t.match(stdout, /^::error::2 queued PRs could not be checked or merged$/m, 'counting only the public ones');
	t.equal(matching(requests, 'PATCH', /\/git\/refs\//).length, 4, 'trying to fast-forward each');
	const fix = 'merge it yourself, or let the fleet GitHub App bypass that rule where GitHub allows that (eg, with a ruleset’s bypass list, or classic branch protection’s “Allow specified actors to bypass required pull requests”)';
	const body = expectedReply([
		`| \`ljharb/classic\` | not merged https://github.com/ljharb/classic/pull/1: GitHub refused to fast-forward \`main\` to it (HTTP 422): \`Protected branch update failed for refs/heads/main. At least 1 approving review is required by reviewers with write access.\`; ${fix} ${row(77)} |`,
		`| \`ljharb/ruleset\` | not merged https://github.com/ljharb/ruleset/pull/1: GitHub refused to fast-forward \`main\` to it (HTTP 422): \`Repository rule violations found Changes must be made through a pull request. Required status check "tests" is expected.\`; ${fix} ${row(77)} |`,
	]);
	t.deepEqual(replies(requests), [body], 'quoting what GitHub said refusing each public one, which names the rule, and how to fix it');
	t.equal(summary, body, 'which is also the run summary');
	t.notOk(
		[stdout].concat(replies(requests)).some((text) => (/secret|verified signatures|Cannot update/).test(text)),
		'never naming a private repository (nor one made private since it was queued), nor saying what refused it',
	);
	t.end();
});

test('fleet/merge: a resolved PR whose command has another still queued', (t) => {
	const { status, stdout, requests } = run(t, {
		queue: queue(entry('ljharb/refused', 1), entry('ljharb/c', 1)),
		prs: { 'ljharb/refused#1': pr('ljharb/refused', 1, fixBranch), 'ljharb/c#1': pr('ljharb/c', 1, fixBranch) },
		ci: { 'refused-1': passing, 'c-1': pending },
		refUpdates: { 'ljharb/refused': { status: 403 } },
	});
	t.equal(status, 1, 'fails, since it could not be merged');
	t.match(stdout, /^::error::1 queued PR could not be checked or merged$/m, 'saying so, in the singular');
	t.equal(replies(requests).length, 1, 'replies');
	t.deepEqual(reactions(requests), [], 'but leaves the command’s 👀, since it has a PR still queued');
	t.equal(matching(requests, 'GET', /^\/app$/).length, 1, 'looking up the bot only once, to check the PRs’ commits, though its reaction isn’t swapped');
	t.deepEqual(writtenQueue(requests), [entry('ljharb/c', 1, { commandFailed: true })], 'and notes in the queue that the command has failed');
	t.end();
});

test('fleet/merge: a command that had already failed is 😕 once its last PR is merged', (t) => {
	const { requests } = run(t, {
		queue: queue(entry('ljharb/d', 1, { commentId: 66, commandFailed: true })),
		prs: { 'ljharb/d#1': pr('ljharb/d', 1, fixBranch) },
		ci: { 'd-1': passing },
		eyes: { 66: [{ id: 801, user: { login: bot } }, { id: 802, user: { login: 'someone-else' } }] },
	});
	t.deepEqual(reactions(requests, 66), ['+confused', '-801'], 'removing only the bot’s 👀');
	t.end();
});

test('fleet/merge: swapping a queued command’s reaction is only a best effort', (t) => {
	/** @type {[CI, string][]} */
	const cases = [[passing, 'done'], [failing, 'failed']];
	cases.forEach(([ci, outcome]) => {
		const { status, stdout, requests } = run(t, {
			queue: queue(entry('ljharb/d', 1, { commentId: 66 })),
			prs: { 'ljharb/d#1': pr('ljharb/d', 1, fixBranch) },
			ci: { 'd-1': ci },
			eyesError: { status: 500 },
		});
		t.equal(status, 0, `${outcome}: exits successfully`);
		t.match(stdout, new RegExp(`^::warning::could not mark a queued \`/merge\` as ${outcome}: could not be read \\(HTTP 500\\)$`, 'm'), `${outcome}: warning that it could not`);
		t.equal(replies(requests).length, 1, `${outcome}: after replying`);
	});
	t.end();
});

test('fleet/merge: a queue that can’t be written fails the run', (t) => {
	const { status, stdout } = run(t, {
		queue: queue(entry('ljharb/d', 1)),
		prs: { 'ljharb/d#1': { ...pr('ljharb/d', 1, fixBranch), state: 'closed' } },
		queueWriteError: { status: 500, body: { message: 'nope' } },
	});
	t.equal(status, 1, 'fails');
	t.match(stdout, /^::error::HttpError: nope/m, 'with the error');
	t.end();
});

test('fleet/merge: a thrown non-Error', (t) => {
	const { status, stdout } = runScript(t, script, { env: { GITHUB_REPOSITORY: 'fleet-test-throw' }, throwStringOnSplit: 'fleet-test-throw' });
	t.equal(status, 1, 'fails');
	t.match(stdout, /^::error::fleet-test-throw$/m, 'with the stringified value');
	t.end();
});

test('fleet/merge: the App’s open PRs are kept up to date in every run, and that failing fails the run', (t) => {
	const unreadable = runScript(t, script, {
		merge: {},
		github: { installations: [{ id: 1, account: { login: 'ljharb' } }], installationRepos: { 1: { status: 500, body: { message: 'nope' } } } },
	});
	t.equal(unreadable.status, 1, 'an installation that can’t be read fails the run');
	t.ok(unreadable.stdout.split('\n').includes('::warning::installation 1 could not be read (HTTP 500)'), 'warning about it');
	t.ok(unreadable.stdout.split('\n').includes('::error::the App’s open PRs could not all be kept up to date (failures: 1)'), 'and saying how many failed');

	const unlisted = runScript(t, script, { merge: {}, github: { installations: { status: 500, body: { message: 'no installations' } } } });
	t.equal(unlisted.status, 1, 'not being able to list the installations fails the run');
	t.match(unlisted.stdout, /^::error::HttpError: no installations/m, 'with the error');
	t.end();
});

test('fleet/merge: a PR whose base branch changed after `/merge` is dropped, unmerged', (t) => {
	const { status, requests } = run(t, {
		queue: queue(entry('ljharb/d', 1, { commentId: 66, base: 'main' })),
		prs: { 'ljharb/d#1': { ...pr('ljharb/d', 1, fixBranch), base: { ref: 'other', repo: { full_name: 'ljharb/d', private: false } } } }, // eslint-disable-line camelcase
		ci: { 'd-1': passing },
		eyes: { 66: [{ id: 801, user: { login: bot } }] },
	});
	t.equal(status, 0, 'exits successfully');
	t.deepEqual(matching(requests, 'PATCH', /\/git\/refs\//), [], 'never updating the branch it was retargeted to');
	t.deepEqual(writtenQueue(requests), [], 'dropping it');
	t.deepEqual(replies(requests), [expectedReply([`| \`ljharb/d\` | not merged https://github.com/ljharb/d/pull/1: the PR changed after \`/merge\`; run \`/merge\` again ${row(66)} |`])], 'saying why');
	t.deepEqual(reactions(requests, 66), ['+confused', '-801'], 'and its command is 😕');
	t.end();
});

test('fleet/merge: a PR whose checks never finish is dropped after 24 hours', (t) => {
	const hour = 60 * 60 * 1000;
	const { status, requests } = run(t, {
		queue: JSON.stringify([
			{ ...entry('ljharb/c', 1, { commentId: 66 }), queuedAt: new Date(Date.now() - (25 * hour)).toISOString() },
			{ ...entry('ljharb/e', 1, { commentId: 55 }), queuedAt: new Date(Date.now() - (23 * hour)).toISOString() },
			{ ...entry('ljharb/secret', 1, { commentId: 44, isPrivate: true }), queuedAt: new Date(Date.now() - (25 * hour)).toISOString() },
		]),
		prs: { 'ljharb/c#1': pr('ljharb/c', 1, fixBranch), 'ljharb/e#1': pr('ljharb/e', 1, fixBranch), 'ljharb/secret#1': pr('ljharb/secret', 1, fixBranch) },
		ci: { 'c-1': pending, 'e-1': pending, 'secret-1': pending },
		eyes: { 66: [{ id: 801, user: { login: bot } }], 44: [{ id: 802, user: { login: bot } }] },
	});
	t.equal(status, 0, 'exits successfully');
	t.deepEqual(matching(requests, 'PATCH', /\/git\/refs\//), [], 'merging nothing');
	t.deepEqual(writtenQueue(requests), [entry('ljharb/e', 1, { commentId: 55 })], 'dropping the ones queued more than 24 hours ago, a private one’s too, and keeping the rest');
	t.deepEqual(replies(requests), [expectedReply([`| \`ljharb/c\` | not merged https://github.com/ljharb/c/pull/1: its checks still hadn’t all finished 24 hours after \`/merge\`; run \`/merge\` again once they have ${row(66)} |`])], 'saying why, of only the public one');
	t.deepEqual(reactions(requests, 66), ['+confused', '-801'], 'its command is 😕');
	t.deepEqual(reactions(requests, 44), [], 'and the private one’s is never touched');
	t.end();
});

test('fleet/merge: only the App’s bot’s own commits are merged, once every check suite has finished', (t) => {
	const someoneElse = 'it has commits by someone else; review and merge it yourself';
	const names = ['author', 'committer', 'email', 'many', 'suite-pending', 'suite-failed', 'suite-empty', 'suite-stuck', 'secret'];
	const { status, stdout, requests } = run(t, {
		queue: queue(...names.map((n) => entry(`ljharb/${n}`, 1, { commentId: 66, isPrivate: n === 'secret' }))),
		prs: Object.fromEntries(names.map((n) => [`ljharb/${n}#1`, pr(`ljharb/${n}`, 1, fixBranch)])),
		commits: {
			'ljharb/author#1': [prCommit('x', { author: 'mallory' }), prCommit('author-1')],
			'ljharb/committer#1': [prCommit('committer-1', { committer: 'mallory' })],
			'ljharb/email#1': [prCommit('email-1', { author: null, committer: null, authorEmail: botEmail, committerEmail: botEmail })],
			'ljharb/many#1': Array.from({ length: 251 }, (_, i) => prCommit(i === 250 ? 'many-1' : `c${i}`)),
			'ljharb/secret#1': [prCommit('secret-1', { author: 'mallory' })],
		},
		ci: {
			'author-1': passing,
			'committer-1': passing,
			'email-1': passing,
			'many-1': passing,
			'suite-pending-1': { ...passing, checkSuites: [{ id: 1, status: 'queued', conclusion: null, latest_check_runs_count: 0 }] }, // eslint-disable-line camelcase
			'suite-failed-1': { ...passing, checkSuites: [{ id: 2, status: 'completed', conclusion: 'failure', latest_check_runs_count: 1, app: { name: 'Other CI' } }] }, // eslint-disable-line camelcase
			'suite-empty-1': { ...passing, checkSuites: [{ id: 3, status: 'completed', conclusion: 'neutral', latest_check_runs_count: 0 }] }, // eslint-disable-line camelcase
			'suite-stuck-1': { ...passing, checkSuites: [{ id: 4, status: 'queued', conclusion: null, latest_check_runs_count: 0, created_at: '2026-01-01T00:00:00Z', app: { name: 'Codecov' } }, { id: 5, status: 'queued', conclusion: null, latest_check_runs_count: 0, created_at: '2026-01-01T00:00:00Z', app: { name: 'Renovate' } }] }, // eslint-disable-line camelcase
			'secret-1': passing,
		},
		eyes: { 66: [{ id: 801, user: { login: bot } }] },
	});
	t.equal(status, 0, 'exits successfully');
	t.deepEqual(
		matching(requests, 'PATCH', /\/git\/refs\//).map((r) => `${r.path} ${r.body.sha}`),
		[
			'/repos/ljharb/email/git/refs/heads%2Fmain email-1',
			'/repos/ljharb/suite-empty/git/refs/heads%2Fmain suite-empty-1',
			'/repos/ljharb/suite-stuck/git/refs/heads%2Fmain suite-stuck-1',
		],
		'merges only the PR whose commits are the bot’s by its noreply email, the one whose only other suite is empty and neutral, and the one whose other suites have no check runs and were left queued long ago, to the pinned head',
	);
	t.deepEqual(writtenQueue(requests), [entry('ljharb/suite-pending', 1, { commentId: 66, commandFailed: true })], 'keeps the one with an unfinished check suite (noting that its command has now failed); drops the rest, the private one too');
	t.deepEqual(
		replies(requests),
		[expectedReply(
			[
				`| \`ljharb/author\` | not merged https://github.com/ljharb/author/pull/1: ${someoneElse} ${row(66)} |`,
				`| \`ljharb/committer\` | not merged https://github.com/ljharb/committer/pull/1: ${someoneElse} ${row(66)} |`,
				`| \`ljharb/email\` | merged https://github.com/ljharb/email/pull/1 ${row(66)} |`,
				`| \`ljharb/many\` | not merged https://github.com/ljharb/many/pull/1: it has at least 250 commits, more than GitHub lists, so they can’t all be checked to be the App’s own; review and merge it yourself ${row(66)} |`,
				`| \`ljharb/suite-failed\` | not merged https://github.com/ljharb/suite-failed/pull/1: its checks failed (see below) ${row(66)} |`,
				`| \`ljharb/suite-empty\` | merged https://github.com/ljharb/suite-empty/pull/1 ${row(66)} |`,
				`| \`ljharb/suite-stuck\` | merged https://github.com/ljharb/suite-stuck/pull/1 ${row(66)} |`,
			],
			[expectedDetails('ljharb/suite-failed', 1, 'failed', [['check suite 2 (Other CI)', 'failure']])],
		)],
		'saying why each public one wasn’t merged',
	);
	t.notOk(stdout.includes('secret'), 'never mentioning the private one');
	t.deepEqual(reactions(requests, 66), [], 'its command keeps its 👀, with a PR still queued');
	t.equal(matching(requests, 'GET', /^\/app$/).length, 1, 'looking up the bot once');
	t.end();
});

test('fleet/merge: merging the App’s last open PR in a repository hides, as resolved, what’s only about it', (t) => {
	/** @type {(id: number, body: string, login?: string) => Record<string, unknown>} */
	const listed = (id, body, login = bot) => ({
		id,
		node_id: `IC_${id}`, // eslint-disable-line camelcase
		body,
		user: { login },
	});
	const mergeD = parseCommand('/merge ljharb/d');
	if (mergeD.type !== 'merge') {
		throw new TypeError('not a command');
	}
	const issue = /** @type {Record<string, unknown>[]} */ ([]).concat(
		listed(50, mergeD.line, 'maintainer'),
		listed(51, `${replyMarker(mergeD)}\n\`${mergeD.line}\` (…):`),
		listed(52, '/merge ljharb/e', 'maintainer'),
		listed(53, '/merge ljharb/f', 'maintainer'),
		listed(54, '/merge ljharb/secret', 'maintainer'),
		listed(55, '/merge ljharb/d ljharb/e', 'maintainer'),
	);
	const {
		status,
		stdout,
		requests,
	} = runScript(t, script, {
		merge: {
			queue: queue(
				entry('ljharb/d', 1),
				entry('ljharb/e', 1),
				entry('ljharb/f', 1),
				entry('ljharb/f', 2),
				entry('ljharb/secret', 1, { isPrivate: true }),
			),
			prs: {
				'ljharb/d#1': pr('ljharb/d', 1, fixBranch),
				'ljharb/e#1': pr('ljharb/e', 1, fixBranch),
				'ljharb/f#1': pr('ljharb/f', 1, fixBranch),
				'ljharb/f#2': pr('ljharb/f', 2, relockBranch),
				'ljharb/secret#1': { ...pr('ljharb/secret', 1, fixBranch), base: { ref: 'main', repo: { private: true } } },
			},
			// as GitHub can still list a PR just merged as open
			openPulls: {
				'ljharb/d': [pr('ljharb/d', 1, fixBranch)],
				'ljharb/e': [pr('ljharb/e', 1, fixBranch), pr('ljharb/e', 2, relockBranch)],
				'ljharb/f': [pr('ljharb/f', 1, fixBranch), pr('ljharb/f', 2, relockBranch)],
				'ljharb/secret': [],
			},
			ci: {
				'd-1': passing,
				'e-1': passing,
				'f-1': passing,
				'f-2': passing,
				'secret-1': passing,
			},
		},
		commands: {
			comments: {
				'ljharb/actions#9': issue,
				'ljharb/d#1': [listed(1, `${saidMarker('stuck', 'abc0')}\nneeds a person`)],
				'ljharb/secret#1': [listed(2, `${saidMarker('stuck', 'abc0')}\nneeds a person`)],
			},
		},
	});
	t.equal(status, 0, 'exits successfully');
	t.equal(matching(requests, 'PATCH', /\/git\/refs\//).length, 5, 'merging each');
	t.deepEqual(
		matching(requests, 'POST', /^\/graphql$/).filter((r) => r.body.variables.classifier).map((r) => [r.body.variables.id, r.body.variables.classifier]),
		[
			['IC_1', 'RESOLVED'],
			['IC_2', 'RESOLVED'],
			['IC_50', 'RESOLVED'],
			['IC_51', 'RESOLVED'],
			['IC_53', 'RESOLVED'],
		],
		'hiding what the App said on each PR it merged, then, once it’s replied, on the report, what’s only about a public repository it merged its last open PR in; never about one with an open PR left, a private one, or more than one',
	);
	t.match(stdout, /^hid 3 comments about a repository whose PRs the App has all merged as resolved$/m, 'logging only how many');
	t.notOk(stdout.includes('secret'), 'never naming the private one');
	t.end();
});
