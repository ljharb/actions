import {
	checkSuites,
	commitStatuses,
	excerpt,
	unreportedPending,
	workflowFile,
} from './merge-guards.mjs';
import { code } from './markdown.mjs';

/** @import { Octokit } from './app.mjs' */
/** @import { Assessment } from './merge.mjs' */

const passing = new Set(['success', 'skipped']);
const failingSteps = new Set([
	'failure',
	'timed_out',
	'cancelled',
]);

/** @typedef {{ owner: string, name: string, head: string }} Commit */

/** @typedef {{ id: number, name?: string | null, path?: string | null, status: string | null, conclusion: string | null, updated_at?: string | null, check_suite_id?: number }} WorkflowRun */
/** @typedef {{ id: number, name: string, url: string, status: string, conclusion: string | null, completed_at?: string | null, check_suite?: { id: number } | null, app?: { slug?: string } | null, output?: { annotations_count?: number } }} CheckRun */
/**
 * One failure of CI on a commit: what it says, and, for a GitHub Actions workflow run's or job's, its workflow file (see `workflowFile`); for a job's, also its check run's name (`job`), which is what the same job on another commit has too; for a workflow run's own, its `conclusion` (eg, `startup_failure`, for a run that never got to any job), since that's all that tells one such failure from another.
 * @typedef {{ text: string, file: string | null, job: string | null, conclusion?: string | null }} CIFailure
 */

/**
 * One failure of a GitHub Actions job that its `continue-on-error` hides, so that GitHub doesn't count it as CI failing: the job's workflow file (see `workflowFile`), its check run's name (`job`), and what it says (`message`).
 * @typedef {{ file: string | null, job: string, message: string }} HiddenFailure
 */
/**
 * Every failure of one GitHub Actions job, in one workflow file, that `continue-on-error` hides (see `optionalFailures`): its workflow file, its check run's name (`job`), and what each says (`messages`), each only once, however many runs of that file on the commit (eg, one for a `push`, and one for a `pull_request`) said it.
 * @typedef {{ file: string | null, job: string, messages: string[] }} OptionalFailure
 */

/** @type {(run: WorkflowRun | undefined) => string | null} */
function fileOf(run) {
	return workflowFile(run)[0] ?? null;
}

/**
 * The failures of GitHub Actions jobs that `continue-on-error` hides from their steps, and so from their jobs and check runs, which concluded as a success: a step with `continue-on-error` that fails leaves its job, and so its check run, successful.
 * GitHub's jobs API reports such a step's own `conclusion` as `success` too, so the step can't show it; but the runner still leaves a `failure` annotation (eg, “Process completed with exit code 1.”) on its job's check run, so each `failure` annotation is one. That's conservative: an `::error::` a passing step writes is one too.
 * A step whose own `conclusion` (or `outcome`, should the API ever give one) is a failure is one as well. A check run whose job can't be found has only its annotations to show.
 * Each is its job's, in the workflow file of the run that job is of (see `HiddenFailure`).
 * @type {(octokit: Octokit, commit: Commit, ci: { runs: WorkflowRun[], checkRuns: CheckRun[] }) => Promise<HiddenFailure[]>}
 */
async function hiddenFailures(octokit, { owner, name }, { runs, checkRuns }) {
	const passed = checkRuns.filter((run) => run.app?.slug === 'github-actions' && run.conclusion === 'success');
	if (passed.length === 0) {
		return [];
	}
	/** @type {Map<string, { run_id: number, steps?: { name: string, conclusion: string | null }[] }>} */
	const jobs = new Map();
	await runs.reduce(
		async (previous, run) => {
			await previous;
			const runJobs = await octokit.paginate(octokit.rest.actions.listJobsForWorkflowRun, {
				owner,
				repo: name,
				run_id: run.id, // eslint-disable-line camelcase
				filter: 'latest',
				per_page: 100, // eslint-disable-line camelcase
			});
			runJobs.forEach((job) => {
				jobs.set(job.check_run_url, job);
			});
		},
		Promise.resolve(),
	);
	/** @type {HiddenFailure[]} */
	const hidden = [];
	await passed.reduce(
		async (previous, checkRun) => {
			await previous;
			const job = jobs.get(checkRun.url);
			/** @type {(message: string) => void} */
			const fail = (message) => {
				hidden.push({
					file: fileOf(runs.find((run) => run.id === job?.run_id)),
					job: checkRun.name,
					message,
				});
			};
			(job?.steps ?? []).forEach((step) => {
				const failed = [step.conclusion, 'outcome' in step ? step.outcome : null].find((c) => typeof c === 'string' && failingSteps.has(c));
				if (failed) {
					fail(`step ${code(step.name)}: ${failed}`);
				}
			});
			if ((checkRun.output?.annotations_count ?? 0) > 0) {
				const annotations = await octokit.paginate(octokit.rest.checks.listAnnotations, {
					owner,
					repo: name,
					check_run_id: checkRun.id, // eslint-disable-line camelcase
					per_page: 100, // eslint-disable-line camelcase
				});
				annotations.filter((a) => a.annotation_level === 'failure').forEach((annotation) => {
					fail(code(excerpt(annotation.message ?? '')));
				});
			}
		},
		Promise.resolve(),
	);
	return hidden;
}

