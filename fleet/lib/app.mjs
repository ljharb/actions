import { getOctokit } from '@actions/github';
import { createAppAuth } from '@octokit/auth-app';

import { mergeConfig, parseConfig } from './config.mjs';
import { isIgnored } from './ignored.mjs';

/** @typedef {ReturnType<typeof getOctokit>} Octokit */
/** @typedef {import('./config.mjs').Config} Config */
/** @typedef {{ name: string, text: string | null }} WorkflowFile */
// an `external` state is a fork's source the App isn't installed on: its `installationId` is borrowed from the fork, for reading only
/**
 * @typedef {{
 *   owner: string,
 *   name: string,
 *   repository: string,
 *   installationId: number,
 *   private: boolean,
 *   archived: boolean,
 *   defaultBranch: string | null,
 *   config: Config,
 *   configError: string | null,
 *   stateError: string | null,
 *   packageJson: string | null,
 *   workflows: WorkflowFile[] | null,
 *   fork: boolean,
 *   source: { repository: string, archived: boolean, private: boolean } | null,
 *   external: boolean,
 * }} RepoState
 */
/** @typedef {{ scope: string, message: string }} Failure */
/** @typedef {{ name: string, full_name: string, private: boolean, fork?: boolean, owner: { login: string } }} InstalledRepo */
/** @typedef {ReturnType<typeof parseConfig> & { private?: boolean }} AccountDefaults */
/** @typedef {{ installationId: number, account: AccountDefaults, external: boolean }} Context */
/** @typedef {{ sourceAccounts?: Set<string>, committer?: string }} Options */

const batchSize = 20;

// a fork's source is the root of its network; three levels of parents covers any fork chain seen in practice
const fragment = `
fragment origin on Repository {
	nameWithOwner
	isArchived
	isPrivate
}
fragment state on Repository {
	nameWithOwner
	isArchived
	isPrivate
	isFork
	parent { ...origin parent { ...origin parent { ...origin } } }
	defaultBranchRef { name }
	config: object(expression: "HEAD:.github/ljharb-actions.json") { ... on Blob { text } }
	packageJson: object(expression: "HEAD:package.json") { ... on Blob { text } }
	workflows: object(expression: "HEAD:.github/workflows") {
		... on Tree { entries { name type object { ... on Blob { text } } } }
	}
}`;

/**
 * A failure's message for public output: an API error's text can quote what it couldn't read (eg, an organization's restrictions, or a private repository's name), so only its HTTP status and GraphQL error types are kept.
 * @type {(error: unknown) => string}
 */
export function failureMessage(error) {
	/** @type {string[]} */
	const details = [];
	if (error && typeof error === 'object') {
		if ('status' in error && typeof error.status === 'number') {
			details.push(`HTTP ${error.status}`);
		}
		if ('errors' in error && Array.isArray(error.errors)) {
			details.push(...new Set(error.errors.map((e) => e?.type).filter((type) => typeof type === 'string' && (/^[A-Z_]+$/).test(type))));
		}
	}
	return `could not be read${details.length > 0 ? ` (${details.join(', ')})` : ''}`;
}

/** @type {(appId: string, privateKey: string) => ReturnType<typeof createAppAuth>} */
export function appAuth(appId, privateKey) {
	return createAppAuth({ appId, privateKey });
}

/** @type {(auth: ReturnType<typeof createAppAuth>) => Promise<Octokit>} */
export async function appOctokit(auth) {
	const { token } = await auth({ type: 'app' });
	return getOctokit(token);
}

/** @type {(auth: ReturnType<typeof createAppAuth>, installationId: number, options?: { repositoryNames?: string[], permissions?: Record<string, string> }) => Promise<string>} */
export async function installationToken(auth, installationId, options = {}) {
	const { token } = await auth({
		type: 'installation',
		installationId,
		...options,
	});
	return token;
}

