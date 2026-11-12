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
	assessmentDetails,
	ciStatus,
	entryKey,
	failureDetails,
	fastForward,
	fits,
	maxQueueBytes,
	messageOf,
	noneLeft,
	optionalNote,
	queueOctokit,
	readPermissions,
	readQueue,
	repoOctokit,
	statusOf,
	writePermissions,
	writeQueue,
} from '../../../fleet/lib/merge.mjs';
import { optionalFailures } from '../../../fleet/lib/ci.mjs';
import { quietMinutes, unreportedPending } from '../../../fleet/lib/merge-guards.mjs';
import {
	botEmail,
	botUser,
	mockMerge,
	prCommit,
} from '../commands/helpers/merge.mjs';
import { mockGitHub, privateKey } from './helpers/github.mjs';

/** @import { Recorded, Scenario } from './helpers/github.mjs' */
/** @import { MergeScenario, CI } from '../commands/helpers/merge.mjs' */
/** @import { Test } from 'tape' */
/** @import { Octokit } from '../../../fleet/lib/app.mjs' */
/** @import { Failed } from '../../../fleet/lib/ci.mjs' */

/** @type {(name: string, ...messages: string[]) => Failed} */
function f(name, ...messages) {
	return { name, messages };
}

/** @type {() => void} */
let current = () => {};

// each scenario replaces the one before it, even within a test
/** @type {(t: Test, merge: MergeScenario, github?: Scenario) => Recorded[]} */
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
	process.stdout.write = /** @type {typeof write} */ (function (/** @type {string} */ chunk) {
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
		id: name.length,
		name,
		status: 'completed',
		conclusion,
		url: `https://api.github.com/repos/o/r/check-runs/${name}`,
		app: { slug: 'some-ci' },
		...extra,
	};
}

/** @type {(name: string, steps: Record<string, unknown>[], runId?: number) => Record<string, unknown>} */
function job(name, steps, runId = 7) {
	return {
		name,
		check_run_url: `https://api.github.com/repos/o/r/check-runs/${name}`, // eslint-disable-line camelcase
		steps,
		run_id: runId, // eslint-disable-line camelcase
	};
}

/** @type {(id: number, conclusion: string | null, extra?: Record<string, unknown>) => Record<string, unknown>} */
function suite(id, conclusion, extra = {}) {
	return {
		id,
		status: 'completed',
		conclusion,
		latest_check_runs_count: 1, // eslint-disable-line camelcase
		app: { name: 'CI app' },
		...extra,
	};
}

/** @type {(t: Test, ci: CI) => Promise<Awaited<ReturnType<typeof ciStatus>>>} */
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
	await ['requested', 'queued', 'pending', 'waiting', 'in_progress'].reduce(
		async (previous, status) => {
			await previous;
			t.deepEqual(await classify(t, { checkRuns: [checkRun('a', 'success')], runs: [{ id: 7, jobs: [], status, conclusion: null }] }), { kind: 'pending' }, `every check run so far passed, but a workflow run on the commit is \`${status}\`, so jobs waiting on others (which have no check runs yet) may still fail`);
		},
		Promise.resolve(),
	);
});

test('ciStatus: passed', async (t) => {
	t.deepEqual(await classify(t, { checkRuns: [checkRun('a', 'success'), checkRun('b', 'skipped')] }), { kind: 'passed' }, 'every check run a success, or skipped');
	t.deepEqual(await classify(t, { statuses: [{ context: 'ci/x', state: 'success' }] }), { kind: 'passed' }, 'only a successful commit status');
	t.deepEqual(
		await classify(t, {
			checkRuns: [checkRun('a', 'success', { app: { slug: 'github-actions' } })],
			runs: [{ id: 7, jobs: [job('a', [{ name: 'test', conclusion: 'success' }, { name: 'optional', conclusion: 'skipped' }])] }],
		}),
		{ kind: 'passed' },
		'a GitHub Actions job whose steps all passed or were skipped',
	);
	t.deepEqual(
		await classify(t, {
			checkRuns: [checkRun('a', 'success', { app: { slug: 'github-actions' } })],
			runs: [{ id: 7, jobs: [job('a', [])] }, { id: 8, jobs: [] }],
		}),
		{ kind: 'passed' },
		'a job without steps, and a run without jobs',
	);
	t.deepEqual(
		await classify(t, {
			checkRuns: [checkRun('a', 'success', { app: { slug: 'github-actions' } })],
			runs: [{ id: 7, jobs: [{ name: 'a', check_run_url: 'https://api.github.com/repos/o/r/check-runs/a' }] }], // eslint-disable-line camelcase
		}),
		{ kind: 'passed' },
		'a job without a list of steps',
	);
});

test('ciStatus: failed', async (t) => {
	await ['failure', 'timed_out', 'cancelled', 'action_required', 'stale', 'neutral', 'startup_failure'].reduce(
		async (previous, conclusion) => {
			await previous;
			t.deepEqual(await classify(t, { checkRuns: [checkRun('a', 'success'), checkRun('b`x', conclusion)] }), { kind: 'failed', failures: [f('b`x', conclusion)], files: [] }, `a check run that concluded \`${conclusion}\`, named as it is`);
		},
		Promise.resolve(),
	);
	t.deepEqual(await classify(t, { checkRuns: [checkRun('a', null)] }), { kind: 'failed', failures: [f('a', 'no conclusion')], files: [] }, 'a completed check run without a conclusion');
	t.deepEqual(
		await classify(t, {
			checkRuns: [checkRun('a', 'success')],
			runs: [
				{
					id: 7,
					jobs: [],
					name: 'CI',
					conclusion: 'failure',
				},
				{
					id: 8,
					jobs: [],
					name: 'Lint',
					conclusion: 'skipped',
				},
			],
		}),
		{ kind: 'failed', failures: [f('CI', 'failure')], files: [] },
		'a workflow run that failed, though every check run listed passed (eg, one that `latest` left out)',
	);
	t.deepEqual(
		await classify(t, {
			checkRuns: [checkRun('a', 'success')],
			runs: [
				{
					id: 7,
					jobs: [],
					name: null,
					conclusion: null,
				},
				{
					id: 8,
					jobs: [],
					name: '',
					conclusion: 'action_required',
				},
			],
		}),
		{ kind: 'failed', failures: [f('workflow run 7', 'no conclusion'), f('workflow run 8', 'action_required')], files: [] },
		'a completed workflow run without a conclusion, or that needs approval, named by its ID when it has no name',
	);
	await ['error', 'failure'].reduce(
		async (previous, state) => {
			await previous;
			t.deepEqual(await classify(t, { statuses: [{ context: 'ci/x', state }] }), { kind: 'failed', failures: [f('ci/x', state)], files: [] }, `a commit status that is \`${state}\``);
		},
		Promise.resolve(),
	);
	t.deepEqual(
		await classify(t, {
			checkRuns: [checkRun('a', 'failure'), checkRun('b', null, { status: 'in_progress' })],
			statuses: [{ context: 'ci/x', state: 'pending' }],
		}),
		{ kind: 'failed', failures: [f('a', 'failure')], files: [] },
		'a failure, even with others still pending',
	);
});