/**
 * `hidden`, by job (see `OptionalFailure`), each in the order its first failure came in, with each message once.
 * @type {(hidden: HiddenFailure[]) => OptionalFailure[]}
 */
function byJob(hidden) {
	/** @type {Map<string, OptionalFailure>} */
	const jobs = new Map();
	hidden.forEach(({
		file,
		job,
		message,
	}) => {
		const key = JSON.stringify([file, job]);
		const entry = jobs.get(key) ?? {
			file,
			job,
			messages: [],
		};
		jobs.set(key, entry);
		if (!entry.messages.includes(message)) {
			entry.messages.push(message);
		}
	});
	return Array.from(jobs.values());
}

/**
 * Everything on `commit`'s CI but the failures `continue-on-error` hides in steps (see `hiddenFailures`): its workflow runs and check runs, whether anything is still pending (as `ciStatus` counts it), each failure, and each failure of a job that its `continue-on-error` hides (`optional`).
 * A check run's workflow file is that of the workflow run in its check suite, if there is one.
 * GitHub concludes a workflow run as a success, though one of its jobs failed, only when that job's `continue-on-error` hides its failure: so a GitHub Actions check run that failed in the check suite of a workflow run that completed as a success is such a job's. One whose workflow run hasn't completed yet can't be told from one that will fail it, so it's neither, until that run (which keeps CI pending) completes. Any other check run that failed (one of another app's, or in a check suite no workflow run is of, or whose workflow run failed) fails CI.
 * @type {(octokit: Octokit, commit: Commit) => Promise<{ runs: WorkflowRun[], checkRuns: CheckRun[], pending: boolean, failures: CIFailure[], optional: HiddenFailure[] }>}
 */
async function readCI(octokit, commit) {
	const {
		owner,
		name,
		head: sha,
	} = commit;
	// a job that only starts once others finish (by `needs`, or in a matrix an earlier job outputs) has no check run until then, so only its workflow run shows that CI isn't done; a run's conclusion also covers any check run that `latest` leaves out
	/** @type {WorkflowRun[]} */
	const runs = await octokit.paginate(octokit.rest.actions.listWorkflowRunsForRepo, {
		owner,
		repo: name,
		head_sha: sha, // eslint-disable-line camelcase
		per_page: 100, // eslint-disable-line camelcase
	});
	// `latest` (the default), so a check that was re-run counts only as it last ran
	/** @type {CheckRun[]} */
	const checkRuns = await octokit.paginate(octokit.rest.checks.listForRef, {
		owner,
		repo: name,
		ref: sha,
		filter: 'latest',
		per_page: 100, // eslint-disable-line camelcase
	});
	// a suite an app has registered, but made no check run in yet, shows only there
	const suites = await checkSuites(octokit, commit);
	const statuses = await commitStatuses(octokit, commit);
	/** @type {CIFailure[]} */
	const failures = suites.failures.map((text) => ({
		text,
		file: null,
		job: null,
	}));
	/** @type {HiddenFailure[]} */
	const optional = [];
	let pending = suites.pending || (checkRuns.length === 0 && statuses.length === 0);
	runs.forEach((run) => {
		if (run.status !== 'completed') {
			pending = true;
		} else if (!passing.has(String(run.conclusion))) {
			failures.push({
				text: `${code(run.name || `workflow run ${run.id}`)}: ${run.conclusion ?? 'no conclusion'}`,
				file: fileOf(run),
				job: null,
				conclusion: run.conclusion,
			});
		}
	});
	checkRuns.forEach((run) => {
		if (run.status !== 'completed') {
			pending = true;
		} else if (!passing.has(String(run.conclusion))) {
			const suite = run.check_suite?.id;
			const workflowRun = suite ? runs.find((r) => r.check_suite_id === suite) : void undefined;
			const actions = run.app?.slug === 'github-actions' && workflowRun;
			if (actions && workflowRun.conclusion === 'success' && workflowRun.status === 'completed') {
				optional.push({
					file: fileOf(workflowRun),
					job: run.name,
					message: run.conclusion ?? 'no conclusion',
				});
			} else if (!actions || workflowRun.status === 'completed') {
				failures.push({
					text: `${code(run.name)}: ${run.conclusion ?? 'no conclusion'}`,
					file: fileOf(workflowRun),
					job: run.name,
				});
			}
		}
	});
	statuses.forEach((status) => {
		if (status.state === 'pending') {
			pending = true;
		} else if (status.state !== 'success') {
			failures.push({
				text: `${code(status.context)}: ${status.state}`,
				file: null,
				job: null,
			});
		}
	});
	if (failures.length === 0 && !pending) {
		pending = unreportedPending(suites.unreported, /** @type {(string | null | undefined)[]} */ ([]).concat(
			runs.map((run) => run.updated_at),
			checkRuns.map((run) => run.completed_at),
			statuses.map((status) => status.updated_at),
		));
	}
	return {
		runs,
		checkRuns,
		pending,
		failures,
		optional,
	};
}