// a public App can be installed by anyone, so only accounts listed here are ever processed
/** @type {(list: string, fallback: string) => Set<string>} */
export function parseAccounts(list, fallback) {
	const accounts = list.split(/[\s,]+/).map((a) => a.trim().toLowerCase()).filter(Boolean);
	return new Set(accounts.length > 0 ? accounts : [fallback.toLowerCase()].filter(Boolean));
}

/** @type {(entries: { name: string, type: string, object?: { text?: string } }[] | undefined) => WorkflowFile[] | null} */
function workflowFiles(entries) {
	return entries
		? entries.filter((e) => e.type === 'blob').map((e) => ({ name: e.name, text: e.object?.text ?? null }))
		: null;
}

/** @type {(repo: Record<string, any> | null | undefined) => RepoState['source']} */
function forkSource(repo) {
	let root = repo?.isFork ? repo.parent : null;
	while (root?.parent) {
		root = root.parent;
	}
	return root ? {
		repository: root.nameWithOwner, archived: Boolean(root.isArchived), private: Boolean(root.isPrivate),
	} : null;
}

/** @type {(context: Context, r: InstalledRepo, repo: Record<string, any> | null | undefined) => RepoState} */
function toState({
	installationId, account, external,
}, r, repo) {
	const own = parseConfig(repo?.config?.text, '`.github/ljharb-actions.json`');
	const isPrivate = Boolean(r.private || repo?.isPrivate);
	// a private `.github` repository's defaults (and their errors) apply only to private repositories: any effect on a public one's public report would show what's in a private file
	const inherited = account.private && !isPrivate ? parseConfig(null, '') : account;
	const config = mergeConfig(inherited.config, own.config);
	// an account's `.github` repository holds its defaults, and usually has no workflows of its own, so it's only checked when its own file asks for that
	if (r.name.toLowerCase() === '.github' && !('workflows' in own.config)) {
		config.workflows = false;
	}
	return {
		owner: r.owner.login,
		name: r.name,
		repository: r.full_name,
		installationId,
		private: isPrivate,
		archived: Boolean(repo?.isArchived),
		defaultBranch: repo?.defaultBranchRef?.name ?? null,
		config,
		configError: [inherited.error, own.error].filter(Boolean).join('; ') || null,
		stateError: repo ? null : 'could not read the repository’s state',
		packageJson: repo?.packageJson?.text ?? null,
		workflows: workflowFiles(repo?.workflows?.entries),
		fork: Boolean(r.fork || repo?.isFork),
		source: forkSource(repo),
		external,
	};
}

/** @type {(error: unknown) => Record<string, any>} */
function partialData(error) {
	if (error && typeof error === 'object' && 'data' in error && error.data && typeof error.data === 'object') {
		return /** @type {Record<string, any>} */ (error.data); // eslint-disable-line no-extra-parens
	}
	throw error;
}

/** @type {(octokit: Octokit, batch: InstalledRepo[]) => Promise<Record<string, any>>} */
async function query(octokit, batch) {
	const variables = Object.fromEntries(batch.flatMap((r, j) => [[`o${j}`, r.owner.login], [`n${j}`, r.name]]));
	const text = `query(${batch.map((_, j) => `$o${j}: String!, $n${j}: String!`).join(', ')}) {
		${batch.map((_, j) => `r${j}: repository(owner: $o${j}, name: $n${j}) { ...state }`).join('\n')}
	}
	${fragment}`;
	// one inaccessible repo fails the whole query, but the rest of the batch is still in the partial data
	return octokit.graphql(text, variables).catch(partialData);
}

// a failed batch (a 502, a timeout) is retried one repo at a time, so only a repo that itself fails is lost
/** @type {(octokit: Octokit, context: Context, batch: InstalledRepo[]) => Promise<RepoState[]>} */
async function batchStates(octokit, context, batch) {
	try {
		const data = await query(octokit, batch);
		return batch.map((r, j) => toState(context, r, data[`r${j}`]));
	} catch {
		return Promise.all(batch.map(async (r) => toState(context, r, await query(octokit, [r]).then((data) => data.r0, () => null))));
	}
}

