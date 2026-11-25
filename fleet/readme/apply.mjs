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
	fixedReadme,
	npmReadme,
	readmePath,
} from './readme.mjs';

/** @import { Octokit, RepoState, appAuth } from '../lib/app.mjs' */
/** @import { Git, Identity, PRState } from '../lib/pr.mjs' */
/** @import { Category, Skip } from './readme.mjs' */
/** @typedef {{ state: RepoState, categories: Set<Category> | undefined }} Candidate */
/**
 * What `/fix` changes in a README, which is the file `name`: with `rename`, it's renamed to `readmePath`, in a commit of its own; with `text`, that's what it's made, after any rename.
 * @typedef {{ name: string, rename: boolean, text: string | null }} Change
 */
/**
 * @typedef {{
 *   auth: ReturnType<typeof appAuth>,
 *   identities: Map<number, Promise<Identity>>,
 *   dryRun: boolean,
 *   link: string,
 * }} Context
 */
/** @typedef {{ context: Context, state: RepoState, base: string, categories: Set<Category> | undefined, fixing: Category[], name: string }} Job */

export const branch = readmeBranch;
const title = '[readme] update the heading and badges to match the fleet’s';
const message = title;

const {
	GITHUB_SERVER_URL = 'https://github.com',
	GITHUB_REPOSITORY = '',
} = process.env;

/** @type {(name: string) => string} */
function renameTitle(name) {
	return `[readme] rename ${code(name)} to ${code(readmePath)}`;
}

/** @type {Record<Exclude<Category, 'filename'>, string>} */
const changes = {
	heading: 'the heading',
	badges: 'the badges under it',
	links: 'the link definitions they use',
};

/** @type {(category: Category, name: string) => string} */
function change(category, name) {
	return category === 'filename' ? `renaming ${code(name)} to ${code(readmePath)}` : changes[category];
}

/** @type {(categories: Category[], name: string) => string} */
function described(categories, name) {
	return categories.map((c) => change(c, name)).join(', ');
}