/**
 * The failures on `commit`'s CI that `continue-on-error` hides, which never fail it (see `readCI`, `hiddenFailures`), by job (see `OptionalFailure`), from what `readCI` read of it.
 * @type {(octokit: Octokit, commit: Commit, ci: Awaited<ReturnType<typeof readCI>>) => Promise<OptionalFailure[]>}
 */
async function optionalOf(octokit, commit, ci) {
	return byJob(ci.optional.concat(await hiddenFailures(octokit, commit, ci)));
}

/**
 * Every failure on `commit`'s CI that `continue-on-error` hides, by job (see `OptionalFailure`): of a job whose `continue-on-error` let its workflow run succeed though it failed (its message is its check run's conclusion, eg `failure`), or of a step whose `continue-on-error` let its job succeed though it failed (its message is the step's, or the failure annotation it left: see `hiddenFailures`). GitHub doesn't count any of them as CI failing, so neither does `ciStatus`, nor does anything the App does about a PR whose CI failed (see `blame`).
 * A failed job whose workflow run is still running can't be told from one that will fail it yet, so it isn't one, until that run completes; whatever else is still pending doesn't keep the rest from being listed.
 * Each is only ever in a GitHub Actions workflow run (see `CIFailure`), so its workflow file is known whenever that run is.
 * @type {(octokit: Octokit, commit: Commit) => Promise<OptionalFailure[]>}
 */
export async function optionalFailures(octokit, commit) {
	return optionalOf(octokit, commit, await readCI(octokit, commit));
}

/**
 * How CI went on `commit`, exactly as `ciStatus` decides it, with each failure as a `CIFailure`; once nothing is pending, the failures `continue-on-error` hides (`optional`: see `optionalFailures`), which never fail it; and, for a failure, whether any of its workflow runs is still `running` (and so may yet fail in more ways: see `blame`).
 * @type {(octokit: Octokit, commit: Commit) => Promise<{ kind: 'pending' } | { kind: 'passed', optional: OptionalFailure[] } | { kind: 'failed', failures: CIFailure[], optional: OptionalFailure[], running: boolean }>}
 */
export async function ciFailures(octokit, commit) {
	const ci = await readCI(octokit, commit);
	if (ci.pending) {
		return ci.failures.length > 0
			? {
				kind: 'failed',
				failures: ci.failures,
				optional: [],
				running: ci.runs.some((run) => run.status !== 'completed'),
			}
			: { kind: 'pending' };
	}
	const optional = await optionalOf(octokit, commit, ci);
	return ci.failures.length > 0
		? {
			kind: 'failed',
			failures: ci.failures,
			optional,
			running: false,
		}
		: { kind: 'passed', optional };
}

/**
 * What a reply says about each job in `optional` (see `OptionalFailure`): its name, and its messages; a job that says exactly the same in another workflow file is only said once.
 * @type {(optional: OptionalFailure[]) => string[]}
 */
function optionalTexts(optional) {
	return Array.from(new Set(optional.map(({ job, messages }) => `${code(job)}: ${messages.join(', ')}`)));
}