/** @type {(error: unknown) => boolean} */
function onlyNotFound(error) {
	/** @type {unknown[]} */
	const errors = error && typeof error === 'object' && 'errors' in error && Array.isArray(error.errors) ? error.errors : [];
	return errors.length > 0 && errors.every((e) => typeof e === 'object' && e !== null && 'type' in e && e.type === 'NOT_FOUND');
}

// an account without a readable `.github` repository just has no defaults
/** @type {(octokit: Octokit, owner: string) => Promise<AccountDefaults>} */
async function accountDefaults(octokit, owner) {
	const data = await octokit.graphql(`query($owner: String!) {
		repository(owner: $owner, name: ".github") {
			isPrivate
			defaults: object(expression: "HEAD:ljharb-actions.json") { ... on Blob { text } }
		}
	}`, { owner }).catch((error) => {
		// a blocked read (eg, SSO or an IP allow list) must not silently drop the account's opt-outs
		if (onlyNotFound(error)) {
			return partialData(error);
		}
		throw error;
	});
	const parsed = parseConfig(data?.repository?.defaults?.text, `\`${owner}/.github\`’s \`ljharb-actions.json\``);
	if (!data?.repository?.isPrivate) {
		return parsed;
	}
	// only the account's private repositories use these defaults, and none of their errors are shown, but a private file's is still never more specific than this
	return {
		config: parsed.config, error: parsed.error && 'the account’s defaults are invalid', private: true,
	};
}

/** @type {(installation: { account?: unknown }) => string} */
function accountLogin({ account }) {
	return account && typeof account === 'object' && 'login' in account && typeof account.login === 'string' ? account.login : '';
}

/** @type {(auth: ReturnType<typeof createAppAuth>, installationId: number) => Promise<Octokit>} */
async function readOctokit(auth, installationId) {
	return getOctokit(await installationToken(auth, installationId, { permissions: { contents: 'read', metadata: 'read' } }));
}

/** @type {(auth: ReturnType<typeof createAppAuth>, installation: { id: number, account?: unknown }) => Promise<RepoState[]>} */
async function installationStates(auth, installation) {
	const octokit = await readOctokit(auth, installation.id);
	const repos = (await octokit.paginate('GET /installation/repositories', { per_page: 100 })) // eslint-disable-line camelcase
		.filter((r) => !isIgnored(r.full_name));
	if (repos.length === 0) {
		return [];
	}
	const context = {
		installationId: installation.id, account: await accountDefaults(octokit, accountLogin(installation)), external: false,
	};
	const states = [];
	// one batch at a time per installation, to stay well clear of GraphQL rate and resource limits
	for (let i = 0; i < repos.length; i += batchSize) {
		states.push(...await batchStates(octokit, context, repos.slice(i, i + batchSize))); // eslint-disable-line no-await-in-loop
	}
	return states;
}

// the App can't see anyone's permissions on a repository it isn't installed on, so a commit whose committer is `committer` stands in for write access; that also counts their commits in PRs merged with a merge commit, so the allowed source accounts are the real gate
/** @type {(octokit: Octokit, repository: string, committer: string) => Promise<boolean>} */
async function hasCommitted(octokit, repository, committer) {
	const [owner, repo] = repository.split('/');
	try {
		const { data } = await octokit.rest.repos.listCommits({
			owner, repo, committer, per_page: 1, // eslint-disable-line camelcase
		});
		return data.length > 0;
	} catch (error) {
		// an empty repository
		if (error && typeof error === 'object' && 'status' in error && error.status === 409) {
			return false;
		}
		throw error;
	}
}

/** @typedef {{ repository: string, installationId: number }} Candidate */

// a fork's source, when it's public, unarchived, not ignored, and in an allowed account the App has no installation on at all (an installed account's repositories are its own business, even when its installation failed)
/** @type {(installed: RepoState[], sourceAccounts: Set<string>, installedAccounts: Set<string>) => Candidate[]} */
function sourceCandidates(installed, sourceAccounts, installedAccounts) {
	/** @type {Map<string, Candidate>} */
	const candidates = new Map();
	// a private fork's source isn't checked either: that it's checked at all would show the fork exists
	for (const {
		source, installationId, private: isPrivate,
	} of installed) {
		const key = source?.repository.toLowerCase() ?? '';
		const owner = key.split('/')[0];
		if (source && !isPrivate && !source.archived && !source.private && !isIgnored(key) && sourceAccounts.has(owner) && !installedAccounts.has(owner) && !candidates.has(key)) {
			candidates.set(key, { repository: source.repository, installationId });
		}
	}
	return [...candidates.values()];
}

