import { code } from './markdown.mjs';

/** @typedef {import('./app.mjs').Octokit} Octokit */
/** @typedef {import('./merge.mjs').Target} Target */
/** @typedef {{ id: number, status: string | null, conclusion: string | null, created_at?: string | null, latest_check_runs_count?: number, app?: { name?: string | null } | null }} CheckSuite */

const passing = new Set(['success', 'skipped']);

export const changedReason = 'it changed while it was being checked; run `/merge` again';

// GitHub lists at most this many of a PR's commits
export const maxPRCommits = 250;

/** @typedef {{ login?: string | null } | null | undefined} GitHubUser */
/** @typedef {{ email?: string | null } | null | undefined} GitUser */

/**
 * Why `/merge` must never merge the PR, for the commits it has, if it must not: unless every one of them was authored and committed by the App's bot, someone else could have put anything in it.
 * Each author and committer is matched by the GitHub user GitHub links it to when there is one, else by the bot's noreply email (which is what the App commits with).
 * GitHub lists at most `maxPRCommits` of a PR's commits, so a PR with that many can't be shown to have no others.
 * The last commit listed must be `head`, the commit that's merged, so that the commits checked are the ones merged.
 * Else, how many commits it has, for `assess` to check that they're the ones merged.
 * @type {(octokit: Octokit, target: Target, bot: string) => Promise<{ reason: string } | { count: number }>}
 */
export async function commitsRefusal(octokit, {
	owner, name, number, head,
}, bot) {
	const commits = await octokit.paginate(octokit.rest.pulls.listCommits, {
		owner, repo: name, pull_number: number, per_page: 100, // eslint-disable-line camelcase
	});
	if (commits.length >= maxPRCommits) {
		return { reason: `it has at least ${maxPRCommits} commits, more than GitHub lists, so they can’t all be checked to be the App’s own; review and merge it yourself` };
	}
	if (commits.at(-1)?.sha !== head) {
		return { reason: changedReason };
	}
	/** @type {Promise<string> | undefined} */
	let email;
	const botEmail = () => {
		email ??= octokit.rest.users.getByUsername({ username: bot }).then(({ data }) => `${data.id}+${bot}@users.noreply.github.com`.toLowerCase());
		return email;
	};
	/** @type {(user: GitHubUser, gitUser: GitUser) => Promise<boolean>} */
	const isBot = async (user, gitUser) => {
		if (user?.login) {
			return user.login.toLowerCase() === bot.toLowerCase();
		}
		return typeof gitUser?.email === 'string' && gitUser.email.toLowerCase() === await botEmail();
	};
	for (const {
		author, committer, commit,
	} of commits) {
		if (!await isBot(author, commit.author) || !await isBot(committer, commit.committer)) { // eslint-disable-line no-await-in-loop
			return { reason: 'it has commits by someone else; review and merge it yourself' };
		}
	}
	return { count: commits.length };
}

/**
 * How a check suite counts: one that hasn't completed is pending, unless it has no check runs at all, which is `unreported` (see `unreportedPending`); one that completed as a success or skipped passed, as did one with no check runs at all that concluded `neutral` or nothing (GitHub makes such an empty suite for an app that never reports anything on the commit); anything else failed, as a check run would have.
 * @type {(suite: CheckSuite) => 'pending' | 'unreported' | 'passed' | 'failed'}
 */
function suiteState(suite) {
	if (suite.status !== 'completed') {
		return suite.latest_check_runs_count === 0 ? 'unreported' : 'pending';
	}
	if (passing.has(String(suite.conclusion)) || (suite.latest_check_runs_count === 0 && (suite.conclusion === 'neutral' || suite.conclusion === null))) {
		return 'passed';
	}
	return 'failed';
}

/**
 * Every check suite on `head`, as `suiteState` counts each one: whether any is pending, when each `unreported` one was created, and how each that failed did.
 * @type {(octokit: Octokit, commit: { owner: string, name: string, head: string }) => Promise<{ pending: boolean, unreported: (string | null | undefined)[], failures: string[] }>}
 */
export async function checkSuites(octokit, {
	owner, name, head,
}) {
	/** @type {CheckSuite[]} */
	const suites = await octokit.paginate(octokit.rest.checks.listSuitesForRef, {
		owner, repo: name, ref: head, per_page: 100, // eslint-disable-line camelcase
	});
	const states = suites.map((suite) => ({ suite, state: suiteState(suite) }));
	return {
		pending: states.some(({ state }) => state === 'pending'),
		unreported: states.filter(({ state }) => state === 'unreported').map(({ suite }) => suite.created_at),
		failures: states.filter(({ state }) => state === 'failed').map(({ suite }) => `check suite ${suite.id}${suite.app?.name ? ` (${code(suite.app.name)})` : ''}: ${suite.conclusion ?? 'no conclusion'}`),
	};
}

// how long CI must have been quiet before an unfinished check suite with no check runs is taken to be one its app will never report on
export const quietMinutes = 15;

/**
 * Whether unfinished check suites with no check runs, created at `unreported`, still keep CI pending, once everything else on the commit has passed.
 * Many apps (eg, Codecov, Renovate, Travis CI) leave such a suite queued forever on every commit, so it can't be waited for; but an app may also make its check runs only once other CI is done (eg, Codecov, once coverage is uploaded).
 * So it's pending until nothing on the commit has happened for `quietMinutes`: since the latest of when each such suite was created, and `others`, the times when everything else last changed.
 * Without any such time, nothing shows how long CI has been quiet, so it's pending.
 * @type {(unreported: (string | null | undefined)[], others: (string | null | undefined)[], now?: number) => boolean}
 */
export function unreportedPending(unreported, others, now = Date.now()) {
	if (unreported.length === 0) {
		return false;
	}
	const times = [...unreported, ...others].map((time) => Date.parse(time ?? '')).filter(Number.isFinite);
	return times.length === 0 || now - Math.max(...times) < quietMinutes * 60 * 1000;
}

/**
 * Whether `base` can be fast-forwarded to `head` (its current tip is an ancestor of `head`), and if so, whether that merges exactly the `count` commits the PR was checked to have: else GitHub's list of them was stale.
 * @type {(octokit: Octokit, target: Target, count: number) => Promise<'behind' | 'changed' | 'ok'>}
 */
export async function fastForwardable(octokit, {
	owner, name, base, head,
}, count) {
	const { data: ref } = await octokit.rest.git.getRef({
		owner, repo: name, ref: `heads/${base}`,
	});
	const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
		owner, repo: name, basehead: `${ref.object.sha}...${head}`, per_page: 1, // eslint-disable-line camelcase
	});
	if ((data.status !== 'ahead' && data.status !== 'identical') || data.behind_by !== 0) {
		return 'behind';
	}
	return data.status === 'ahead' && data.ahead_by !== count ? 'changed' : 'ok';
}

/**
 * Why a PR whose base branch has moved on isn't merged: GitHub's “Update branch” would add a commit that isn't the App's, which `/merge` then never takes, so it must be updated the way the App does.
 * @type {(base: string) => string}
 */
export function behindReason(base) {
	return `it needs updating, since ${code(base)} has moved on since its branch was made (so it can’t be fast-forwarded); have the App update it (eg, with \`/fix\`, for a \`fleet/workflows\` PR), not GitHub’s “Update branch” (whose commit isn’t the App’s, so \`/merge\` would never take it), then run \`/merge\` again`;
}