/**
 * Whether CI has fully finished, successfully, on `sha`, as GitHub decides it: every workflow run on it completed as a success or skipped, every check suite completed (as `suiteState` and `unreportedPending` count it), every check run (of every check suite) completed as a success or skipped (except a job's whose failure `continue-on-error` hides: see `readCI`), and every commit status a success.
 * With no check runs and no statuses at all, CI hasn't even started, so it's pending. A failure says which workflow files failed, as far as that can be told; each failure is said only once (eg, the same job's, in two runs of the same workflow).
 * Once nothing's pending, the failures `continue-on-error` hides (see `optionalFailures`), which never fail it, are in `optional`, by job, when there are any.
 * @type {(octokit: Octokit, commit: Commit) => Promise<Extract<Assessment, { kind: 'pending' | 'failed' }> | { kind: 'passed', optional?: string[] }>}
 */
export async function ciStatus(octokit, commit) {
	const ci = await ciFailures(octokit, commit);
	if (ci.kind === 'pending') {
		return ci;
	}
	const optional = optionalTexts(ci.optional);
	const notes = optional.length > 0 ? { optional } : {};
	return ci.kind === 'failed'
		? {
			kind: 'failed',
			failures: Array.from(new Set(ci.failures.map((f) => f.text))),
			files: Array.from(new Set(ci.failures.flatMap((f) => f.file ?? []))),
			...notes,
		}
		: { kind: 'passed', ...notes };
}

/**
 * Every failure on `commit`'s CI, even when something is still pending, but never one that `continue-on-error` hides (see `optionalFailures`), which never fails it; the workflow files whose every run on it has completed, since only those can show how they went; and whether any of its workflow runs is still `running`.
 * Unlike `ciStatus`, this only tells what fails there (eg, on a PR's base branch, to tell which of the PR's failures it didn't cause), never whether CI passed.
 * @type {(octokit: Octokit, commit: Commit) => Promise<{ failures: CIFailure[], completed: string[], running: boolean }>}
 */
export async function allFailures(octokit, commit) {
	const ci = await readCI(octokit, commit);
	const files = new Set(ci.runs.flatMap(workflowFile));
	return {
		failures: ci.failures,
		completed: Array.from(files).filter((file) => ci.runs.every((run) => fileOf(run) !== file || run.status === 'completed')),
		running: ci.runs.some((run) => run.status !== 'completed'),
	};
}

/**
 * What a failure is the same as on another commit: a job's, by its check run's name; a workflow run's own, by its conclusion.
 * @type {(failure: CIFailure) => string}
 */
function sameAs({ job, conclusion }) {
	return job === null ? `run: ${conclusion}` : `job: ${job}`;
}

/**
 * Of the workflow files that `failures` (on the PR's head commit) are in, the ones the PR could have caused: each with a failure whose job (its check run's name; or, for its workflow run's own, its conclusion) didn't also fail there on `base` (its base branch's tip), in the same file (see `sameAs`).
 * Without `base`, or when the base has no runs of a file, or one still running, the base can't show how that file fails there, so every failure in it is the PR's.
 * @type {(failures: CIFailure[], base?: { failures: CIFailure[], completed: string[] }) => string[]}
 */
export function causedFiles(failures, base) {
	const files = Array.from(new Set(failures.flatMap((f) => f.file ?? [])));
	return files.filter((file) => {
		if (!base?.completed.includes(file)) {
			return true;
		}
		const already = new Set(base.failures.filter((f) => f.file === file).map(sameAs));
		return failures.some((f) => f.file === file && !already.has(sameAs(f)));
	});
}

/**
 * Of the workflow files CI failed in on a PR's head commit, the ones the PR could have caused (see `causedFiles`), from `failures`, what decided that it failed there (see `ciFailures`), and its base branch's tip's (`baseTip`) CI, which is only read when some failure is in a workflow file at all, since otherwise the PR could have caused none.
 * Failures `continue-on-error` hides are never in `failures`, nor in what's read of the base, so they never make a workflow file the PR's (see `optionalFailures`).
 * Once anything failed, `failures` leave out whatever's still running (including a failed job whose workflow run is, since it can't yet be told from one that `continue-on-error` hides: see `readCI`); so while any of the head commit's workflow runs is still `running`, every failure being also on the base decides nothing yet; once none is, it's the `base`'s, in `files`.
 * @type {(octokit: Octokit, ci: { failures: CIFailure[], running: boolean }, baseTip: Commit) => Promise<{ kind: 'caused' | 'base', files: string[] } | { kind: 'running' }>}
 */
export async function blame(octokit, { failures, running }, baseTip) {
	const files = causedFiles(failures);
	if (files.length === 0) {
		return { kind: 'caused', files: [] };
	}
	const caused = causedFiles(failures, await allFailures(octokit, baseTip));
	if (caused.length > 0) {
		return { kind: 'caused', files: caused };
	}
	return running ? { kind: 'running' } : { kind: 'base', files };
}