// forks are never checked themselves; their sources are, when `committer` has committed to them
/** @type {(auth: ReturnType<typeof createAppAuth>, installed: RepoState[], options: Required<Options> & { installedAccounts: Set<string> }) => Promise<{ states: RepoState[], failures: Failure[] }>} */
async function sourceStates(auth, installed, {
	sourceAccounts, committer, installedAccounts,
}) {
	const candidates = committer ? sourceCandidates(installed, sourceAccounts, installedAccounts) : [];
	/** @type {Failure[]} */
	const failures = [];
	/** @type {Candidate[]} */
	const committed = [];
	// one at a time, to stay clear of secondary rate limits
	for (const candidate of candidates) {
		try {
			if (await hasCommitted(await readOctokit(auth, candidate.installationId), candidate.repository, committer)) { // eslint-disable-line no-await-in-loop
				committed.push(candidate);
			}
		} catch (error) {
			failures.push({ scope: `source ${candidate.repository}`, message: error instanceof Error ? error.message : String(error) });
		}
	}

	const account = parseConfig(null, '');
	const states = [];
	// any installation can read a public repository; each source keeps its own fork's installation, though nothing may write with it
	for (let i = 0; i < committed.length; i += batchSize) {
		const batch = committed.slice(i, i + batchSize);
		const octokit = await readOctokit(auth, batch[0].installationId); // eslint-disable-line no-await-in-loop
		const repos = batch.map(({ repository }) => {
			const [owner, name] = repository.split('/');
			return {
				name, full_name: repository, private: false, fork: false, owner: { login: owner }, // eslint-disable-line camelcase
			};
		});
		const context = {
			installationId: batch[0].installationId, account, external: true,
		};
		const batchResults = await batchStates(octokit, context, repos); // eslint-disable-line no-await-in-loop
		states.push(...batchResults.map((state, j) => ({ ...state, installationId: batch[j].installationId })));
	}
	return { states: states.filter((s) => !s.fork), failures };
}

/** @type {(auth: ReturnType<typeof createAppAuth>, accounts: Set<string>, options?: Options) => Promise<{ states: RepoState[], failures: Failure[] }>} */
export async function discover(auth, accounts, { sourceAccounts = new Set(), committer = '' } = {}) {
	const app = await appOctokit(auth);
	const installations = await app.paginate('GET /app/installations', { per_page: 100 }); // eslint-disable-line camelcase

	/** @type {Failure[]} */
	const failures = [];
	const allowed = installations.filter((i) => {
		const login = accountLogin(i);
		if (!accounts.has(login.toLowerCase())) {
			// this is logged, and listed in the public drift issue, but an account that isn't allowed may have installed the App only on its private repositories, so its login isn't named
			failures.push({ scope: `installation ${i.id}`, message: 'its account is not in the allowed accounts; skipped' });
			return false;
		}
		return !i.suspended_at;
	});

	const states = await Promise.all(allowed.map((installation) => installationStates(auth, installation).catch((error) => {
		failures.push({ scope: `installation ${installation.id}`, message: failureMessage(error) });
		return [];
	})));

	const installed = states.flat();
	const installedAccounts = new Set(installations.map((i) => accountLogin(i).toLowerCase()));
	const sources = await sourceStates(auth, installed, {
		sourceAccounts, committer, installedAccounts,
	});

	return {
		states: [...installed.filter((s) => !s.fork), ...sources.states].sort((a, b) => a.repository.localeCompare(b.repository)),
		failures: [...failures, ...sources.failures.sort((a, b) => a.scope.localeCompare(b.scope))],
	};
}
