import { getOctokit } from '@actions/github';
import nock from 'nock';
import test from 'tape';

import { appAuth } from '../../../fleet/lib/app.mjs';
import {
	botBranches,
	fixBranch,
	isBotBranch,
	relockBranch,
} from '../../../fleet/lib/branches.mjs';
import {
	assess,
	behindReason,
	candidatePRs,
	ciStatus,
	entryKey,
	fastForward,
	fits,
	maxQueueBytes,
	messageOf,
	queueOctokit,
	readPermissions,
	readQueue,
	repoOctokit,
	statusOf,
	writePermissions,
	writeQueue,
} from '../../../fleet/lib/merge.mjs';
import { quietMinutes, unreportedPending } from '../../../fleet/lib/merge-guards.mjs';
import {
	botEmail,
	botUser,
	mockMerge,
	prCommit,
} from '../commands/helpers/merge.mjs';
import { mockGitHub, privateKey } from './helpers/github.mjs';

/** @typedef {import('./helpers/github.mjs').Recorded} Recorded */
/** @typedef {import('./helpers/github.mjs').Scenario} Scenario */
/** @typedef {import('../commands/helpers/merge.mjs').MergeScenario} MergeScenario */
/** @typedef {import('../commands/helpers/merge.mjs').CI} CI */

/** @type {() => void} */
let current = () => {};

// each scenario replaces the one before it, even within a test
/** @type {(t: import('tape').Test, merge: MergeScenario, github?: Scenario) => Recorded[]} */
function setup(t, merge, github = {}) {
	current();
	nock.disableNetConnect();
	/** @type {Recorded[]} */
	const requests = [];
	const teardowns = [mockMerge(merge, (r) => requests.push(r)), mockGitHub(github, (r) => requests.push(r))];
	current = () => {
		teardowns.forEach((teardown) => teardown());
		current = () => {};
	};
	t.teardown(() => {
		current();
		// nock's net-connect block is process-wide; lift it so later test files in this tape process are unaffected
		nock.enableNetConnect();
	});
	return requests;
}

/**
 * Runs `fn`, returning what it writes to stdout (where `@actions/core` writes its commands) instead of writing it.
 * @type {<T>(fn: () => Promise<T>) => Promise<{ result: T, stdout: string }>}
 */
async function captureStdout(fn) {
	let stdout = '';
	const { write } = process.stdout;
	process.stdout.write = /** @type {typeof write} */ (function (/** @type {string} */ chunk) { // eslint-disable-line no-extra-parens
		stdout += String(chunk);
		return true;
	});
	try {
		return { result: await fn(), stdout };
	} finally {
		process.stdout.write = write;
	}
}

const commit = { owner: 'o', name: 'r', head: 'h1' };
const octokit = getOctokit('token');

/** @type {(name: string, conclusion: string | null, extra?: Record<string, unknown>) => Record<string, unknown>} */
function checkRun(name, conclusion, extra = {}) {
	return {
		id: name.length, name, status: 'completed', conclusion, url: `https://api.github.com/repos/o/r/check-runs/${name}`, app: { slug: 'some-ci' }, ...extra,
	};
}

/** @type {(name: string, steps: Record<string, unknown>[], runId?: number) => Record<string, unknown>} */
function job(name, steps, runId = 7) {
	return {
		name, check_run_url: `https://api.github.com/repos/o/r/check-runs/${name}`, steps, run_id: runId, // eslint-disable-line camelcase
	};
}

/** @type {(id: number, conclusion: string | null, extra?: Record<string, unknown>) => Record<string, unknown>} */
function suite(id, conclusion, extra = {}) {
	return {
		id, status: 'completed', conclusion, latest_check_runs_count: 1, app: { name: 'CI app' }, ...extra, // eslint-disable-line camelcase
	};
}

/** @type {(t: import('tape').Test, ci: CI) => Promise<Awaited<ReturnType<typeof ciStatus>>>} */
async function classify(t, ci) {
	setup(t, { ci: { h1: ci } });
	return ciStatus(octokit, commit);
}

test('branches', (t) => {
	t.equal(fixBranch, 'fleet/workflows', '`/fix`’s branch');
	t.equal(relockBranch, 'actions-lock/relock', 'the relock’s branch');
	t.deepEqual(botBranches, [fixBranch, relockBranch], 'the bot’s branches are both');
	t.ok(Object.isFrozen(botBranches), 'and can’t be changed');
	t.ok(isBotBranch(fixBranch) && isBotBranch(relockBranch), 'each is one of the bot’s branches');
	t.notOk(isBotBranch('main') || isBotBranch('fleet/workflows/x'), 'and nothing else is');
	t.end();
});

test('ciStatus: pending', async (t) => {
	t.deepEqual(await classify(t, {}), { kind: 'pending' }, 'no check runs and no statuses: CI hasn’t registered yet, so it’s pending, never passing');
	t.deepEqual(await classify(t, { checkRuns: [checkRun('a', 'success'), checkRun('b', null, { status: 'in_progress' })] }), { kind: 'pending' }, 'a check run still in progress');
	t.deepEqual(await classify(t, { checkRuns: [checkRun('a', null, { status: 'queued' })] }), { kind: 'pending' }, 'a queued check run');
	t.deepEqual(await classify(t, { statuses: [{ context: 'ci/x', state: 'pending' }] }), { kind: 'pending' }, 'a pending commit status');
	t.deepEqual(await classify(t, { checkRuns: [checkRun('a', 'success')], statuses: [{ context: 'ci/x', state: 'pending' }] }), { kind: 'pending' }, 'a pending status, with every check run passed');
	for (const status of ['requested', 'queued', 'pending', 'waiting', 'in_progress']) {
		t.deepEqual(await classify(t, { checkRuns: [checkRun('a', 'success')], runs: [{ id: 7, jobs: [], status, conclusion: null }] }), { kind: 'pending' }, `every check run so far passed, but a workflow run on the commit is \`${status}\`, so jobs waiting on others (which have no check runs yet) may still fail`); // eslint-disable-line no-await-in-loop
	}
});

