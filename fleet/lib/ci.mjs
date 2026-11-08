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

/** @type {(run: WorkflowRun | undefined) => string | null} */
function fileOf(run) {
	return workflowFile(run)[0] ?? null;
}

/**
 * The failures of GitHub Actions jobs that their check runs' conclusions don't show: a step with `continue-on-error` that fails leaves its job, and so its check run, successful.
 * GitHub's jobs API reports such a step's own `conclusion` as `success` too, so the step can't show it; but the runner still leaves a `failure` annotation (eg, “Process completed with exit code 1.”) on its job's check run, so any `failure` annotation counts as a failure. That's conservative: an `::error::` a passing step writes counts too.
 * A step whose own `conclusion` (or `outcome`, should the API ever give one) is a failure counts as well; and a check run whose job can't be found can't be shown to have no such step, so it counts as failed.
 * Each is its job's, in the workflow file of the run that job is of (see `CIFailure`).
 * @type {(octokit: Octokit, commit: Commit, ci: { runs: WorkflowRun[], checkRuns: CheckRun[] }) => Promise<CIFailure[]>}
 */
async function maskedFailures(octokit, { owner, name }, { runs, checkRuns }) {
	checkRuns = checkRuns.filter((run) => run.app?.slug === 'github-actions'); // eslint-disable-line no-param-reassign
	if (checkRuns.length === 0) {
		return [];
	}
	/** @type {Map<string, { run_id: number, steps?: { name: string, conclusion: string | null }[] }>} */
	const jobs = new Map();
	await runs.reduce(async (previous, run) => {
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
	}, Promise.resolve());
	/** @type {CIFailure[]} */
	const failures = [];
	await checkRuns.reduce(async (previous, checkRun) => {
		await previous;
		const job = jobs.get(checkRun.url);
		/** @type {(text: string) => void} */
		const fail = (text) => {
			failures.push({
				text: `${code(checkRun.name)}: ${text}`,
				file: fileOf(runs.find((run) => run.id === job?.run_id)),
				job: checkRun.name,
			});
		};
		if (!job) {
			fail('its steps could not be inspected');
		}
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
				fail(`a step failed: ${code(excerpt(annotation.message ?? ''))}`);
			});
		}
	}, Promise.resolve());
	return failures;
}

/**
 * Everything on `commit`'s CI but its masked failures (see `maskedFailures`): its workflow runs and check runs, whether anything is still pending (as `ciStatus` counts it), and each failure.
 * A check run's workflow file is that of the workflow run in its check suite, if there is one.
 * @type {(octokit: Octokit, commit: Commit) => Promise<{ runs: WorkflowRun[], checkRuns: CheckRun[], pending: boolean, failures: CIFailure[] }>}
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
			failures.push({
				text: `${code(run.name)}: ${run.conclusion ?? 'no conclusion'}`,
				file: fileOf(suite ? runs.find((r) => r.check_suite_id === suite) : void undefined),
				job: run.name,
			});
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
	};
}

/**
 * How CI went on `commit`, exactly as `ciStatus` decides it, with each failure as a `CIFailure`.
 * @type {(octokit: Octokit, commit: Commit) => Promise<{ kind: 'pending' | 'passed' } | { kind: 'failed', failures: CIFailure[] }>}
 */
export async function ciFailures(octokit, commit) {
	const ci = await readCI(octokit, commit);
	const failures = ci.failures.length === 0 && !ci.pending
		? await maskedFailures(octokit, commit, ci)
		: ci.failures;
	if (failures.length > 0) {
		return { kind: 'failed', failures };
	}
	return { kind: ci.pending ? 'pending' : 'passed' };
}

/**
 * Whether CI has fully finished, successfully, on `sha`: every workflow run on it completed as a success or skipped, every check suite completed (as `suiteState` and `unreportedPending` count it), every check run (of every check suite) completed as a success or skipped, every commit status a success, and no step of a GitHub Actions job failed, even one whose failure `continue-on-error` hides.
 * With no check runs and no statuses at all, CI hasn't even started, so it's pending. A failure says which workflow files failed, as far as that can be told.
 * @type {(octokit: Octokit, commit: Commit) => Promise<Extract<Assessment, { kind: 'pending' | 'failed' }> | { kind: 'passed' }>}
 */
export async function ciStatus(octokit, commit) {
	const ci = await ciFailures(octokit, commit);
	return ci.kind === 'failed'
		? {
			kind: 'failed',
			failures: ci.failures.map((f) => f.text),
			files: Array.from(new Set(ci.failures.flatMap((f) => f.file ?? []))),
		}
		: ci;
}

/**
 * Every failure on `commit`'s CI, masked ones (see `maskedFailures`) included even when something else failed, or is still pending; the workflow files whose every run on it has completed, since only those can show how they went; and whether any of its workflow runs is still `running`.
 * Unlike `ciStatus`, this only tells what fails there (eg, on a PR's base branch, to tell which of the PR's failures it didn't cause), never whether CI passed.
 * @type {(octokit: Octokit, commit: Commit) => Promise<{ failures: CIFailure[], completed: string[], running: boolean }>}
 */
export async function allFailures(octokit, commit) {
	const ci = await readCI(octokit, commit);
	const files = new Set(ci.runs.flatMap(workflowFile));
	return {
		failures: ci.failures.concat(await maskedFailures(octokit, commit, ci)),
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
 * Of the workflow files CI failed in on a PR's head commit (`headCommit`), the ones the PR could have caused (see `causedFiles`), from `failures`, what decided that it failed there (see `ciFailures`), and its base branch's tip's (`baseTip`) CI, which is only read when some failure is in a workflow file at all, since otherwise the PR could have caused none.
 * Once anything failed, `failures` leave out masked failures, and whatever's still running; so before deciding that every failure is also on the base, every one on the head commit is read too (see `allFailures`): while any of its workflow runs is still `running`, nothing is decided yet; and when, after all, every one is also on the base, it's the `base`'s, in `files`.
 * @type {(octokit: Octokit, failures: CIFailure[], commits: { headCommit: Commit, baseTip: Commit }) => Promise<{ kind: 'caused' | 'base', files: string[] } | { kind: 'running' }>}
 */
export async function blame(octokit, failures, { headCommit, baseTip }) {
	if (causedFiles(failures).length === 0) {
		return { kind: 'caused', files: [] };
	}
	const onBase = await allFailures(octokit, baseTip);
	const caused = causedFiles(failures, onBase);
	if (caused.length > 0) {
		return { kind: 'caused', files: caused };
	}
	const onHead = await allFailures(octokit, headCommit);
	if (onHead.running) {
		return { kind: 'running' };
	}
	const all = causedFiles(onHead.failures, onBase);
	return all.length > 0
		? { kind: 'caused', files: all }
		: { kind: 'base', files: causedFiles(onHead.failures) };
}
