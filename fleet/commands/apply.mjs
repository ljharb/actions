import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import * as core from '@actions/core';

import { checkRepo } from '../drift/check.mjs';
import { planFixes } from '../drift/fix.mjs';
import { installationToken, octokitFor } from '../lib/app.mjs';
import { fixBranch } from '../lib/branches.mjs';
import {
	configFile,
	keptConfig,
	keptOnBranch,
	withKept,
} from '../lib/kept.mjs';
import { code } from '../lib/markdown.mjs';
import {
	hasConfig,
	packageJson,
	packageJsonAt,
	syncConfigIgnore,
} from '../lib/npmignore.mjs';
import {
	botIdentity,
	checkout,
	commitChanges,
	findPR,
	publish,
	remoteTip,
} from '../lib/pr.mjs';

/** @import { RepoState, appAuth } from '../lib/app.mjs' */
/** @import { Identity } from '../lib/pr.mjs' */
/** @import { Result } from '../drift/check.mjs' */
/** @import { Plan, Category } from '../drift/fix.mjs' */
/** @typedef {{ state: RepoState, result: Result | null, files: Set<string> | undefined }} Candidate */
/**
 * @typedef {{
 *   auth: ReturnType<typeof appAuth>,
 *   identities: Map<number, Promise<Identity>>,
 *   dryRun: boolean,
 *   categories: Set<Category>,
 *   link: string,
 * }} Context
 */
/** @typedef {{ context: Context, state: RepoState, plan: Plan, base: string, files: Set<string> | undefined }} Job */
/** @import { Git } from '../lib/pr.mjs' */

export const branch = fixBranch;
const title = '[actions] update workflow files to match the shared templates';
const message = '[actions] update workflow files to match ljharb/actions’ templates';

const {
	GITHUB_SERVER_URL = 'https://github.com',
	GITHUB_REPOSITORY = '',
} = process.env;

/** @type {Record<Exclude<Plan['writes'][number]['reason'], 'unexpected'>, string>} */
const reasons = {
	missing: 'added, since it’s missing',
	drifted: 'rewritten from its template, since it has drifted',
	range: 'its node version range now ends where an added file’s starts',
	kept: 'keeps the inputs this PR put back when its CI failed, so they aren’t removed again',
	ignored: `adds ${code(configFile)} to \`publishConfig.ignore\`, so that \`npmignore\` keeps it out of the published package`,
	unignored: `removes ${code(configFile)} from \`publishConfig.ignore\`, since there’s no such file`,
};

/** @type {(plan: Plan) => string[]} */
function changes({ writes, deletes }) {
	return [
		...writes.map((w) => `${code(w.path)}: ${reasons[/** @type {keyof typeof reasons} */ (w.reason)]}`),
		...deletes.map((d) => `${code(d.path)}: deleted, since it’s unexpected`),
	];
}

/**
 * Adds to a plan that changes anything the edit to `package.json` that keeps the config file out of the published package, or that stops ignoring it once it won't exist, when it's needed (see `syncConfigIgnore`): the config file will exist when the plan writes it, or the repository has it (no plan deletes it).
 * A `package.json` that isn't a regular file (eg, an executable one, which writing it would change) is never edited.
 * @type {(plan: Plan, state: RepoState) => Promise<void>}
 */
async function planIgnored(
	plan,
	{
		packageJson: text,
		packageJsonRegular,
		hasConfig: configExists,
	},
) {
	if (plan.writes.length + plan.deletes.length === 0) {
		return;
	}
	const synced = await syncConfigIgnore(packageJsonRegular ? text : null, configExists || plan.writes.some((w) => w.path === configFile));
	if (synced !== null) {
		plan.writes.push({ path: packageJson, ...synced });
	}
}