test('ciStatus: passed', async (t) => {
	t.deepEqual(await classify(t, { checkRuns: [checkRun('a', 'success'), checkRun('b', 'skipped')] }), { kind: 'passed' }, 'every check run a success, or skipped');
	t.deepEqual(await classify(t, { statuses: [{ context: 'ci/x', state: 'success' }] }), { kind: 'passed' }, 'only a successful commit status');
	t.deepEqual(await classify(t, {
		checkRuns: [checkRun('a', 'success', { app: { slug: 'github-actions' } })],
		runs: [{ id: 7, jobs: [job('a', [{ name: 'test', conclusion: 'success' }, { name: 'optional', conclusion: 'skipped' }])] }],
	}), { kind: 'passed' }, 'a GitHub Actions job whose steps all passed or were skipped');
	t.deepEqual(await classify(t, {
		checkRuns: [checkRun('a', 'success', { app: { slug: 'github-actions' } })],
		runs: [{ id: 7, jobs: [job('a', [])] }, { id: 8, jobs: [] }],
	}), { kind: 'passed' }, 'a job without steps, and a run without jobs');
	t.deepEqual(await classify(t, {
		checkRuns: [checkRun('a', 'success', { app: { slug: 'github-actions' } })],
		runs: [{ id: 7, jobs: [{ name: 'a', check_run_url: 'https://api.github.com/repos/o/r/check-runs/a' }] }], // eslint-disable-line camelcase
	}), { kind: 'passed' }, 'a job without a list of steps');
});

test('ciStatus: failed', async (t) => {
	for (const conclusion of ['failure', 'timed_out', 'cancelled', 'action_required', 'stale', 'neutral', 'startup_failure']) {
		t.deepEqual(await classify(t, { checkRuns: [checkRun('a', 'success'), checkRun('b`x', conclusion)] }), { kind: 'failed', failures: [`\`\`b\`x\`\`: ${conclusion}`], files: [] }, `a check run that concluded \`${conclusion}\`, named inertly`); // eslint-disable-line no-await-in-loop
	}
	t.deepEqual(await classify(t, { checkRuns: [checkRun('a', null)] }), { kind: 'failed', failures: ['`a`: no conclusion'], files: [] }, 'a completed check run without a conclusion');
	t.deepEqual(await classify(t, {
		checkRuns: [checkRun('a', 'success')],
		runs: [{
			id: 7, jobs: [], name: 'CI', conclusion: 'failure',
		}, {
			id: 8, jobs: [], name: 'Lint', conclusion: 'skipped',
		}],
	}), { kind: 'failed', failures: ['`CI`: failure'], files: [] }, 'a workflow run that failed, though every check run listed passed (eg, one that `latest` left out)');
	t.deepEqual(await classify(t, {
		checkRuns: [checkRun('a', 'success')],
		runs: [{
			id: 7, jobs: [], name: null, conclusion: null,
		}, {
			id: 8, jobs: [], name: '', conclusion: 'action_required',
		}],
	}), { kind: 'failed', failures: ['`workflow run 7`: no conclusion', '`workflow run 8`: action_required'], files: [] }, 'a completed workflow run without a conclusion, or that needs approval, named by its ID when it has no name');
	for (const state of ['error', 'failure']) {
		t.deepEqual(await classify(t, { statuses: [{ context: 'ci/x', state }] }), { kind: 'failed', failures: [`\`ci/x\`: ${state}`], files: [] }, `a commit status that is \`${state}\``); // eslint-disable-line no-await-in-loop
	}
	t.deepEqual(await classify(t, {
		checkRuns: [checkRun('a', 'failure'), checkRun('b', null, { status: 'in_progress' })],
		statuses: [{ context: 'ci/x', state: 'pending' }],
	}), { kind: 'failed', failures: ['`a`: failure'], files: [] }, 'a failure, even with others still pending');
});