/** @type {(base: string, name: string) => string} */
function matched(base, name) {
	return `${code(base)}’s ${code(name)} already matches`;
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

/**
 * The PR's title: its rename's, when that's all it does; with a rename, that and its fix's.
 * @type {(fixing: Category[], name: string) => string}
 */
function prTitle(fixing, name) {
	if (!fixing.includes('filename')) {
		return title;
	}
	return fixing.length === 1 ? renameTitle(name) : `${renameTitle(name)}, and ${title.slice('[readme] '.length)}`;
}

/**
 * What a PR that renames the README does after the rename, in its second commit, if it has one (`count` is how many it has): fixes what else drifted, or, with nothing else, writes its `[package-url]` on `npmjs.com` (see `fixedReadme`).
 * @type {(fixes: boolean, count: number) => string}
 */
function afterRename(fixes, count) {
	if (fixes) {
		return ', then makes its heading, the badges under it, and the link definitions they use match the fleet’s';
	}
	return count > 1 ? ', then writes its `[package-url]` definition on `npmjs.com`, as the fleet’s is' : '';
}

/** @type {(described: { fixing: Category[], skipped: Skip[], link: string, name: string, count: number }) => string} */
function prBody({
	fixing,
	skipped,
	link,
	name,
	count,
}) {
	const report = `see [\`${GITHUB_REPOSITORY}\`’s README drift report](${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/tree/HEAD/fleet/readme)`;
	const intro = fixing.includes('filename')
		? `This renames ${code(name)}, which npm takes as the package’s README, to ${code(readmePath)}, in a commit of its own, so that git always follows the rename${afterRename(fixing.some((c) => c !== 'filename'), count)} (${report}), as asked in [this comment](${link}):`
		: `This makes ${code(name)}’s heading, the badges under it, and the link definitions they use match the fleet’s (${report}), as asked in [this comment](${link}):`;
	return [intro, ''].concat(
		fixing.map((c) => `- ${change(c, name)}`),
		skipped.length > 0 ? [
			'',
			'These are left as they are:',
			'',
		].concat(skipped.map((s) => `- ${s.why}`)) : [],
	).join('\n');
}

/**
 * What `/fix` would change in `state`'s README, limited to `categories` (unspecified: all of them), as it is in `state`: the kinds of discrepancy it fixes, the change (see `Change`; with the default branch it's for), and what it can't fix. A README that can't be fixed at all (see `identityOf` and `unreadable`) is left as it is, saying why, as the drift report already does: like a workflow file `/fix` can't plan, it's nothing to fix, not a failure.
 * @type {(state: RepoState, categories: Set<Category> | undefined) => { fixing: Category[], change: null, skipped: Skip[] } | { fixing: Category[], change: Change, skipped: Skip[], base: string }}
 */
export function planReadme(state, categories) {
	const known = identityOf(state);
	if ('error' in known) {
		return {
			fixing: [],
			change: null,
			skipped: [{ why: known.error }],
		};
	}
	const why = unreadable(state);
	if (why !== null || state.readme === null || state.readmeName === null) {
		// `unreadable` always says why when there's no README
		return {
			fixing: [],
			change: null,
			skipped: [why].filter((w) => w !== null).map((w) => ({ why: w })),
		};
	}
	const found = drift(state.readme, known.identity, state.readmeName).filter((c) => !categories || categories.size === 0 || categories.has(c));
	if (found.length === 0) {
		return {
			fixing: [], change: null, skipped: [],
		};
	}
	const rename = found.includes('filename');
	const { text, skipped } = fixedReadme(state.readme, known.identity, found);
	if (!rename && text === state.readme) {
		return {
			fixing: found,
			change: null,
			skipped,
		};
	}
	return {
		fixing: found,
		change: {
			name: state.readmeName,
			rename,
			text: text === state.readme ? null : text,
		},
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
	// each entry at the root: its mode, its type, and its object, then a tab, then its name
	const entries = git([
		'ls-tree',
		'-z',
		'HEAD',
	]).stdout.split('\0').filter(Boolean).map((line) => {
		const [info, name] = line.split('\t');
		const [mode, type] = info.split(' ');
		return {
			name,
			mode,
			directory: type === 'tree' || type === 'commit',
		};
	});
	const { name, ambiguous } = npmReadme(entries);
	return {
		...state,
		packageJson: show('package.json'),
		readme: show(name ?? readmePath),
		readmeName: name,
		readmeAmbiguous: ambiguous,
		readmeRegular: entries.some((e) => e.name === name && e.mode === '100644'),
	};
}

/**
 * Where the README, `name`, is in the clone: refused when it's a symbolic link, which would be written through (or, renamed, committed as one), since `unreadable` only checked it as it was read (see `cloneState`, which checks it again).
 * @type {(dir: string, name: string) => string}
 */
function readmeIn(dir, name) {
	const file = path.join(dir, name);
	if (lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) {
		throw new Error(`\`${name}\` is a symbolic link, so nothing is written through it`);
	}
	return file;
}

/**
 * Commits `change` in the clone, on `base`'s tip: a rename first, on its own (only `git mv`, so that git always takes it for a rename, however much the text then changes), then the new text, if any, in the README wherever it then is. Returns how many commits it made.
 * @type {(git: Git, options: { dir: string, base: string, change: Change }) => number}
 */
function commitChange(git, {
	dir,
	base,
	change: {
		name,
		rename,
		text,
	},
}) {
	readmeIn(dir, name);
	if (rename) {
		git([
			'mv',
			'--',
			name,
			readmePath,
		]);
		commitChanges(git, {
			base,
			message: renameTitle(name),
			paths: [readmePath],
			allowed: (file) => file === name || file === readmePath,
		});
	}
	const file = rename ? readmePath : name;
	if (text !== null) {
		writeFileSync(readmeIn(dir, file), text);
	}
	const fixed = text !== null && commitChanges(git, {
		base,
		message,
		paths: [file],
		allowed: (changed) => changed === file,
		commits: Number(rename),
	});
	return Number(rename) + Number(fixed);
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
	const {
		state,
		base,
		name,
	} = job;
	if (prState.mode !== 'update' || isFiltered(job)) {
		return `nothing to fix: ${matched(base, name)}`;
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
		body: `${matched(base, name)} what this PR would make it, so the App closes it.`,
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
	return `closed ${prURL(state, prState.number)}: ${matched(base, name)}`;
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
		// the PR's commits only change the README, but pushing its branch onto the base's tip makes the base's own commits reachable from it, and GitHub refuses that from an App without Workflows (write) when any of them changes a workflow file
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
		// the PR is always on the base's current tip, with the whole change, planned again from there: one commit, but for a rename, which is a commit of its own, before it
		const cloned = cloneState(git, state);
		const readme = cloned.readmeName ?? readmePath;
		const plan = planReadme(cloned, categories);
		// its README changed since it was read, so that it can't be fixed at all (eg, it's gone, or became a symbolic link): that's not its base matching, so the PR is left as it is
		if (plan.change === null && plan.fixing.length === 0 && plan.skipped.length > 0) {
			return ['nothing to fix', ...skips(plan.skipped)].join('<br>');
		}
		const count = plan.change === null ? 0 : commitChange(git, {
			dir: clone,
			base,
			change: plan.change,
		});
		if (count === 0) {
			return await closeMatched({
				job: { ...job, name: readme },
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
				title: prTitle(plan.fixing, readme),
				body: prBody({
					fixing: plan.fixing,
					skipped: plan.skipped,
					link: context.link,
					name: readme,
					count,
				}),
				isPrivate: state.private,
				count,
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
	return `${action}: ${described(fixing, job.name)}`;
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
	if (plan.change === null) {
		return ['nothing to fix', ...skips(plan.skipped)].join('<br>');
	}
	const { base } = plan;
	const job = {
		context,
		state,
		base,
		categories,
		fixing: plan.fixing,
		name: plan.change.name,
	};
	if (context.dryRun) {
		return [await describePR(job), ...skips(plan.skipped)].join('<br>');
	}
	return openPR(job);
}