/** @type {(plan: Plan) => string[]} */
function skips({ skipped }) {
	return skipped.map((s) => `left as it is: ${code(s.path)}: ${code(s.why)}`);
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

/** @type {(plan: Plan, link: string) => string} */
function prBody(plan, link) {
	return [
		`This makes these workflow files match the templates in [\`${GITHUB_REPOSITORY}\`’s \`fleet/drift/templates\`](${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/tree/HEAD/fleet/drift/templates), as asked in [this comment](${link}):`,
		'',
		...changes(plan).map((c) => `- ${c}`),
		...plan.skipped.length > 0 ? [
			'',
			'These are left as they are:',
			'',
			...plan.skipped.map((s) => `- ${code(s.path)}: ${code(s.why)}`),
		] : [],
	].join('\n');
}

/**
 * Where in the clone a planned file is.
 * Git checks a symbolic link out as one, so a directory on the way to it that's a link could lead anywhere, even out of the clone: that's refused.
 * @type {(dir: string, file: string) => string}
 */
function target(dir, file) {
	const parts = file.split('/');
	for (let i = 1; i < parts.length; i += 1) {
		const parent = parts.slice(0, i).join('/');
		if (lstatSync(path.join(dir, parent), { throwIfNoEntry: false })?.isSymbolicLink()) {
			throw new Error(`\`${parent}\` is a symbolic link, so nothing is written through it`);
		}
	}
	return path.join(dir, file);
}

/** @type {(dir: string, plan: Plan) => void} */
function write(dir, { writes, deletes }) {
	writes.forEach(({ path: file, content }) => {
		const to = target(dir, file);
		mkdirSync(path.dirname(to), { recursive: true });
		// the file itself may be a symbolic link too: it's replaced, not written through, so the PR turns it into a regular file
		rmSync(to, { force: true });
		writeFileSync(to, content);
	});
	deletes.forEach(({ path: file }) => {
		rmSync(target(dir, file), { force: true });
	});
}

/**
 * The repository's state as its clone (at the base's current tip) has it, which may have moved on since it was read: so that the PR is planned from what it will be applied to.
 * As GitHub's API does, a symbolic link's text is its target, and anything in `.github/workflows` that isn't a file (eg, a directory) isn't one of its workflows.
 * @type {(git: Git, state: RepoState) => RepoState}
 */
function cloneState(git, state) {
	/** @type {(file: string) => string | null} */
	const show = (file) => {
		const shown = git(['show', `HEAD:${file}`], { allowFailure: true });
		return shown.status === 0 ? shown.stdout : null;
	};
	const entries = git([
		'ls-tree',
		'-z',
		'HEAD',
		'.github/workflows/',
	]).stdout.split('\0').filter(Boolean).map((line) => {
		const [info, file] = line.split('\t');
		return { type: info.split(' ')[1], file };
	});
	return {
		...state,
		packageJson: show('package.json'),
		packageJsonRegular: packageJsonAt(git, 'HEAD') !== null,
		hasConfig: hasConfig(git, 'HEAD'),
		workflows: entries.filter((e) => e.type === 'blob').map(({ file }) => ({ name: path.posix.basename(file), text: show(file) })),
	};
}

/** @type {(job: Job) => Promise<string>} */
async function openPR({
	context,
	state,
	base,
	files,
}) {
	const {
		owner,
		name,
		installationId,
	} = state;
	const token = await installationToken(context.auth, installationId, {
		repositoryNames: [name],
		permissions: {
			contents: 'write',
			pull_requests: 'write', // eslint-disable-line camelcase
			workflows: 'write',
		},
	});
	core.setSecret(token);
	const octokit = octokitFor(token, state.private);
	const identity = await identityFor(context, installationId);

	const dir = mkdtempSync(path.join(process.env.RUNNER_TEMP || tmpdir(), 'fleet-fix-'));
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
		const current = cloneState(git, state);
		// what the App's PR keeps that its base doesn't (the inputs it put back when its CI failed) is kept again, with the base's values, so that rebuilding it never removes them again
		const carried = prState.mode !== 'create' && tip ? keptOnBranch(git, { base, tip }) : new Map();
		const config = carried.size > 0 ? keptConfig(git, 'HEAD', carried) : null;
		const kept = config === null ? current : { ...current, config: { ...current.config, keep: withKept(current.config.keep, carried) } };
		const plan = await planFixes(kept, await checkRepo(kept), { files, categories: context.categories });
		if (config !== null && plan.writes.length + plan.deletes.length > 0) {
			plan.writes.unshift({
				path: configFile,
				content: config,
				reason: 'kept',
			});
		}
		await planIgnored(plan, current);
		const planned = new Set([...plan.writes, ...plan.deletes].map((c) => c.path));
		write(clone, plan);
		// the default branch moved on since it was checked, and already has these changes
		if (!commitChanges(git, {
			base,
			message,
			paths: ['.github/workflows'].concat([configFile, packageJson].filter((file) => planned.has(file))),
			allowed: (file) => planned.has(file),
		})) {
			return `nothing to fix: ${code(base)} already matches`;
		}
		return await publish({
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
			body: prBody(plan, context.link),
			isPrivate: state.private,
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** @type {(job: Job) => Promise<string>} */
async function describePR({
	context,
	state,
	plan,
	base,
}) {
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
	const pr = 'number' in prState ? `${GITHUB_SERVER_URL}/${state.repository}/pull/${prState.number}` : '';
	const action = {
		create: 'would create a PR',
		update: `would update ${pr}`,
		reopen: `would reopen and update ${pr}`,
	}[prState.mode];
	return [action, ...changes(plan)].join('<br>');
}

/**
 * Fixes one repository (or, in a dry run, says how it would), and returns what happened, as Markdown for one table cell.
 * @type {(context: Context, candidate: Candidate) => Promise<string>}
 */
export async function fixRepo(
	context,
	{
		state,
		result,
		files,
	},
) {
	if (state.stateError) {
		throw new Error(state.stateError);
	}
	// a named repository that none of the other filters match
	if (files?.size === 0) {
		return 'nothing to fix';
	}
	const plan = await planFixes(state, result, { files, categories: context.categories });
	if (plan.writes.length === 0 && plan.deletes.length === 0) {
		return ['nothing to fix', ...skips(plan)].join('<br>');
	}
	await planIgnored(plan, state);
	const base = state.defaultBranch;
	if (!base) {
		throw new Error('the repository has no default branch');
	}
	const outcome = await (context.dryRun ? describePR : openPR)({
		context,
		state,
		plan,
		base,
		files,
	});
	return [outcome, ...skips(plan)].join('<br>');
}