test('ciStatus: check suites', async (t) => {
	const runs = [checkRun('a', 'success')];
	for (const status of ['requested', 'queued', 'in_progress', 'waiting', 'pending']) {
		t.deepEqual(await classify(t, { checkRuns: runs, checkSuites: [suite(1, null, { status, latest_check_runs_count: 0 })] }), { kind: 'pending' }, `every check run passed, but a check suite is \`${status}\` (eg, an app that hasn’t made its check runs yet), so it’s pending`); // eslint-disable-line no-await-in-loop, camelcase
	}
	for (const conclusion of ['failure', 'timed_out', 'cancelled', 'action_required', 'stale', 'startup_failure', 'neutral']) {
		t.deepEqual(await classify(t, { checkRuns: runs, checkSuites: [suite(1, 'success'), suite(2, conclusion)] }), { kind: 'failed', failures: [`check suite 2 (\`CI app\`): ${conclusion}`], files: [] }, `a completed check suite with check runs that concluded \`${conclusion}\` fails`); // eslint-disable-line no-await-in-loop
	}
	t.deepEqual(await classify(t, { checkRuns: runs, checkSuites: [suite(3, null, { app: null })] }), { kind: 'failed', failures: ['check suite 3: no conclusion'], files: [] }, 'as does one with check runs and no conclusion, named by its ID alone without an app');
	t.deepEqual(await classify(t, { checkRuns: runs, checkSuites: [suite(4, 'failure', { latest_check_runs_count: 0 })] }), { kind: 'failed', failures: ['check suite 4 (`CI app`): failure'], files: [] }, 'and an empty one that failed'); // eslint-disable-line camelcase
	t.deepEqual(await classify(t, {
		checkRuns: runs,
		checkSuites: [
			suite(5, 'neutral', { latest_check_runs_count: 0 }), // eslint-disable-line camelcase
			suite(6, null, { latest_check_runs_count: 0 }), // eslint-disable-line camelcase
			suite(7, 'success'),
			suite(8, 'skipped'),
		],
	}), { kind: 'passed' }, 'an empty completed suite that’s `neutral` or has no conclusion (an app that never reports on the commit) is ignored; success and skipped pass');
	t.deepEqual(await classify(t, { checkRuns: runs, checkSuites: [suite(9, 'neutral', { latest_check_runs_count: void undefined })] }), { kind: 'failed', failures: ['check suite 9 (`CI app`): neutral'], files: [] }, 'a `neutral` suite not known to be empty is not'); // eslint-disable-line camelcase
	t.deepEqual(await classify(t, { checkSuites: [suite(10, null, { status: 'queued', latest_check_runs_count: 0 })] }), { kind: 'pending' }, 'an unfinished suite alone is pending'); // eslint-disable-line camelcase

	const longAgo = '2026-01-01T00:00:00Z';
	const justNow = new Date(Date.now() - (60 * 1000)).toISOString();
	/** @type {(id: number, name: string, createdAt: string) => Record<string, unknown>} */
	const stuck = (id, name, createdAt) => suite(id, null, {
		status: 'queued', latest_check_runs_count: 0, created_at: createdAt, app: { name }, // eslint-disable-line camelcase
	});
	const stuckSuites = [stuck(11, 'Codecov', longAgo), stuck(12, 'Renovate', longAgo), suite(13, 'success', { created_at: longAgo })]; // eslint-disable-line camelcase
	const quiet = [checkRun('a', 'success', { completed_at: longAgo })]; // eslint-disable-line camelcase
	t.deepEqual(await classify(t, { checkRuns: quiet, checkSuites: stuckSuites }), { kind: 'passed' }, 'unfinished suites with no check runs (eg, the ones Codecov and Renovate leave queued forever) are ignored once CI has been quiet long enough');
	t.deepEqual(await classify(t, { checkRuns: [checkRun('a', 'success', { completed_at: justNow })], checkSuites: stuckSuites }), { kind: 'pending' }, 'but not while a check run finished only just now, since an app may make its check runs only once other CI is done'); // eslint-disable-line camelcase
	t.deepEqual(await classify(t, {
		checkRuns: quiet,
		runs: [{ id: 1, jobs: [], updated_at: justNow }], // eslint-disable-line camelcase
		checkSuites: stuckSuites,
	}), { kind: 'pending' }, 'nor while a workflow run changed only just now');
	t.deepEqual(await classify(t, {
		checkRuns: quiet,
		statuses: [{ context: 's', state: 'success', updated_at: justNow }], // eslint-disable-line camelcase
		checkSuites: stuckSuites,
	}), { kind: 'pending' }, 'nor while a status changed only just now');
	t.deepEqual(await classify(t, { checkRuns: quiet, checkSuites: [...stuckSuites, stuck(14, 'New app', justNow)] }), { kind: 'pending' }, 'nor while such a suite was created only just now');
	t.deepEqual(await classify(t, { checkRuns: quiet, checkSuites: [suite(15, null, { status: 'in_progress', latest_check_runs_count: 2, created_at: longAgo })] }), { kind: 'pending' }, 'an unfinished suite with check runs is pending, however long ago it was created'); // eslint-disable-line camelcase
	t.deepEqual(await classify(t, { checkRuns: [checkRun('a', 'failure', { completed_at: longAgo })], checkSuites: stuckSuites }), { kind: 'failed', failures: ['`a`: failure'], files: [] }, 'and a failure still fails'); // eslint-disable-line camelcase
});

test('unreportedPending', (t) => {
	const now = Date.parse('2026-01-01T01:00:00Z');
	const quietFor = (/** @type {number} */ minutes) => new Date(now - (minutes * 60 * 1000)).toISOString();
	t.equal(quietMinutes, 15, 'CI must be quiet for 15 minutes');
	t.equal(unreportedPending([], [quietFor(0)], now), false, 'with no such suites, nothing is pending');
	t.equal(unreportedPending([quietFor(60)], [quietFor(quietMinutes)], now), false, `quiet for exactly ${quietMinutes} minutes: not pending`);
	t.equal(unreportedPending([quietFor(60)], [quietFor(quietMinutes - 1)], now), true, 'quiet for less: pending');
	t.equal(unreportedPending([quietFor(quietMinutes - 1)], [quietFor(60)], now), true, 'a suite created more recently: pending');
	t.equal(unreportedPending([null, void undefined], ['not a date'], now), true, 'with no time at all, nothing shows how long CI has been quiet: pending');
	t.equal(unreportedPending([quietFor(60), null], [null], now), false, 'times that are missing are skipped');
	t.ok(unreportedPending([new Date().toISOString()], []), 'defaults to now');
	t.end();
});