test('ciStatus: check suites', async (t) => {
	const runs = [checkRun('a', 'success')];
	await ['requested', 'queued', 'in_progress', 'waiting', 'pending'].reduce(
		async (previous, status) => {
			await previous;
			t.deepEqual(await classify(t, { checkRuns: runs, checkSuites: [suite(1, null, { status, latest_check_runs_count: 0 })] }), { kind: 'pending' }, `every check run passed, but a check suite is \`${status}\` (eg, an app that hasn’t made its check runs yet), so it’s pending`); // eslint-disable-line camelcase
		},
		Promise.resolve(),
	);
	await ['failure', 'timed_out', 'cancelled', 'action_required', 'stale', 'startup_failure', 'neutral'].reduce(
		async (previous, conclusion) => {
			await previous;
			t.deepEqual(await classify(t, { checkRuns: runs, checkSuites: [suite(1, 'success'), suite(2, conclusion)] }), { kind: 'failed', failures: [f('check suite 2 (CI app)', conclusion)], files: [] }, `a completed check suite with check runs that concluded \`${conclusion}\` fails`);
		},
		Promise.resolve(),
	);
	t.deepEqual(await classify(t, { checkRuns: runs, checkSuites: [suite(3, null, { app: null })] }), { kind: 'failed', failures: [f('check suite 3', 'no conclusion')], files: [] }, 'as does one with check runs and no conclusion, named by its ID alone without an app');
	t.deepEqual(await classify(t, { checkRuns: runs, checkSuites: [suite(4, 'failure', { latest_check_runs_count: 0 })] }), { kind: 'failed', failures: [f('check suite 4 (CI app)', 'failure')], files: [] }, 'and an empty one that failed'); // eslint-disable-line camelcase
	t.deepEqual(
		await classify(t, {
			checkRuns: runs,
			checkSuites: [
				suite(5, 'neutral', { latest_check_runs_count: 0 }), // eslint-disable-line camelcase
				suite(6, null, { latest_check_runs_count: 0 }), // eslint-disable-line camelcase
				suite(7, 'success'),
				suite(8, 'skipped'),
			],
		}),
		{ kind: 'passed' },
		'an empty completed suite that’s `neutral` or has no conclusion (an app that never reports on the commit) is ignored; success and skipped pass',
	);
	t.deepEqual(await classify(t, { checkRuns: runs, checkSuites: [suite(9, 'neutral', { latest_check_runs_count: void undefined })] }), { kind: 'failed', failures: [f('check suite 9 (CI app)', 'neutral')], files: [] }, 'a `neutral` suite not known to be empty is not'); // eslint-disable-line camelcase
	t.deepEqual(await classify(t, { checkSuites: [suite(10, null, { status: 'queued', latest_check_runs_count: 0 })] }), { kind: 'pending' }, 'an unfinished suite alone is pending'); // eslint-disable-line camelcase

	const longAgo = '2026-01-01T00:00:00Z';
	const justNow = new Date(Date.now() - (60 * 1000)).toISOString();
	/** @type {(id: number, name: string, createdAt: string) => Record<string, unknown>} */
	const stuck = (id, name, createdAt) => suite(id, null, {
		status: 'queued',
		latest_check_runs_count: 0, // eslint-disable-line camelcase
		created_at: createdAt, // eslint-disable-line camelcase
		app: { name },
	});
	const stuckSuites = [stuck(11, 'Codecov', longAgo), stuck(12, 'Renovate', longAgo), suite(13, 'success', { created_at: longAgo })]; // eslint-disable-line camelcase
	const quiet = [checkRun('a', 'success', { completed_at: longAgo })]; // eslint-disable-line camelcase
	t.deepEqual(await classify(t, { checkRuns: quiet, checkSuites: stuckSuites }), { kind: 'passed' }, 'unfinished suites with no check runs (eg, the ones Codecov and Renovate leave queued forever) are ignored once CI has been quiet long enough');
	t.deepEqual(await classify(t, { checkRuns: [checkRun('a', 'success', { completed_at: justNow })], checkSuites: stuckSuites }), { kind: 'pending' }, 'but not while a check run finished only just now, since an app may make its check runs only once other CI is done'); // eslint-disable-line camelcase
	t.deepEqual(
		await classify(t, {
			checkRuns: quiet,
			runs: [{ id: 1, jobs: [], updated_at: justNow }], // eslint-disable-line camelcase
			checkSuites: stuckSuites,
		}),
		{ kind: 'pending' },
		'nor while a workflow run changed only just now',
	);
	t.deepEqual(
		await classify(t, {
			checkRuns: quiet,
			statuses: [{ context: 's', state: 'success', updated_at: justNow }], // eslint-disable-line camelcase
			checkSuites: stuckSuites,
		}),
		{ kind: 'pending' },
		'nor while a status changed only just now',
	);
	t.deepEqual(await classify(t, { checkRuns: quiet, checkSuites: [...stuckSuites, stuck(14, 'New app', justNow)] }), { kind: 'pending' }, 'nor while such a suite was created only just now');
	t.deepEqual(await classify(t, { checkRuns: quiet, checkSuites: [suite(15, null, { status: 'in_progress', latest_check_runs_count: 2, created_at: longAgo })] }), { kind: 'pending' }, 'an unfinished suite with check runs is pending, however long ago it was created'); // eslint-disable-line camelcase
	t.deepEqual(await classify(t, { checkRuns: [checkRun('a', 'failure', { completed_at: longAgo })], checkSuites: stuckSuites }), { kind: 'failed', failures: [f('a', 'failure')], files: [] }, 'and a failure still fails'); // eslint-disable-line camelcase
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

test('ciStatus: a step whose failure `continue-on-error` hides', async (t) => {
	const actions = { app: { slug: 'github-actions' } };
	// the Actions API reports a failed `continue-on-error` step as a `success`, as it does its job and check run; only the runner's `failure` annotation on the check run shows it
	t.deepEqual(
		await classify(t, {
			checkRuns: [
				checkRun('test', 'success', { ...actions, annotations: [{ annotation_level: 'notice', message: 'fyi' }, { annotation_level: 'failure', message: 'Process completed with exit code 1.' }] }), // eslint-disable-line camelcase
				checkRun('other', 'success', { annotations: [{ annotation_level: 'failure', message: 'not from GitHub Actions' }] }), // eslint-disable-line camelcase
			],
			runs: [{ id: 7, jobs: [job('test', [{ name: 'flaky', conclusion: 'success', status: 'completed' }])] }],
		}),
		{ kind: 'passed', optional: [f('test', 'Process completed with exit code 1.')] },
		'a hidden failure, which only its check run’s `failure` annotation shows, never fails CI, as GitHub doesn’t count it either, but is noted; only GitHub Actions’ check runs’ annotations count',
	);
	t.deepEqual(
		await classify(t, {
			checkRuns: [checkRun('test', 'success', { ...actions, annotations: [{ annotation_level: 'failure', message: `  ${'x'.repeat(120)}\nsecond line` }, { annotation_level: 'failure', message: null }] })], // eslint-disable-line camelcase
			runs: [{ id: 7, jobs: [job('test', [])] }],
		}),
		{ kind: 'passed', optional: [f('test', `${'x'.repeat(99)}…`, '')] },
		'each one, by the first line of its message, shortened, all in its job’s one note',
	);
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
	t.deepEqual(await ciStatus(octokit, commit), { kind: 'passed' }, 'without annotations, it passed, with nothing to note');
	t.notOk(counted.some((r) => r.path.includes('/annotations')), 'annotations are only read for a check run that has some');
	const paging = setup(t, {
		ci: {
			h1: {
				checkRuns: [checkRun('a', 'success', { ...actions, annotations: Array.from({ length: 150 }, (_, i) => ({ annotation_level: i === 149 ? 'failure' : 'warning', message: `m${i}` })) })], // eslint-disable-line camelcase
				runs: [{ id: 7, jobs: [job('a', [])] }],
			},
		},
	});
	t.deepEqual(await ciStatus(octokit, commit), { kind: 'passed', optional: [f('a', 'm149')] }, 'an annotation past the first page is noted');
	t.deepEqual(paging.filter((r) => r.path.includes('/annotations')).map((r) => r.path), ['/repos/o/r/check-runs/1/annotations?per_page=100', '/repos/o/r/check-runs/1/annotations?per_page=100&page=2'], 'reading every page of them, 100 at a time');
	// should the API ever report a hidden step's own failure, that's noted too
	t.deepEqual(
		await classify(t, {
			checkRuns: [checkRun('test', 'success', actions), checkRun('other', 'success')],
			runs: [{ id: 7, jobs: [job('test', [{ name: 'flaky', conclusion: 'failure', status: 'completed' }, { name: 'after', conclusion: 'success' }])] }],
		}),
		{ kind: 'passed', optional: [f('test', 'step flaky: failure')] },
		'a step whose own conclusion is a failure, in a job that succeeded, is noted',
	);
	t.deepEqual(
		await classify(t, {
			checkRuns: [checkRun('test', 'success', actions)],
			runs: [{ id: 7, jobs: [job('test', [{ name: 'a', conclusion: 'success', outcome: 'failure' }, { name: 'b', conclusion: 'timed_out' }, { name: 'c', conclusion: 'cancelled' }])] }],
		}),
		{ kind: 'passed', optional: [f('test', 'step a: failure', 'step b: timed_out', 'step c: cancelled')] },
		'a step’s `outcome` counts too, as do timing out and being cancelled',
	);
	t.deepEqual(
		await classify(t, {
			checkRuns: [checkRun('test', 'success', { ...actions, annotations: [{ annotation_level: 'failure', message: 'boom' }] })], // eslint-disable-line camelcase
			runs: [{ id: 7, jobs: [job('elsewhere', [{ name: 'a', conclusion: 'failure' }])] }],
		}),
		{ kind: 'passed', optional: [f('test', 'boom')] },
		'a GitHub Actions check run whose job can’t be found succeeded, as GitHub says: only its annotations are noted',
	);
	t.deepEqual(
		await classify(t, {
			checkRuns: [checkRun('test', 'success')],
			runs: [{ id: 7, jobs: [job('test', [{ name: 'a', conclusion: 'failure' }])] }],
		}),
		{ kind: 'passed' },
		'only GitHub Actions’ check runs have jobs whose steps are inspected',
	);
	t.deepEqual(
		await classify(t, {
			checkRuns: [
				checkRun('test', 'success', { ...actions, annotations: [{ annotation_level: 'failure', message: 'hidden' }] }), // eslint-disable-line camelcase
				checkRun('real', 'failure'),
			],
			runs: [{ id: 7, jobs: [job('test', [])] }],
		}),
		{
			kind: 'failed',
			failures: [f('real', 'failure')],
			files: [],
			optional: [f('test', 'hidden')],
		},
		'with a real failure too, CI failed, and the hidden one is noted alongside it',
	);
	const early = setup(t, {
		ci: {
			h1: {
				checkRuns: [
					checkRun('test', 'success', { ...actions, annotations: [{ annotation_level: 'failure', message: 'hidden' }] }), // eslint-disable-line camelcase
					checkRun('real', 'failure'),
					checkRun('slow', null, { status: 'in_progress' }),
				],
				runs: [{ id: 7, jobs: [job('test', [])] }],
			},
		},
	});
	t.deepEqual(await ciStatus(octokit, commit), { kind: 'failed', failures: [f('real', 'failure')], files: [] }, 'a real failure fails CI while something’s still pending, with nothing noted yet');
	t.notOk(early.some((r) => (/\/(?:jobs|annotations)\b/).test(r.path)), 'without inspecting any job’s steps');
});

test('ciStatus: a job whose failure `continue-on-error` hides', async (t) => {
	/** @type {(id: number, conclusion: string | null, extra?: Record<string, unknown>) => Record<string, unknown>} */
	const actionsRun = (id, conclusion, extra = {}) => checkRun(`job ${id}`, conclusion, { id, app: { slug: 'github-actions' }, check_suite: { id: 500 }, ...extra }); // eslint-disable-line camelcase
	/** @type {(extra?: Record<string, unknown>) => { id: number, jobs: Record<string, unknown>[] } & Record<string, unknown>} */
	const workflowRun = (extra = {}) => ({
		id: 8,
		path: '.github/workflows/node-aught.yml',
		check_suite_id: 500, // eslint-disable-line camelcase
		jobs: [],
		...extra,
	});
	// as GitHub reports a job whose `continue-on-error` hides its failure: its job and check run failed, but its workflow run (and that run's check suite) succeeded
	t.deepEqual(
		await classify(t, {
			checkRuns: [actionsRun(1, 'failure'), actionsRun(2, 'timed_out'), actionsRun(3, 'success'), actionsRun(4, null)],
			checkSuites: [suite(500, 'success')],
			runs: [workflowRun()],
		}),
		{ kind: 'passed', optional: [f('job 1', 'failure'), f('job 2', 'timed_out'), f('job 4', 'no conclusion')] },
		'a GitHub Actions job that failed (or completed without a conclusion) in a workflow run that succeeded never fails CI, but is noted',
	);
	await [
		['failure', 'completed'],
		['startup_failure', 'completed'],
		['cancelled', 'completed'],
		[null, 'completed'],
	].reduce(
		async (previous, [conclusion, status]) => {
			await previous;
			t.deepEqual(
				await classify(t, {
					checkRuns: [actionsRun(1, 'failure')],
					runs: [workflowRun({ conclusion, status, name: 'CI' })],
				}),
				{
					kind: 'failed',
					failures: [f('CI', conclusion ?? 'no conclusion'), f('job 1', 'failure')],
					files: ['.github/workflows/node-aught.yml'],
				},
				`one whose workflow run concluded \`${conclusion}\` fails it, as a job that failed that run does`,
			);
		},
		Promise.resolve(),
	);
	t.deepEqual(
		await classify(t, {
			checkRuns: [actionsRun(1, 'failure', { app: { slug: 'some-ci' } })],
			runs: [workflowRun()],
		}),
		{ kind: 'failed', failures: [f('job 1', 'failure')], files: ['.github/workflows/node-aught.yml'] },
		'another app’s check run that failed fails it, even in a workflow run’s check suite',
	);
	t.deepEqual(
		await classify(t, {
			checkRuns: [actionsRun(1, 'failure', { check_suite: { id: 999 } }), actionsRun(2, 'failure', { check_suite: null })], // eslint-disable-line camelcase
			runs: [workflowRun()],
		}),
		{ kind: 'failed', failures: [f('job 1', 'failure'), f('job 2', 'failure')], files: [] },
		'as does a GitHub Actions one in a check suite no workflow run is of, or in none, which can’t be shown to be hidden',
	);
	const running = setup(t, {
		ci: {
			h1: {
				checkRuns: [actionsRun(1, 'failure'), checkRun('other', 'success')],
				runs: [workflowRun({ status: 'in_progress', conclusion: null })],
			},
		},
	});
	t.deepEqual(await ciStatus(octokit, commit), { kind: 'pending' }, 'one whose workflow run is still running can’t yet be told from one that fails it, so CI is pending until that run completes');
	t.notOk(running.some((r) => (/\/(?:jobs|annotations)\b/).test(r.path)), 'without inspecting any job’s steps yet');
	t.deepEqual(
		await classify(t, {
			checkRuns: [actionsRun(1, 'failure'), checkRun('real', 'failure')],
			runs: [workflowRun({ status: 'in_progress', conclusion: null })],
		}),
		{ kind: 'failed', failures: [f('real', 'failure')], files: [] },
		'but a real failure fails it meanwhile, without that one',
	);
});

test('ciStatus: each failure, and each note, once', async (t) => {
	const actions = { app: { slug: 'github-actions' } };
	/** @type {(id: number, suiteID: number, name: string, conclusion: string, annotations: string[]) => Record<string, unknown>} */
	const actionsRun = (id, suiteID, name, conclusion, annotations) => checkRun(name, conclusion, {
		...actions,
		id,
		url: `https://api.github.com/repos/o/r/check-runs/${id}`,
		check_suite: { id: suiteID }, // eslint-disable-line camelcase
		annotations: annotations.map((message) => ({ annotation_level: 'failure', message })), // eslint-disable-line camelcase
	});
	/** @type {(id: number, suiteID: number, path: string, jobs: [number, string][], conclusion?: string) => { id: number, jobs: Record<string, unknown>[] } & Record<string, unknown>} */
	const workflowRun = (id, suiteID, path, jobs, conclusion = 'success') => ({
		id,
		path,
		check_suite_id: suiteID, // eslint-disable-line camelcase
		conclusion,
		name: 'Tests',
		jobs: jobs.map(([checkRunID, name]) => ({
			name,
			check_run_url: `https://api.github.com/repos/o/r/check-runs/${checkRunID}`, // eslint-disable-line camelcase
			steps: [],
			run_id: id, // eslint-disable-line camelcase
		})),
	});
	const aught = '.github/workflows/node-aught.yml';
	// as tape-testing/tape#625 had: one run of a workflow for a `push`, and another for a `pull_request`, on the same head commit, each with the same hidden failures in the same jobs, but not quite the same messages
	t.deepEqual(
		await classify(t, {
			checkRuns: [
				actionsRun(1, 100, 'tests / non-latest - 0.9', 'success', ['Process completed with exit code 1.', 'console # time=240ms', 'should be equivalent']),
				actionsRun(2, 100, 'tests / non-latest - 8.7', 'success', ['Process completed with exit code 1.', 'should be equivalent']),
				actionsRun(3, 200, 'tests / non-latest - 0.9', 'success', ['Process completed with exit code 1.', 'console # time=180ms', 'should be equivalent']),
				actionsRun(4, 200, 'tests / non-latest - 8.7', 'success', ['Process completed with exit code 1.', 'should be equivalent']),
				actionsRun(5, 300, 'tests / non-latest - 8.7', 'success', ['Process completed with exit code 1.', 'should be equivalent']),
			],
			runs: [
				workflowRun(10, 100, aught, [[1, 'tests / non-latest - 0.9'], [2, 'tests / non-latest - 8.7']]),
				workflowRun(20, 200, `${aught}@refs/pull/625/merge`, [[3, 'tests / non-latest - 0.9'], [4, 'tests / non-latest - 8.7']]),
				workflowRun(30, 300, '.github/workflows/other.yml', [[5, 'tests / non-latest - 8.7']]),
			],
		}),
		{
			kind: 'passed',
			optional: [
				f('tests / non-latest - 0.9', 'Process completed with exit code 1.', 'console # time=240ms', 'should be equivalent', 'console # time=180ms'),
				f('tests / non-latest - 8.7', 'Process completed with exit code 1.', 'should be equivalent'),
			],
		},
		'each job’s messages once, however many runs of its workflow said them, keeping each that differs; a job that says exactly the same in another workflow file, once',
	);
	t.deepEqual(
		await classify(t, {
			checkRuns: [
				actionsRun(1, 100, 'tests / build', 'failure', []),
				actionsRun(2, 200, 'tests / build', 'failure', []),
				actionsRun(3, 300, 'tests / build', 'cancelled', []),
			],
			runs: [
				workflowRun(10, 100, aught, [], 'failure'),
				workflowRun(20, 200, aught, [], 'failure'),
				workflowRun(30, 300, aught, [], 'failure'),
			],
		}),
		{
			kind: 'failed',
			failures: [f('Tests', 'failure'), f('tests / build', 'failure', 'cancelled')],
			files: [aught],
		},
		'each thing that failed once, however many runs of its workflow had it, with each of its failures that differs',
	);
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
	t.deepEqual(await ciStatus(octokit, commit), { kind: 'failed', failures: [f('check suite 119 (CI app)', 'failure'), f('c149', 'failure'), f('s129', 'error')], files: [] }, 'the last check run, check suite, and status, past the first page of each, are read');
	t.deepEqual(
		requests.map((r) => r.path.replace(/\?.*$/, '')),
		[
			'/repos/o/r/actions/runs',
			'/repos/o/r/commits/h1/check-runs',
			'/repos/o/r/commits/h1/check-runs',
			'/repos/o/r/commits/h1/check-suites',
			'/repos/o/r/commits/h1/check-suites',
			'/repos/o/r/commits/h1/status',
			'/repos/o/r/commits/h1/status',
		],
		'the workflow runs on the commit, and two pages of each',
	);
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
	t.deepEqual(await ciStatus(octokit, commit), { kind: 'passed', optional: [f('j149', 'step x: failure')] }, 'a job past the first page is inspected');
	const jobRequests = jobs.filter((r) => (/\/jobs\?/).test(r.path));
	t.equal(jobRequests.length, 2, 'reading every page of jobs');
	t.equal(new URLSearchParams(jobRequests[0].path.split('?')[1]).get('filter'), 'latest', 'of the latest attempt');
	t.equal(new URLSearchParams(jobs.find((r) => (/\/actions\/runs\?/).test(r.path))?.path.split('?')[1]).get('head_sha'), 'h1', 'of the workflow runs on the head commit');
});

test('ciStatus: the workflow files that failed', async (t) => {
	const actions = { app: { slug: 'github-actions' } };
	t.deepEqual(
		await classify(t, {
			checkRuns: [checkRun('a', 'success')],
			runs: [
				{ id: 1, conclusion: 'failure', path: '.github/workflows/node-pretest.yml', jobs: [] },
				{ id: 2, conclusion: 'failure', path: '.github/workflows/node-aught.yml@refs/pull/1/merge', jobs: [] },
				{ id: 3, conclusion: 'failure', path: 'dynamic/github-code-scanning/codeql', jobs: [] },
				{ id: 4, conclusion: 'failure', jobs: [] },
				{ id: 5, conclusion: 'success', path: '.github/workflows/passing.yml', jobs: [] },
				{ id: 6, conclusion: 'failure', path: '.github/workflows/node-pretest.yml', jobs: [] },
			],
		}),
		{
			kind: 'failed',
			failures: [f('workflow 1', 'failure'), f('workflow 2', 'failure'), f('workflow 3', 'failure'), f('workflow 4', 'failure'), f('workflow 6', 'failure')],
			files: ['.github/workflows/node-pretest.yml', '.github/workflows/node-aught.yml'],
		},
		'each failed run’s workflow file, once, without the ref its path names: never a path that isn’t a workflow file’s',
	);
	t.deepEqual(await optionalFailures(octokit, commit), [], 'no workflow run has any failure that `continue-on-error` hides');
	setup(t, {
		ci: {
			h1: {
				checkRuns: [
					checkRun('engines', 'success', { ...actions, annotations: [{ annotation_level: 'failure', message: 'Process completed with exit code 1.' }] }), // eslint-disable-line camelcase
					checkRun('fine', 'success', actions),
					checkRun('lost', 'success', { ...actions, id: 40, annotations: [{ annotation_level: 'failure', message: 'lost' }] }), // eslint-disable-line camelcase
					checkRun('nowhere', 'success', actions),
					checkRun('optional', 'failure', { ...actions, check_suite: { id: 500 } }), // eslint-disable-line camelcase
					checkRun('unknown', 'failure', { ...actions, check_suite: { id: 501 } }), // eslint-disable-line camelcase
				],
				runs: [
					{ id: 8, path: '.github/workflows/node-pretest.yml', jobs: [job('engines', [], 8), job('fine', [], 8)] },
					{ id: 9, path: '.github/workflows/other.yml', jobs: [job('lost', [], 10), job('nowhere', [{ name: 'a', conclusion: 'failure' }], 99)] },
					{
						id: 11,
						path: '.github/workflows/node-aught.yml@refs/pull/1/merge',
						check_suite_id: 500, // eslint-disable-line camelcase
						jobs: [],
					},
					{
						id: 12,
						path: 'dynamic/github-code-scanning/codeql',
						check_suite_id: 501, // eslint-disable-line camelcase
						jobs: [],
					},
				],
			},
		},
	});
	t.deepEqual(
		await optionalFailures(octokit, commit),
		[
			{ file: '.github/workflows/node-aught.yml', job: 'optional', messages: ['failure'] },
			{ file: null, job: 'unknown', messages: ['failure'] },
			{ file: '.github/workflows/node-pretest.yml', job: 'engines', messages: ['Process completed with exit code 1.'] },
			{ file: null, job: 'lost', messages: ['lost'] },
			{ file: null, job: 'nowhere', messages: ['step a: failure'] },
		],
		'each job’s failure that `continue-on-error` hides, by job: a job’s own (its workflow file is its check suite’s run’s), then its steps’ (its job’s run’s), with no file when that’s not known, or isn’t a workflow file',
	);
});

test('ciStatus: a failed check run’s workflow file is that of the workflow run in its check suite', async (t) => {
	t.deepEqual(
		await classify(t, {
			checkRuns: [
				checkRun('engines', 'failure', { check_suite: { id: 500 } }), // eslint-disable-line camelcase
				checkRun('elsewhere', 'failure', { check_suite: { id: 999 } }), // eslint-disable-line camelcase
				checkRun('suiteless', 'failure'),
			],
			runs: [
				{
					id: 8,
					conclusion: 'success',
					path: '.github/workflows/node-pretest.yml',
					check_suite_id: 500, // eslint-disable-line camelcase
					jobs: [],
				},
			],
		}),
		{
			kind: 'failed',
			failures: [f('engines', 'failure'), f('elsewhere', 'failure'), f('suiteless', 'failure')],
			files: ['.github/workflows/node-pretest.yml'],
		},
		'a check run in a workflow run’s check suite adds that run’s file; one in a check suite no workflow run is of, or in none, adds none',
	);
});

test('assess', async (t) => {
	const target = {
		owner: 'o',
		name: 'r',
		number: 1,
		base: 'main',
		head: 'h1',
	};
	const passed = { h1: { checkRuns: [checkRun('a', 'success')] } };
	/** @type {[string, Record<string, unknown>[], Awaited<ReturnType<typeof assess>>][]} */
	const cases = [
		['one commit, on the base’s tip', [prCommit('h1', { parents: ['tip'] })], { kind: 'ready' }],
		['one commit, on an older base commit', [prCommit('h1', { parents: ['old'] })], { kind: 'behind' }],
		['one merge commit', [prCommit('h1', { parents: ['tip', 'other'] })], { kind: 'behind' }],
		['two commits, the first on the base’s tip', [prCommit('h0', { parents: ['tip'] }), prCommit('h1', { parents: ['h0'] })], { kind: 'behind' }],
	];
	await cases.reduce(
		async (previous, [label, commits, expected]) => {
			await previous;
			const requests = setup(t, {
				refs: { 'o/r': 'tip' },
				commits: { 'o/r#1': commits },
				ci: passed,
			});
			t.deepEqual(await assess(octokit, target, botUser), expected, `${label}: ${expected.kind}`);
			if (expected.kind === 'behind') {
				t.notOk(requests.some((r) => r.path.includes('check-runs')), `${label}: CI isn’t even read, since it needs updating first`);
			}
		},
		Promise.resolve(),
	);
	const several = setup(t, { refs: { 'o/r': 'tip' }, commits: { 'o/r#1': [prCommit('h0', { parents: ['tip'] }), prCommit('h1', { parents: ['h0'] })] } });
	await assess(octokit, target, botUser);
	t.notOk(several.some((r) => r.path.includes('/git/ref/')), 'with more than one commit, the base’s tip isn’t even read');
	const tipRead = setup(t, { refs: { 'o/r': 'tip' }, commits: { 'o/r#1': [prCommit('h1', { parents: ['tip'] })] }, ci: passed });
	await assess(octokit, target, botUser);
	t.ok(tipRead.some((r) => r.path === '/repos/o/r/git/ref/heads%2Fmain'), 'reads the base branch’s current tip');
	setup(t, { refs: { 'o/r': 'tip' }, commits: { 'o/r#1': [prCommit('h1', { parents: ['tip'] })] }, ci: { h1: { checkRuns: [checkRun('a', 'failure')] } } });
	t.deepEqual(await assess(octokit, target, botUser), { kind: 'failed', failures: [f('a', 'failure')], files: [] }, 'one whose CI failed is not ready');
	setup(t, {
		refs: { 'o/r': 'tip' },
		commits: { 'o/r#1': [prCommit('h1', { parents: ['tip'] })] },
		ci: {
			h1: {
				checkRuns: [checkRun('a', 'failure', { app: { slug: 'github-actions' }, check_suite: { id: 5 } })], // eslint-disable-line camelcase
				runs: [{ id: 7, check_suite_id: 5, jobs: [] }], // eslint-disable-line camelcase
			},
		},
	});
	t.deepEqual(await assess(octokit, target, botUser), { kind: 'ready', optional: [f('a', 'failure')] }, 'one whose only failure is a job’s that `continue-on-error` hides is ready, noting it');
	t.equal(optionalNote({ optional: [f('a', 'failure'), f('b', 'boom')] }), '; optional jobs failed, which doesn’t block merging (see below)', 'which a reply notes, listing them below its table');
	t.equal(optionalNote({}), '', 'saying nothing when there’s nothing to note');
	t.equal(optionalNote({ optional: [] }), '', 'even when it’s empty');
	t.equal(behindReason('main'), 'it needs updating: the App’s PRs must be one commit, on `main`’s tip, and the App rebases them onto it every 10 minutes, so run `/merge` again after that (not GitHub’s “Update branch”, whose commit isn’t the App’s, so `/merge` would never take it)', 'a PR that needs updating must be updated by the App, since `/merge` takes only its commits');
});

test('failureDetails', (t) => {
	const pr = {
		repository: 'o/r',
		number: 625,
		url: 'https://github.com/o/r/pull/625',
	};
	t.equal(
		failureDetails(pr, 'the checks that failed', [f('tests / non-latest - 0.9', 'Process completed with exit code 1.', 'should be equivalent'), f('lint', 'failure')]),
		[
			'<details><summary><code>o/r</code> <a href="https://github.com/o/r/pull/625">#625</a>: the checks that failed</summary>',
			'',
			'```',
			'tests / non-latest - 0.9',
			'  Process completed with exit code 1.',
			'  should be equivalent',
			'lint',
			'  failure',
			'```',
			'',
			'</details>',
		].join('\n'),
		'collapsed, after the PR (linked, so that its number isn’t taken for an issue’s here): each job, with each of its messages, verbatim, indented below it, in a fenced block',
	);
	const sneaky = failureDetails(pr, 'x', [f('a\n```\r\nb', 'one ```` four `', 'two\nlines\r\nthree\rfour', '</details>')]);
	const ticks = '`'.repeat(5);
	t.equal(
		sneaky.split('</summary>')[1],
		[
			'',
			'',
			ticks,
			'a ``` b',
			'  one ```` four `',
			'  two',
			'  lines',
			'  three',
			'  four',
			'  </details>',
			ticks,
			'',
			'</details>',
		].join('\n'),
		'a fence longer than any backtick run in it, so nothing can close it early; a name on one line, and every line of a message indented, so none can pass for a name; nothing else escaped',
	);
	t.equal(
		failureDetails(
			{
				repository: 'o/<r>',
				number: 1,
				url: 'https://example.com/"<a>',
			},
			'a & <b>',
			[f('j', 'm')],
		).split('\n')[0],
		'<details><summary><code>o/&#60;r&#62;</code> <a href="https://example.com/&#34;&#60;a&#62;">#1</a>: a &#38; &#60;b&#62;</summary>',
		'its summary is HTML-escaped',
	);

	const optional = [f('tests / 8.7', 'should be equivalent')];
	t.deepEqual(
		assessmentDetails(pr, {
			kind: 'failed',
			failures: [f('lint', 'failure')],
			optional,
		}),
		[failureDetails(pr, 'the checks that failed', [f('lint', 'failure')]), failureDetails(pr, 'optional jobs that failed, which don’t block merging', optional)],
		'a PR whose CI failed: what failed, then what failed that doesn’t block merging',
	);
	t.deepEqual(assessmentDetails(pr, { kind: 'ready', optional }), [failureDetails(pr, 'optional jobs that failed, which don’t block merging', optional)], 'a PR that’s ready: what failed that doesn’t block merging');
	t.deepEqual(assessmentDetails(pr, { kind: 'ready' }), [], 'nothing, when nothing failed');
	t.deepEqual(assessmentDetails(pr, { kind: 'pending' }), [], 'nor for a PR whose CI is pending');
	t.end();
});

test('assess: only the App’s bot’s own commits', async (t) => {
	const target = {
		owner: 'o',
		name: 'r',
		number: 1,
		base: 'main',
		head: 'h1',
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
	await cases.reduce(
		async (previous, [label, commits, expected]) => {
			await previous;
			const requests = setup(t, { commits: { 'o/r#1': commits }, ci: { h1: { checkRuns: [checkRun('a', 'success')] } } });
			t.deepEqual(await assess(octokit, target, botUser), expected, `${label}: ${expected.kind}`);
			if (expected.kind === 'refused') {
				t.notOk(requests.some((r) => (/\/(?:compare|check-runs)\b/).test(r.path)), `${label}: nothing else is read`);
			}
		},
		Promise.resolve(),
	);
	const unlinked = setup(t, { commits: { 'o/r#1': [prCommit('h0', { author: null, committer: null }), prCommit('h1', { author: null })] }, ci: { h1: { checkRuns: [checkRun('a', 'success')] } } });
	t.deepEqual(await assess(octokit, target, botUser), { kind: 'behind' }, 'commits GitHub doesn’t link to a user, whose emails are the bot’s noreply email, are its own: so two of them aren’t refused, but need updating into one');
	t.deepEqual(unlinked.filter((r) => r.path.startsWith('/users/')).map((r) => r.path), ['/users/fleet-bot%5Bbot%5D'], 'looking up the bot’s user ID only once');
	const linked = setup(t, { commits: { 'o/r#1': [prCommit('h1')] }, ci: { h1: { checkRuns: [checkRun('a', 'success')] } } });
	await assess(octokit, target, botUser);
	t.deepEqual(linked.filter((r) => r.path.startsWith('/users/')), [], 'and only when a commit isn’t linked to a user');
	t.deepEqual(linked.filter((r) => r.path.includes('/pulls/1/commits')).map((r) => new URLSearchParams(r.path.split('?')[1]).get('per_page')), ['100'], 'listing the PR’s commits 100 at a time');

	const many = Array.from({ length: 300 }, (_, i) => prCommit(i === 299 ? 'h1' : `c${i}`));
	await /** @type {[number, string][]} */ ([[249, 'behind'], [250, 'refused'], [300, 'refused']]).reduce(
		async (previous, [count, expected]) => {
			await previous;
			const requests = setup(t, { commits: { 'o/r#1': many.slice(0, count - 1).concat(prCommit('h1')) }, ci: { h1: { checkRuns: [checkRun('a', 'success')] } } });
			const result = await assess(octokit, target, botUser);
			t.equal(result.kind, expected, `${count} commits: ${expected}`);
			if (result.kind === 'refused') {
				t.equal(result.reason, 'it has at least 250 commits, more than GitHub lists, so they can’t all be checked to be the App’s own; review and merge it yourself', `${count} commits: since GitHub lists only 250, they can’t all be checked`);
			}
			t.equal(requests.filter((r) => r.path.includes('/pulls/1/commits')).length, 3, `${count} commits: reading every page GitHub lists`);
		},
		Promise.resolve(),
	);
});

test('fastForward', async (t) => {
	const target = {
		owner: 'o',
		name: 'r',
		number: 1,
		base: 'main',
		head: 'h1',
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
	const failing = /** @type {Octokit} */ (/** @type {unknown} */ ({ rest: { git: { async updateRef() { throw new Error('offline'); } } } }));
	await fastForward(failing, target).then(() => t.fail('should have thrown'), (error) => {
		t.equal(messageOf(error), 'GitHub refused to fast-forward `main` to it, eg because of a branch protection rule', 'or nothing, without one');
	});
});

test('fastForward: what GitHub said refusing it', async (t) => {
	const target = {
		owner: 'o',
		name: 'r',
		number: 1,
		base: 'master',
		head: 'h1',
	};
	const documentation = 'https://docs.github.com/rest/git/refs#update-a-reference';
	const fix = '; merge it yourself, or let the fleet GitHub App bypass that rule where GitHub allows that (eg, with a ruleset’s bypass list, or classic branch protection’s “Allow specified actors to bypass required pull requests”)';
	const fallback = 'GitHub refused to fast-forward `master` to it (HTTP 422), eg because of a branch protection rule';
	const classic = {
		message: 'Protected branch update failed for refs/heads/master.\n\nAt least 1 approving review is required by reviewers with write access.',
		documentation_url: documentation, // eslint-disable-line camelcase
		status: '422',
	};
	const ruleset = {
		message: 'Repository rule violations found\n\nChanges must be made through a pull request.\n\nRequired status check "tests" is expected.\n\n',
		documentation_url: documentation, // eslint-disable-line camelcase
		status: '422',
	};
	/** @type {(body: unknown, repo?: { private?: boolean }) => Promise<string>} */
	const refusal = async (body, repo) => {
		setup(t, { refUpdates: { 'o/r': { status: 422, body } } });
		return fastForward(octokit, target, repo).then(() => 'not refused', messageOf);
	};

	t.equal(
		await refusal(classic, { private: false }),
		`GitHub refused to fast-forward \`master\` to it (HTTP 422): \`Protected branch update failed for refs/heads/master. At least 1 approving review is required by reviewers with write access.\`${fix}`,
		'a public repository’s classic branch protection refusal: quoting what GitHub said, on one line, not the error’s own message (which links GitHub’s docs), and how to fix it',
	);
	t.equal(
		await refusal(ruleset, { private: false }),
		`GitHub refused to fast-forward \`master\` to it (HTTP 422): \`Repository rule violations found Changes must be made through a pull request. Required status check "tests" is expected.\`${fix}`,
		'a public repository’s ruleset refusal: naming each rule it violated',
	);
	t.equal(
		await refusal({ message: 'Update is not a fast forward', documentation_url: documentation }, { private: false }), // eslint-disable-line camelcase
		'GitHub refused to fast-forward `master` to it (HTTP 422): `Update is not a fast forward`',
		'a refusal that isn’t a rule’s: quoted, without saying to bypass a rule',
	);
	t.equal(
		await refusal({ message: '@someone `| [x](https://example.com) <b>\n|' }, { private: false }),
		'GitHub refused to fast-forward `master` to it (HTTP 422): ``@someone `\\| [x](https://example.com) <b> \\|``',
		'inert, as code: no mention, link, markup, line break, or table cell can get out of it',
	);
	t.equal(await refusal(classic, { private: true }), fallback, 'a private repository’s: only its HTTP status, since what refused it is private');
	t.equal(await refusal(classic), fallback, 'as is one not said to be public');
	t.equal(await refusal({ documentation_url: documentation }, { private: false }), fallback, 'a public repository’s without a message: only its HTTP status'); // eslint-disable-line camelcase
	t.equal(await refusal({ message: ' \n ' }, { private: false }), fallback, 'or with only whitespace');
	t.equal(await refusal({ message: 422 }, { private: false }), fallback, 'or with one that isn’t a string');
	t.equal(await refusal('Unprocessable Entity', { private: false }), fallback, 'or a body that isn’t an object');

	/** @type {(thrown: unknown) => Octokit} */
	const throwing = (thrown) => /** @type {Octokit} */ (/** @type {unknown} */ ({ rest: { git: { async updateRef() { throw thrown; } } } }));
	await fastForward(throwing(null), target, { private: false }).then(() => t.fail('should have thrown'), (error) => {
		t.equal(messageOf(error), 'GitHub refused to fast-forward `master` to it, eg because of a branch protection rule', 'nor anything thrown that isn’t an error');
	});
	await fastForward(throwing(new Error('offline')), target, { private: false }).then(() => t.fail('should have thrown'), (error) => {
		t.equal(messageOf(error), 'GitHub refused to fast-forward `master` to it, eg because of a branch protection rule', 'nor an error without a response');
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

test('noneLeft', async (t) => {
	const bot = 'fleet-bot[bot]';
	/** @type {(number: number, branch: string) => Record<string, unknown>} */
	const pr = (number, branch) => ({
		number,
		head: { ref: branch, sha: `s${number}`, repo: { full_name: 'o/r', owner: { login: 'o' } } }, // eslint-disable-line camelcase
		base: { ref: 'main' },
		user: { login: bot },
	});
	const repo = {
		owner: 'o',
		name: 'r',
		repository: 'o/r',
		private: false,
	};
	setup(t, { openPulls: { 'o/r': [pr(3, fixBranch), pr(5, relockBranch)] } });
	t.equal(await noneLeft(octokit, repo, { bot, merged: new Set([3, 5]) }), true, 'none left but those just merged, which GitHub can still list as open');
	t.equal(await noneLeft(octokit, repo, { bot, merged: new Set([3]) }), false, 'one left that wasn’t');

	/** @type {(isPrivate: boolean) => Promise<{ left: boolean, stdout: string }>} */
	const failing = async (isPrivate) => {
		const broken = /** @type {Octokit} */ (/** @type {unknown} */ ({
			rest: { pulls: { list: () => [] } },
			async paginate() {
				throw Object.assign(new Error('Server Error: o/r'), { status: 502 });
			},
		}));
		let stdout = '';
		const { write } = process.stdout;
		process.stdout.write = /** @type {typeof write} */ (function (/** @type {string} */ chunk) {
			stdout += String(chunk);
			return true;
		});
		try {
			const left = await noneLeft(broken, { ...repo, private: isPrivate }, { bot, merged: new Set() });
			return { left, stdout };
		} finally {
			process.stdout.write = write;
		}
	};
	const pub = await failing(false);
	t.equal(pub.left, false, 'a failure to list them is never none left');
	t.equal(pub.stdout, '::warning::could not list the App’s open PRs in a repository it merged one in, to tell whether that was its last (HTTP 502)\n', 'and only warns, never saying where');
	const priv = await failing(true);
	t.deepEqual(priv, { left: false, stdout: '' }, 'for a private repository, not even that');
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
	t.deepEqual(
		queueRequests.map((r) => [`${r.method} ${r.path}`, r.body]),
		[
			['GET /repos/o/actions/installation', null],
			['POST /app/installations/12/access_tokens', { repositories: ['actions'], permissions: { actions_variables: 'write' } }], // eslint-disable-line camelcase
		],
		'the queue’s token is for only the repository running this, and can only read and write its Actions variables',
	);
	setup(t, {}, { deniedPermissions: ['actions_variables'] });
	await queueOctokit(appAuth('1', privateKey()), 'o', 'actions').then(() => t.fail('should have thrown'), (error) => {
		t.equal(messageOf(error), 'the fleet GitHub App could not get a token to read and write Actions variables in `o/actions` (HTTP 422): the App needs the “Variables: Read and write” repository permission, for the merge queue (the `FLEET_MERGE_QUEUE` variable), and must be installed on `o/actions`. After that permission is added to the App, its installation on `o` must approve it (from the account’s settings, under “Applications”, or from GitHub’s email about it) before the App can use it.', 'without that permission, says so');
	});
});

test('repoOctokit and queueOctokit: GitHub failing to make a token isn’t blamed on the App’s permissions', async (t) => {
	const failing = /** @type {ReturnType<typeof appAuth>} */ (/** @type {unknown} */ (async () => {
		throw Object.assign(new Error('Server Error'), { status: 502 });
	}));
	const failed = 'GitHub failed to make one, even when asked again, which isn’t about the App’s permissions: try again later';
	await repoOctokit(failing, { installationId: 3, name: 'r', private: false }, readPermissions).then(() => t.fail('should have thrown'), (error) => {
		t.equal(messageOf(error), `the fleet GitHub App could not get a token for it (HTTP 502): ${failed}`, 'for a repository');
	});
	await queueOctokit(failing, 'o', 'actions').then(() => t.fail('should have thrown'), (error) => {
		t.equal(messageOf(error), `the fleet GitHub App could not get a token to read and write Actions variables in \`o/actions\` (HTTP 502): ${failed}`, 'for the queue');
	});
});

test('readQueue and writeQueue', async (t) => {
	const entry = {
		repository: 'o/r',
		number: 1,
		headSha: 'h',
		base: 'main',
		commentId: 2,
		issueNumber: 3,
		queuedAt: '2026-01-01T00:00:00.000Z',
		private: false,
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
		repository: 'o/r',
		number: 1,
		headSha: 'h',
		base: 'main',
		commentId: 2,
		issueNumber: 3,
		queuedAt: '',
		private: false,
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
