import {
	lstatSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import * as core from '@actions/core';

import { installationToken, octokitFor } from '../lib/app.mjs';
import { readmeBranch } from '../lib/branches.mjs';
import { code } from '../lib/markdown.mjs';
import {
	assertBotOwned,
	botIdentity,
	checkout,
	closePR,
	commentOnce,
	commitChanges,
	findPR,
	publish,
	remoteTip,
} from '../lib/pr.mjs';
import { marker as saidMarker } from '../lib/said.mjs';
import { identityOf, unreadable } from './check.mjs';
import {
	drift,
	fixReadme,
	readmePath,
} from './readme.mjs';

/** @import { Octokit, RepoState, appAuth } from '../lib/app.mjs' */
/** @import { Git, Identity, PRState } from '../lib/pr.mjs' */
/** @import { Category, Skip } from './readme.mjs' */
/** @typedef {{ state: RepoState, categories: Set<Category> | undefined }} Candidate */
/**
 * @typedef {{
 *   auth: ReturnType<typeof appAuth>,
 *   identities: Map<number, Promise<Identity>>,
 *   dryRun: boolean,
 *   link: string,
 * }} Context
 */
/** @typedef {{ context: Context, state: RepoState, base: string, categories: Set<Category> | undefined, fixing: Category[] }} Job */

export const branch = readmeBranch;
const title = '[readme] update the heading and badges to match the fleet’s';
const message = title;

const {
	GITHUB_SERVER_URL = 'https://github.com',
	GITHUB_REPOSITORY = '',
} = process.env;

/** @type {Record<Category, string>} */
const changes = {
	heading: 'the heading',
	badges: 'the badges under it',
	links: 'the link definitions they use',
};

/** @type {(categories: Category[]) => string} */
function described(categories) {
	return categories.map((c) => changes[c]).join(', ');
}

/** @type {(base: string) => string} */
function matched(base) {
	return `${code(base)}’s ${code(readmePath)} already matches`;
}

/** @type {(state: RepoState, number: number) => string} */
function prURL(state, number) {
	return `${GITHUB_SERVER_URL}/${state.repository}/pull/${number}`;
}

/** @type {(skipped: Skip[]) => string[]} */
function skips(skipped) {
	return skipped.map((s) => `left as it is: ${s.why}`);
}

// one per installation, since each has its own token to look the bot user up with
/** @type {(context: Context, installation: number) => Promise<Identity>} */
function identityFor({ auth, identities }, installation) {
	let identity = identities.get(installation);
	if (!identity) {
		identity = botIdentity(auth, installation);
		identities.set(installation, identity);
	}
	return identity;
}

/** @type {(fixing: Category[], skipped: Skip[], link: string) => string} */
function prBody(fixing, skipped, link) {
	return [
		`This makes ${code(readmePath)}’s heading, the badges under it, and the link definitions they use match the fleet’s (see [\`${GITHUB_REPOSITORY}\`’s README drift report](${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/tree/HEAD/fleet/readme)), as asked in [this comment](${link}):`,
		'',
		...fixing.map((c) => `- ${changes[c]}`),
		...skipped.length > 0 ? [
			'',
			'These are left as they are:',
			'',
			...skipped.map((s) => `- ${s.why}`),
		] : [],
	].join('\n');
}

/**
 * What `/fix` would change in `state`'s README, limited to `categories` (unspecified: all of them), as it is in `state`: the kinds of discrepancy it fixes, its new text (with the default branch it's for), and what it can't fix. A README that can't be fixed at all (see `identityOf` and `unreadable`) is left as it is, saying why, as the drift report already does: like a workflow file `/fix` can't plan, it's nothing to fix, not a failure.
 * @type {(state: RepoState, categories: Set<Category> | undefined) => { fixing: Category[], text: null, skipped: Skip[] } | { fixing: Category[], text: string, skipped: Skip[], base: string }}
 */
export function planReadme(state, categories) {
	const known = identityOf(state);
	if ('error' in known) {
		return {
			fixing: [],
			text: null,
			skipped: [{ why: known.error }],
		};
	}
	const why = unreadable(state);
	if (why !== null || state.readme === null) {
		// `unreadable` always says why when there's no README
		return {
			fixing: [],
			text: null,
			skipped: [why].filter((w) => w !== null).map((w) => ({ why: w })),
		};
	}
	const found = drift(state.readme, known.identity).filter((c) => !categories || categories.size === 0 || categories.has(c));
	if (found.length === 0) {
		return {
			fixing: [], text: null, skipped: [],
		};
	}
	const { text, skipped } = fixReadme(state.readme, known.identity, new Set(found));
	if (text === state.readme) {
		return {
			fixing: found,
			text: null,
			skipped,
		};
	}
	return {
		fixing: found,
		text,
		skipped,
		base: known.identity.branch,
	};
}

// filters may leave out kinds that don't match, so what they plan matching says nothing about the rest
/** @type {(job: Job) => boolean} */
function isFiltered({ categories }) {
	return !!categories?.size;
}

/**
 * The repository's state as its clone (at the base's current tip) has it, which may have moved on since it was read: so that the PR is planned from what it will be applied to.
 * @type {(git: Git, state: RepoState) => RepoState}
 */
function cloneState(git, state) {
	/** @type {(file: string) => string | null} */
	const show = (file) => {
		const shown = git(['show', `HEAD:${file}`], { allowFailure: true });
		return shown.status === 0 ? shown.stdout : null;
	};
	const [entry = ''] = git([
		'ls-tree',
		'-z',
		'HEAD',
		'--',
		readmePath,
	]).stdout.split('\0').filter(Boolean);
	return {
		...state,
		packageJson: show('package.json'),
		readme: show(readmePath),
		readmeRegular: entry.startsWith('100644 blob '),
	};
}

/**
 * Where the README is in the clone: refused when it's a symbolic link, which would be written through, since `unreadable` only checked it as it was read (see `cloneState`, which checks it again).
 * @type {(dir: string) => string}
 */
function readmeIn(dir) {
	const file = path.join(dir, readmePath);
	if (lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) {
		throw new Error(`\`${readmePath}\` is a symbolic link, so nothing is written through it`);
	}
	return file;
}

/**
 * When the default branch's README already matches (eg, it moved on since it was checked), so that there's no PR to make: closes the App's open PR there, unless filters limited what was planned (see `isFiltered`); never one with anyone else's commits (see `assertBotOwned`), and never reopening a closed one. Returns what happened.
 * @type {(options: { job: Job, octokit: Octokit, git: Git, prState: PRState, tip: string | null, identity: Identity }) => Promise<string>}
 */
async function closeMatched({
	job,
	octokit,
	git,
	prState,
	tip,
	identity,
}) {
	const { state, base } = job;
	if (prState.mode !== 'update' || isFiltered(job)) {
		return `nothing to fix: ${matched(base)}`;
	}
	if (tip) {
		assertBotOwned(git, {
			base,
			branch,
			tip,
			identity,
		});
	}
	await commentOnce({
		octokit,
		owner: state.owner,
		name: state.name,
		number: prState.number,
		author: identity.name,
		marker: saidMarker('matches', prState.head),
		body: `${matched(base)} what this PR would make it, so the App closes it.`,
	});
	await closePR({
		octokit,
		owner: state.owner,
		name: state.name,
		number: prState.number,
		said: {
			author: identity.name,
			isPrivate: state.private,
			kept: { kind: 'matches', head: prState.head },
		},
	});
	return `closed ${prURL(state, prState.number)}: ${matched(base)}`;
}

/** @type {(job: Job) => Promise<string>} */
async function openPR(job) {
	const {
		context,
		state,
		base,
		categories,
	} = job;
	const {
		owner,
		name,
		installationId,
	} = state;
	const token = await installationToken(context.auth, installationId, {
		repositoryNames: [name],
		// the PR's one commit only changes the README, but pushing its branch onto the base's tip makes the base's own commits reachable from it, and GitHub refuses that from an App without Workflows (write) when any of them changes a workflow file
		permissions: {
			contents: 'write',
			pull_requests: 'write', // eslint-disable-line camelcase
			workflows: 'write',
		},
	});
	core.setSecret(token);
	const octokit = octokitFor(token, state.private);
	const identity = await identityFor(context, installationId);

	const dir = mkdtempSync(path.join(process.env.RUNNER_TEMP || tmpdir(), 'fleet-readme-'));
	try {
		const clone = path.join(dir, 'repo');
		const { git } = checkout({
			repository: state.repository,
			base,
			token,
			identity,
			dir: clone,
		});
		const prState = await findPR(octokit, {
			owner,
			name,
			base,
			branch,
		});
		const tip = remoteTip(git, branch);
		// the PR is always one commit, on the base's current tip, with the whole change, planned again from there
		const plan = planReadme(cloneState(git, state), categories);
		// its README changed since it was read, so that it can't be fixed at all (eg, it's gone, or became a symbolic link): that's not its base matching, so the PR is left as it is
		if (plan.text === null && plan.fixing.length === 0 && plan.skipped.length > 0) {
			return ['nothing to fix', ...skips(plan.skipped)].join('<br>');
		}
		if (plan.text !== null) {
			writeFileSync(readmeIn(clone), plan.text);
		}
		if (plan.text === null || !commitChanges(git, {
			base,
			message,
			paths: [readmePath],
			allowed: (file) => file === readmePath,
		})) {
			return await closeMatched({
				job,
				octokit,
				git,
				prState,
				tip,
				identity,
			});
		}
		return [
			await publish({
				octokit,
				git,
				owner,
				name,
				base,
				branch,
				state: prState,
				tip,
				identity,
				title,
				body: prBody(plan.fixing, plan.skipped, context.link),
				isPrivate: state.private,
			}),
			...skips(plan.skipped),
		].join('<br>');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** @type {(job: Job) => Promise<string>} */
async function describePR(job) {
	const {
		context,
		state,
		base,
		fixing,
	} = job;
	const token = await installationToken(context.auth, state.installationId, {
		repositoryNames: [state.name],
		permissions: { pull_requests: 'read' }, // eslint-disable-line camelcase
	});
	core.setSecret(token);
	const prState = await findPR(octokitFor(token, state.private), {
		owner: state.owner,
		name: state.name,
		base,
		branch,
	});
	const pr = 'number' in prState ? prURL(state, prState.number) : '';
	const action = {
		create: 'would create a PR',
		update: `would update ${pr}`,
		reopen: `would reopen and update ${pr}`,
	}[prState.mode];
	return `${action}: ${described(fixing)}`;
}

/**
 * Fixes one repository's README (or, in a dry run, says how it would), and returns what happened, as Markdown for one table cell.
 * @type {(context: Context, candidate: Candidate) => Promise<string>}
 */
export async function fixReadmeRepo(
	context,
	{
		state,
		categories,
	},
) {
	if (state.stateError) {
		throw new Error(state.stateError);
	}
	const plan = planReadme(state, categories);
	if (plan.text === null) {
		return ['nothing to fix', ...skips(plan.skipped)].join('<br>');
	}
	const { base } = plan;
	const job = {
		context,
		state,
		base,
		categories,
		fixing: plan.fixing,
	};
	if (context.dryRun) {
		return [await describePR(job), ...skips(plan.skipped)].join('<br>');
	}
	return openPR(job);
}