test('ciStatus: a step whose failure `continue-on-error` masks', async (t) => {
	const actions = { app: { slug: 'github-actions' } };
	// the Actions API reports a failed `continue-on-error` step as a `success`, as it does its job and check run; only the runner's `failure` annotation on the check run shows it
	t.deepEqual(await classify(t, {
		checkRuns: [
			checkRun('test', 'success', { ...actions, annotations: [{ annotation_level: 'notice', message: 'fyi' }, { annotation_level: 'failure', message: 'Process completed with exit code 1.' }] }), // eslint-disable-line camelcase
			checkRun('other', 'success', { annotations: [{ annotation_level: 'failure', message: 'not from GitHub Actions' }] }), // eslint-disable-line camelcase
		],
		runs: [{ id: 7, jobs: [job('test', [{ name: 'flaky', conclusion: 'success', status: 'completed' }])] }],
	}), { kind: 'failed', failures: ['`test`: a step failed: `Process completed with exit code 1.`'], files: [] }, 'a masked failure, which only its check run’s `failure` annotation shows, fails CI; only GitHub Actions’ check runs’ annotations count');
	t.deepEqual(await classify(t, {
		checkRuns: [checkRun('test', 'success', { ...actions, annotations: [{ annotation_level: 'failure', message: `  ${'x'.repeat(120)}\nsecond line` }, { annotation_level: 'failure', message: null }] })], // eslint-disable-line camelcase
		runs: [{ id: 7, jobs: [job('test', [])] }],
	}), { kind: 'failed', failures: [`\`test\`: a step failed: \`${'x'.repeat(99)}…\``, '`test`: a step failed: ``'], files: [] }, 'each one, by the first line of its message, shortened');
	const counted = setup(t, {
		ci: {
			h1: {
				checkRuns: [
					checkRun('a', 'success', { ...actions, output: void undefined }),
					checkRun('b', 'success', { ...actions, output: {} }),
					checkRun('c', 'success', actions),
				],
				runs: [{ id: 7, jobs: [job('a', []), job('b', []), job('c', [])] }],
			},
		},
	});
	t.deepEqual(await ciStatus(octokit, commit), { kind: 'passed' }, 'without annotations, it passed');
	t.notOk(counted.some((r) => r.path.includes('/annotations')), 'annotations are only read for a check run that has some');
	const paging = setup(t, {
		ci: {
			h1: {
				checkRuns: [checkRun('a', 'success', { ...actions, annotations: Array.from({ length: 150 }, (_, i) => ({ annotation_level: i === 149 ? 'failure' : 'warning', message: `m${i}` })) })], // eslint-disable-line camelcase
				runs: [{ id: 7, jobs: [job('a', [])] }],
			},
		},
	});
	t.deepEqual(await ciStatus(octokit, commit), { kind: 'failed', failures: ['`a`: a step failed: `m149`'], files: [] }, 'an annotation past the first page counts');
	t.deepEqual(paging.filter((r) => r.path.includes('/annotations')).map((r) => r.path), ['/repos/o/r/check-runs/1/annotations?per_page=100', '/repos/o/r/check-runs/1/annotations?per_page=100&page=2'], 'reading every page of them, 100 at a time');
	// should the API ever report a masked step's own failure, that counts too
	t.deepEqual(await classify(t, {
		checkRuns: [checkRun('test', 'success', actions), checkRun('other', 'success')],
		runs: [{ id: 7, jobs: [job('test', [{ name: 'flaky', conclusion: 'failure', status: 'completed' }, { name: 'after', conclusion: 'success' }])] }],
	}), { kind: 'failed', failures: ['`test`: step `flaky`: failure'], files: [] }, 'a step whose own conclusion is a failure fails CI');
	t.deepEqual(await classify(t, {
		checkRuns: [checkRun('test', 'success', actions)],
		runs: [{ id: 7, jobs: [job('test', [{ name: 'a', conclusion: 'success', outcome: 'failure' }, { name: 'b', conclusion: 'timed_out' }, { name: 'c', conclusion: 'cancelled' }])] }],
	}), { kind: 'failed', failures: ['`test`: step `a`: failure', '`test`: step `b`: timed_out', '`test`: step `c`: cancelled'], files: [] }, 'a step’s `outcome` counts too, as do timing out and being cancelled');
	t.deepEqual(await classify(t, {
		checkRuns: [checkRun('test', 'success', actions)],
		runs: [{ id: 7, jobs: [job('elsewhere', [])] }],
	}), { kind: 'failed', failures: ['`test`: its steps could not be inspected'], files: [] }, 'a GitHub Actions check run whose job can’t be found fails, since it can’t be shown to have no masked failure');
	t.deepEqual(await classify(t, {
		checkRuns: [checkRun('test', 'success')],
		runs: [{ id: 7, jobs: [job('test', [{ name: 'a', conclusion: 'failure' }])] }],
	}), { kind: 'passed' }, 'only GitHub Actions’ check runs have jobs whose steps are inspected');
});

