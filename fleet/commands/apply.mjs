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

import { planFixes } from '../drift/fix.mjs';
import { installationToken, octokitFor } from '../lib/app.mjs';
import { code } from '../lib/markdown.mjs';
import {
	botIdentity,
	checkout,
	findPR,
	prepareBranch,
	publish,
	remoteHasBranch,
} from '../lib/pr.mjs';

/** @typedef {import('../lib/app.mjs').RepoState} RepoState */
/** @typedef {import('../lib/pr.mjs').Identity} Identity */
/** @typedef {import('../drift/check.mjs').Result} Result */
/** @typedef {import('../drift/fix.mjs').Plan} Plan */
/** @typedef {import('../drift/fix.mjs').Category} Category */
/** @typedef {{ state: RepoState, result: Result | null, files: Set<string> | undefined }} Candidate */
/**
 * @typedef {{
 *   auth: ReturnType<typeof import('../lib/app.mjs').appAuth>,
 *   identities: Map<number, Promise<Identity>>,
 *   dryRun: boolean,
 *   categories: Set<Category>,
 *   link: string,
 * }} Context
 */
/** @typedef {{ context: Context, state: RepoState, plan: Plan, base: string }} Job */

export const branch = 'fleet/workflows';
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
};

/** @type {(plan: Plan) => string[]} */
function changes({ writes, deletes }) {
	return [
		...writes.map((w) => `${code(w.path)}: ${reasons[/** @type {keyof typeof reasons} */ (w.reason)]}`), // eslint-disable-line no-extra-parens
		...deletes.map((d) => `${code(d.path)}: deleted, since it’s unexpected`),
	];
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
	for (const { path: file, content } of writes) {
		const to = target(dir, file);
		mkdirSync(path.dirname(to), { recursive: true });
		// the file itself may be a symbolic link too: it's replaced, not written through, so the PR turns it into a regular file
		rmSync(to, { force: true });
		writeFileSync(to, content);
	}
	for (const { path: file } of deletes) {
		rmSync(target(dir, file), { force: true });
	}
}

/** @type {(job: Job) => Promise<string>} */
async function openPR({
	context, state, plan, base,
}) {
	const {
		owner, name, installationId,
	} = state;
	const planned = new Set([...plan.writes, ...plan.deletes].map((c) => c.path));
	/** @type {(file: string) => boolean} */
	const isPlanned = (file) => planned.has(file);
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
			owner, name, base, branch,
		});
		const hasBranch = remoteHasBranch(git, branch);
		prepareBranch(git, {
			state: prState,
			base,
			branch,
			remoteHasBranch: hasBranch,
			regenerated: isPlanned,
		});
		write(clone, plan);
		git([
			'add', '--all', '--', '.github/workflows',
		]);
		if (git([
			'diff', '--cached', '--quiet',
		], { allowFailure: true }).status !== 0) {
			git([
				'commit', '--quiet', '--message', message,
			]);
		}
		// the default branch moved on since it was checked, and already has these changes
		if (git([
			'diff', '--quiet', `origin/${base}`, 'HEAD',
		], { allowFailure: true }).status === 0) {
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
			remoteHasBranch: hasBranch,
			identity,
			allowed: isPlanned,
			title,
			body: prBody(plan, context.link),
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** @type {(job: Job) => Promise<string>} */
async function describePR({
	context, state, plan, base,
}) {
	const token = await installationToken(context.auth, state.installationId, {
		repositoryNames: [state.name],
		permissions: { pull_requests: 'read' }, // eslint-disable-line camelcase
	});
	core.setSecret(token);
	const prState = await findPR(octokitFor(token, state.private), {
		owner: state.owner, name: state.name, base, branch,
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
export async function fixRepo(context, {
	state, result, files,
}) {
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
	const base = state.defaultBranch;
	if (!base) {
		throw new Error('the repository has no default branch');
	}
	const outcome = await (context.dryRun ? describePR : openPR)({
		context, state, plan, base,
	});
	return [outcome, ...skips(plan)].join('<br>');
}