test('ciStatus: every page', async (t) => {
	const many = Array.from({ length: 150 }, (_, i) => checkRun(`c${i}`, i === 149 ? 'failure' : 'success'));
	const requests = setup(t, {
		ci: {
			h1: {
				checkRuns: many,
				checkSuites: Array.from({ length: 120 }, (_, i) => suite(i, i === 119 ? 'failure' : 'success')),
				statuses: Array.from({ length: 130 }, (_, i) => ({ context: `s${i}`, state: i === 129 ? 'error' : 'success' })),
			},
		},
	});
	t.deepEqual(await ciStatus(octokit, commit), { kind: 'failed', failures: ['check suite 119 (`CI app`): failure', '`c149`: failure', '`s129`: error'], files: [] }, 'the last check run, check suite, and status, past the first page of each, are read');
	t.deepEqual(requests.map((r) => r.path.replace(/\?.*$/, '')), [
		'/repos/o/r/actions/runs',
		'/repos/o/r/commits/h1/check-runs',
		'/repos/o/r/commits/h1/check-runs',
		'/repos/o/r/commits/h1/check-suites',
		'/repos/o/r/commits/h1/check-suites',
		'/repos/o/r/commits/h1/status',
		'/repos/o/r/commits/h1/status',
	], 'the workflow runs on the commit, and two pages of each');
	t.ok(requests.every((r) => new URLSearchParams(r.path.split('?')[1]).get('per_page') === '100'), '100 at a time');
	t.equal(new URLSearchParams(requests[1].path.split('?')[1]).get('filter'), 'latest', 'only the latest run of each check');
	t.equal(new URLSearchParams(requests[0].path.split('?')[1]).get('head_sha'), 'h1', 'and every workflow run on the commit');

	const jobs = setup(t, {
		ci: {
			h1: {
				checkRuns: [checkRun('j149', 'success', { app: { slug: 'github-actions' } })],
				runs: [{ id: 7, jobs: Array.from({ length: 150 }, (_, i) => job(`j${i}`, [{ name: 'x', conclusion: i === 149 ? 'failure' : 'success' }])) }],
			},
		},
	});
	t.deepEqual(await ciStatus(octokit, commit), { kind: 'failed', failures: ['`j149`: step `x`: failure'], files: [] }, 'a job past the first page is inspected');
	const jobRequests = jobs.filter((r) => (/\/jobs\?/).test(r.path));
	t.equal(jobRequests.length, 2, 'reading every page of jobs');
	t.equal(new URLSearchParams(jobRequests[0].path.split('?')[1]).get('filter'), 'latest', 'of the latest attempt');
	t.equal(new URLSearchParams(jobs.find((r) => (/\/actions\/runs\?/).test(r.path))?.path.split('?')[1]).get('head_sha'), 'h1', 'of the workflow runs on the head commit');
});

test('ciStatus: the workflow files that failed', async (t) => {
	const actions = { app: { slug: 'github-actions' } };
	t.deepEqual(await classify(t, {
		checkRuns: [checkRun('a', 'success')],
		runs: [
			{ id: 1, conclusion: 'failure', path: '.github/workflows/node-pretest.yml', jobs: [] },
			{ id: 2, conclusion: 'failure', path: '.github/workflows/node-aught.yml@refs/pull/1/merge', jobs: [] },
			{ id: 3, conclusion: 'failure', path: 'dynamic/github-code-scanning/codeql', jobs: [] },
			{ id: 4, conclusion: 'failure', jobs: [] },
			{ id: 5, conclusion: 'success', path: '.github/workflows/passing.yml', jobs: [] },
			{ id: 6, conclusion: 'failure', path: '.github/workflows/node-pretest.yml', jobs: [] },
		],
	}), {
		kind: 'failed',
		failures: ['`workflow 1`: failure', '`workflow 2`: failure', '`workflow 3`: failure', '`workflow 4`: failure', '`workflow 6`: failure'],
		files: ['.github/workflows/node-pretest.yml', '.github/workflows/node-aught.yml'],
	}, 'each failed run’s workflow file, once, without the ref its path names: never a path that isn’t a workflow file’s');
	t.deepEqual(await classify(t, {
		checkRuns: [
			checkRun('engines', 'success', { ...actions, annotations: [{ annotation_level: 'failure', message: 'Process completed with exit code 1.' }] }), // eslint-disable-line camelcase
			checkRun('fine', 'success', actions),
			checkRun('lost', 'success', actions),
		],
		runs: [
			{ id: 8, path: '.github/workflows/node-pretest.yml', jobs: [job('engines', [], 8), job('fine', [], 8)] },
			{ id: 9, path: '.github/workflows/other.yml', jobs: [job('lost', [], 10)] },
		],
	}), {
		kind: 'failed',
		failures: ['`engines`: a step failed: `Process completed with exit code 1.`'],
		files: ['.github/workflows/node-pretest.yml'],
	}, 'a masked failure’s workflow file is its job’s run’s');
	t.deepEqual(await classify(t, {
		checkRuns: [checkRun('test', 'success', actions)],
		runs: [{ id: 7, path: '.github/workflows/x.yml', jobs: [job('elsewhere', [])] }],
	}), { kind: 'failed', failures: ['`test`: its steps could not be inspected'], files: [] }, 'one whose job can’t be found has no file');
	t.deepEqual(await classify(t, {
		checkRuns: [checkRun('test', 'success', actions)],
		runs: [{ id: 7, path: '.github/workflows/x.yml', jobs: [job('test', [{ name: 'a', conclusion: 'failure' }], 99)] }],
	}), { kind: 'failed', failures: ['`test`: step `a`: failure'], files: [] }, 'nor one whose job’s run isn’t listed');
});

test('assess', async (t) => {
	const target = {
		owner: 'o', name: 'r', number: 1, base: 'main', head: 'h1',
	};
	const passed = { h1: { checkRuns: [checkRun('a', 'success')] } };
	/** @type {[string, Record<string, unknown>[], Awaited<ReturnType<typeof assess>>][]} */
	const cases = [
		['one commit, on the base’s tip', [prCommit('h1', { parents: ['tip'] })], { kind: 'ready' }],
		['one commit, on an older base commit', [prCommit('h1', { parents: ['old'] })], { kind: 'behind' }],
		['one merge commit', [prCommit('h1', { parents: ['tip', 'other'] })], { kind: 'behind' }],
		['two commits, the first on the base’s tip', [prCommit('h0', { parents: ['tip'] }), prCommit('h1', { parents: ['h0'] })], { kind: 'behind' }],
	];
	for (const [label, commits, expected] of cases) {
		const requests = setup(t, {
			refs: { 'o/r': 'tip' }, commits: { 'o/r#1': commits }, ci: passed,
		});
		t.deepEqual(await assess(octokit, target, botUser), expected, `${label}: ${expected.kind}`); // eslint-disable-line no-await-in-loop
		if (expected.kind === 'behind') {
			t.notOk(requests.some((r) => r.path.includes('check-runs')), `${label}: CI isn’t even read, since it needs updating first`);
		}
	}
	const several = setup(t, { refs: { 'o/r': 'tip' }, commits: { 'o/r#1': [prCommit('h0', { parents: ['tip'] }), prCommit('h1', { parents: ['h0'] })] } });
	await assess(octokit, target, botUser);
	t.notOk(several.some((r) => r.path.includes('/git/ref/')), 'with more than one commit, the base’s tip isn’t even read');
	const tipRead = setup(t, { refs: { 'o/r': 'tip' }, commits: { 'o/r#1': [prCommit('h1', { parents: ['tip'] })] }, ci: passed });
	await assess(octokit, target, botUser);
	t.ok(tipRead.some((r) => r.path === '/repos/o/r/git/ref/heads%2Fmain'), 'reads the base branch’s current tip');
	setup(t, { refs: { 'o/r': 'tip' }, commits: { 'o/r#1': [prCommit('h1', { parents: ['tip'] })] }, ci: { h1: { checkRuns: [checkRun('a', 'failure')] } } });
	t.deepEqual(await assess(octokit, target, botUser), { kind: 'failed', failures: ['`a`: failure'], files: [] }, 'one whose CI failed is not ready');
	t.equal(behindReason('main'), 'it needs updating: the App’s PRs must be one commit, on `main`’s tip, and the App rebases them onto it every 10 minutes, so run `/merge` again after that (not GitHub’s “Update branch”, whose commit isn’t the App’s, so `/merge` would never take it)', 'a PR that needs updating must be updated by the App, since `/merge` takes only its commits');
});

test('assess: only the App’s bot’s own commits', async (t) => {
	const target = {
		owner: 'o', name: 'r', number: 1, base: 'main', head: 'h1',
	};
	/** @type {Awaited<ReturnType<typeof assess>>} */
	const someoneElse = { kind: 'refused', reason: 'it has commits by someone else; review and merge it yourself' };
	/** @type {[string, Record<string, unknown>[], Awaited<ReturnType<typeof assess>>][]} */
	const cases = [
		['a foreign author', [prCommit('h0', { author: 'mallory' }), prCommit('h1')], someoneElse],
		['a foreign committer', [prCommit('h0'), prCommit('h1', { committer: 'mallory' })], someoneElse],
		['a foreign author whose email is the bot’s', [prCommit('h1', { author: 'mallory', authorEmail: botEmail })], someoneElse],
		['an unlinked author with another email', [prCommit('h1', { author: null, authorEmail: 'mallory@example.com' })], someoneElse],
		['an unlinked committer with another email', [prCommit('h1', { committer: null, committerEmail: 'mallory@example.com' })], someoneElse],
		['an unlinked author without an email', [prCommit('h1', { author: null, authorEmail: null })], someoneElse],
		['an unlinked author and committer, with the bot’s noreply email in any case', [prCommit('h1', { author: null, committer: null, authorEmail: botEmail.toUpperCase() })], { kind: 'ready' }],
		['the bot’s login in another case', [prCommit('h1', { author: 'Fleet-Bot[bot]' })], { kind: 'ready' }],
		['a last commit that isn’t the head', [prCommit('h1'), prCommit('h2')], { kind: 'refused', reason: 'it changed while it was being checked; run `/merge` again' }],
		['no commits at all', [], { kind: 'refused', reason: 'it changed while it was being checked; run `/merge` again' }],
	];
	for (const [label, commits, expected] of cases) {
		const requests = setup(t, { commits: { 'o/r#1': commits }, ci: { h1: { checkRuns: [checkRun('a', 'success')] } } });
		t.deepEqual(await assess(octokit, target, botUser), expected, `${label}: ${expected.kind}`); // eslint-disable-line no-await-in-loop
		if (expected.kind === 'refused') {
			t.notOk(requests.some((r) => (/\/(?:compare|check-runs)\b/).test(r.path)), `${label}: nothing else is read`);
		}
	}
	const unlinked = setup(t, { commits: { 'o/r#1': [prCommit('h0', { author: null, committer: null }), prCommit('h1', { author: null })] }, ci: { h1: { checkRuns: [checkRun('a', 'success')] } } });
	t.deepEqual(await assess(octokit, target, botUser), { kind: 'behind' }, 'commits GitHub doesn’t link to a user, whose emails are the bot’s noreply email, are its own: so two of them aren’t refused, but need updating into one');
	t.deepEqual(unlinked.filter((r) => r.path.startsWith('/users/')).map((r) => r.path), ['/users/fleet-bot%5Bbot%5D'], 'looking up the bot’s user ID only once');
	const linked = setup(t, { commits: { 'o/r#1': [prCommit('h1')] }, ci: { h1: { checkRuns: [checkRun('a', 'success')] } } });
	await assess(octokit, target, botUser);
	t.deepEqual(linked.filter((r) => r.path.startsWith('/users/')), [], 'and only when a commit isn’t linked to a user');
	t.deepEqual(linked.filter((r) => r.path.includes('/pulls/1/commits')).map((r) => new URLSearchParams(r.path.split('?')[1]).get('per_page')), ['100'], 'listing the PR’s commits 100 at a time');

	const many = Array.from({ length: 300 }, (_, i) => prCommit(i === 299 ? 'h1' : `c${i}`));
	for (const [count, expected] of /** @type {[number, string][]} */ ([[249, 'behind'], [250, 'refused'], [300, 'refused']])) { // eslint-disable-line no-extra-parens
		const requests = setup(t, { commits: { 'o/r#1': [...many.slice(0, count - 1), prCommit('h1')] }, ci: { h1: { checkRuns: [checkRun('a', 'success')] } } });
		const result = await assess(octokit, target, botUser); // eslint-disable-line no-await-in-loop
		t.equal(result.kind, expected, `${count} commits: ${expected}`);
		if (result.kind === 'refused') {
			t.equal(result.reason, 'it has at least 250 commits, more than GitHub lists, so they can’t all be checked to be the App’s own; review and merge it yourself', `${count} commits: since GitHub lists only 250, they can’t all be checked`);
		}
		t.equal(requests.filter((r) => r.path.includes('/pulls/1/commits')).length, 3, `${count} commits: reading every page GitHub lists`);
	}
});

test('fastForward', async (t) => {
	const target = {
		owner: 'o', name: 'r', number: 1, base: 'main', head: 'h1',
	};
	const requests = setup(t, {});
	await fastForward(octokit, target);
	t.deepEqual(requests.map((r) => [`${r.method} ${r.path}`, r.body]), [['PATCH /repos/o/r/git/refs/heads%2Fmain', { sha: 'h1', force: false }]], 'updates the base branch to the head, never forced');

	setup(t, { refUpdates: { 'o/r': { status: 422, body: { message: 'Protected branch update failed for refs/heads/main: secret rule name' } } } });
	try {
		await fastForward(octokit, target);
		t.fail('should have thrown');
	} catch (error) {
		t.equal(messageOf(error), 'GitHub refused to fast-forward `main` to it (HTTP 422), eg because of a branch protection rule', 'a refusal says only its HTTP status, not its message');
	}
	const failing = /** @type {import('../../../fleet/lib/app.mjs').Octokit} */ (/** @type {unknown} */ ({ rest: { git: { async updateRef() { throw new Error('offline'); } } } })); // eslint-disable-line no-extra-parens
	await fastForward(failing, target).then(() => t.fail('should have thrown'), (error) => {
		t.equal(messageOf(error), 'GitHub refused to fast-forward `main` to it, eg because of a branch protection rule', 'or nothing, without one');
	});
});

test('candidatePRs', async (t) => {
	const bot = 'fleet-bot[bot]';
	/** @type {(number: number, branch: string, extra?: { repo?: string, user?: string | null }) => Record<string, unknown>} */
	const pr = (number, branch, { repo = 'o/r', user = bot } = {}) => ({
		number,
		head: { ref: branch, sha: `s${number}`, repo: { full_name: repo, owner: { login: repo.split('/')[0] } } }, // eslint-disable-line camelcase
		base: { ref: 'main' },
		user: user === null ? null : { login: user },
	});
	const requests = setup(t, {
		openPulls: {
			'o/r': [
				pr(5, relockBranch),
				pr(3, fixBranch, { user: 'Fleet-Bot[bot]' }),
				pr(4, fixBranch, { user: 'mallory' }),
				pr(6, fixBranch, { user: null }),
				pr(7, fixBranch, { repo: 'o/fork-of-something' }),
				pr(8, 'other'),
			],
		},
	});
	const found = await candidatePRs(octokit, { owner: 'o', name: 'r', repository: 'O/R' }, bot);
	t.deepEqual(found.map((p) => p.number), [3, 5], 'only the bot’s, from its own branches in the repository itself, in order');
	t.deepEqual(requests.map((r) => Object.fromEntries(new URLSearchParams(r.path.split('?')[1]))), botBranches.map((branch) => ({ head: `o:${branch}`, state: 'open', per_page: '100' })), 'listing only the open PRs from each of the bot’s branches'); // eslint-disable-line camelcase

	setup(t, { openPulls: { 'o/r': [{ ...pr(9, fixBranch), head: { ref: fixBranch, sha: 's9', repo: null } }] } });
	t.deepEqual(await candidatePRs(octokit, { owner: 'o', name: 'r', repository: 'o/r' }, bot), [], 'not one whose head repository is gone');
});

test('repoOctokit and queueOctokit', async (t) => {
	const auth = appAuth('1', privateKey());
	const requests = setup(t, {}, {});
	const { stdout } = await captureStdout(() => repoOctokit(auth, { installationId: 3, name: 'r', private: false }, readPermissions));
	t.deepEqual(requests.map((r) => r.body), [{ repositories: ['r'], permissions: readPermissions }], 'a token for only that repository, with only those permissions');
	t.match(stdout, /^::add-mask::ghs_installation_3$/m, 'masked');

	setup(t, {}, { deniedPermissions: ['checks'] });
	await repoOctokit(appAuth('1', privateKey()), { installationId: 3, name: 'r', private: true }, readPermissions).then(() => t.fail('should have thrown'), (error) => {
		t.equal(messageOf(error), 'the fleet GitHub App could not get a token for it (HTTP 422): the App needs the “Contents: Read-only”, “Pull requests: Read-only”, “Checks: Read-only”, “Actions: Read-only”, “Commit statuses: Read-only” repository permissions, approved by its installation', 'without them, says which permissions it needs');
	});
	setup(t, {}, { deniedPermissions: ['workflows'] });
	await repoOctokit(appAuth('1', privateKey()), { installationId: 3, name: 'r', private: false }, writePermissions).then(() => t.fail('should have thrown'), (error) => {
		t.equal(messageOf(error), 'the fleet GitHub App could not get a token for it (HTTP 422): the App needs the “Contents: Read and write”, “Workflows: Read and write” repository permissions, approved by its installation', 'including to merge');
	});
	await repoOctokit(appAuth('1', 'not a key'), { installationId: 3, name: 'r', private: false }, writePermissions).then(() => t.fail('should have thrown'), (error) => {
		t.match(messageOf(error), /^the fleet GitHub App could not get a token for it: /, 'even without an HTTP status');
	});

	const queueRequests = setup(t, {}, { repoInstallations: { 'o/actions': 12 } });
	await captureStdout(() => queueOctokit(auth, 'o', 'actions'));
	t.deepEqual(queueRequests.map((r) => [`${r.method} ${r.path}`, r.body]), [
		['GET /repos/o/actions/installation', null],
		['POST /app/installations/12/access_tokens', { repositories: ['actions'], permissions: { actions_variables: 'write' } }], // eslint-disable-line camelcase
	], 'the queue’s token is for only the repository running this, and can only read and write its Actions variables');
	setup(t, {}, { deniedPermissions: ['actions_variables'] });
	await queueOctokit(appAuth('1', privateKey()), 'o', 'actions').then(() => t.fail('should have thrown'), (error) => {
		t.equal(messageOf(error), 'the fleet GitHub App could not get a token to read and write Actions variables in `o/actions` (HTTP 422): the App needs the “Variables: Read and write” repository permission, for the merge queue (the `FLEET_MERGE_QUEUE` variable), and must be installed on `o/actions`. After that permission is added to the App, its installation on `o` must approve it (from the account’s settings, under “Applications”, or from GitHub’s email about it) before the App can use it.', 'without that permission, says so');
	});
});

test('readQueue and writeQueue', async (t) => {
	const entry = {
		repository: 'o/r', number: 1, headSha: 'h', base: 'main', commentId: 2, issueNumber: 3, queuedAt: '2026-01-01T00:00:00.000Z', private: false,
	};
	setup(t, {});
	t.deepEqual(await readQueue(octokit, 'o', 'actions'), { entries: [], exists: false }, 'no variable: an empty queue');
	setup(t, { queue: JSON.stringify([entry, { ...entry, number: 'x' }, null, 'x', { ...entry, private: 'no' }, { ...entry, base: void undefined }, { ...entry, queuedAt: 'not a time' }]) });
	t.deepEqual(await readQueue(octokit, 'o', 'actions'), { entries: [entry], exists: true }, 'only well-formed entries are kept');
	setup(t, { queue: '{}' });
	t.deepEqual(await readQueue(octokit, 'o', 'actions'), { entries: [], exists: true }, 'something other than a list is empty');
	setup(t, { queue: 'nope' });
	const { result, stdout } = await captureStdout(() => readQueue(octokit, 'o', 'actions'));
	t.deepEqual(result, { entries: [], exists: true }, 'nor is invalid JSON');
	t.match(stdout, /^::warning::the `FLEET_MERGE_QUEUE` variable is not valid JSON, so the merge queue starts over empty$/m, 'which warns');
	setup(t, { queueError: { status: 500 } });
	await readQueue(octokit, 'o', 'actions').then(() => t.fail('should have thrown'), (error) => {
		t.equal(statusOf(error), 500, 'any other error is thrown');
	});

	const created = setup(t, {});
	await writeQueue(octokit, { owner: 'o', repo: 'actions', exists: false }, [entry]);
	t.deepEqual(created.map((r) => [`${r.method} ${r.path}`, r.body]), [['POST /repos/o/actions/actions/variables', { name: 'FLEET_MERGE_QUEUE', value: JSON.stringify([entry]) }]], 'a new variable is created');
	const updated = setup(t, {});
	await writeQueue(octokit, { owner: 'o', repo: 'actions', exists: true }, []);
	t.deepEqual(updated.map((r) => [`${r.method} ${r.path}`, r.body]), [['PATCH /repos/o/actions/actions/variables/FLEET_MERGE_QUEUE', { value: '[]' }]], 'an existing one is updated');
});

test('fits, entryKey, messageOf, statusOf', (t) => {
	const entry = {
		repository: 'o/r', number: 1, headSha: 'h', base: 'main', commentId: 2, issueNumber: 3, queuedAt: '', private: false,
	};
	t.ok(fits([entry]), 'one entry fits');
	t.ok(maxQueueBytes < 48 * 1024, 'the limit is within GitHub’s 48 KB for a variable');
	const one = Buffer.byteLength(JSON.stringify([entry]));
	t.notOk(fits(Array.from({ length: Math.ceil(maxQueueBytes / (one - 2)) + 1 }, () => entry)), 'too many don’t');
	t.equal(entryKey({ repository: 'O/R', number: 4 }), 'o/r#4', 'a PR’s key ignores case');
	t.equal(messageOf(new Error('x')), 'x', 'an error’s message');
	t.equal(messageOf('y'), 'y', 'anything else, as a string');
	t.equal(statusOf({ status: 404 }), 404, 'an HTTP status');
	t.equal(statusOf({ status: '404' }), undefined, 'only a number');
	t.equal(statusOf(null), undefined, 'nothing');
	t.end();
});
