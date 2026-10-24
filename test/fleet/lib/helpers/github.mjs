import { generateKeyPairSync } from 'crypto';

import nock from 'nock';

/**
 * A fork's parent, as far up as the query reads.
 * @typedef {{
 *   nameWithOwner: string,
 *   isArchived?: boolean,
 *   isPrivate?: boolean,
 *   parent?: ParentData | null,
 * }} ParentData
 */
/**
 * @typedef {{
 *   nameWithOwner?: string,
 *   isArchived?: boolean,
 *   isPrivate?: boolean,
 *   isFork?: boolean,
 *   parent?: ParentData | null,
 *   defaultBranchRef?: { name: string } | null,
 *   config?: { text?: string } | null,
 *   packageJson?: { text?: string } | null,
 *   workflows?: { entries?: { name: string, type: string, object?: { text?: string } | null }[] } | null,
 * }} RepositoryData
 */
/**
 * @typedef {{
 *   data?: RepositoryData,
 *   missing?: boolean,
 *   failInBatch?: boolean,
 *   failAlways?: boolean,
 * }} RepoSpec
 */
/**
 * An account's `.github` repository: with `text`, its `ljharb-actions.json` has that text; with `noFile`, the repository exists without one;
 * `error` fails the query outright; `nullData` fails it with errors and no usable partial data;
 * `partialErrors` replies with partial data (a null repository) and exactly those GraphQL errors; with `private`, the repository is private.
 * Unspecified, the repository is not found: GraphQL partial data with a NOT_FOUND error.
 * @typedef {{
 *   private?: boolean,
 *   text?: string,
 *   noFile?: boolean,
 *   error?: ErrorReply,
 *   nullData?: boolean,
 *   partialErrors?: unknown[],
 * }} AccountSpec
 */
/** @typedef {{ name: string, full_name: string, private: boolean, fork?: boolean, owner: { login: string } }} InstalledRepo */
/** @typedef {{ status: number, body?: unknown }} ErrorReply */
/**
 * @typedef {{
 *   installations?: unknown[] | ErrorReply,
 *   tokens?: Record<string, ErrorReply>,
 *   installationRepos?: Record<string, InstalledRepo[] | ErrorReply>,
 *   repos?: Record<string, RepoSpec>,
 *   accounts?: Record<string, AccountSpec>,
 *   graphqlNullData?: string[],
 *   graphqlStringData?: string[],
 *   commits?: Record<string, number | ErrorReply>,
 *   commitsDelay?: number,
 *   issues?: unknown[],
 *   created?: Record<string, unknown>,
 *   createError?: ErrorReply,
 * }} Scenario
 */
/** @typedef {{ method: string, path: string, body: any, authorization: string }} Recorded */

/** @type {string | undefined} */
let key;

// a throwaway key, only ever used to sign JWTs that the mocked API accepts
/** @type {() => string} */
export function privateKey() {
	key ??= generateKeyPairSync('rsa', {
		modulusLength: 2048,
		publicKeyEncoding: { type: 'spki', format: 'pem' },
		privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
	}).privateKey;
	return key;
}

/** @type {(owner: string, name: string, extra?: Partial<InstalledRepo>) => InstalledRepo} */
export function installedRepo(owner, name, extra = {}) {
	return {
		name,
		full_name: `${owner}/${name}`, // eslint-disable-line camelcase
		private: false,
		owner: { login: owner },
		...extra,
	};
}

/** @type {(reply: unknown) => reply is ErrorReply} */
function isErrorReply(reply) {
	return !!reply && typeof reply === 'object' && !Array.isArray(reply) && 'status' in reply;
}

/** @type {(scenario: Scenario, owner: string) => [number, unknown]} */
function accountReply(scenario, owner) {
	const spec = scenario.accounts?.[owner];
	if (!spec) {
		return [200, {
			data: { repository: null },
			errors: [{ type: 'NOT_FOUND', path: ['repository'], message: `Could not resolve to a Repository with the name '${owner}/.github'.` }],
		}];
	}
	if (spec.error) {
		return [spec.error.status, spec.error.body ?? { message: 'error' }];
	}
	if (spec.nullData) {
		return [200, { data: null, errors: [{ message: 'something went wrong' }] }];
	}
	if (spec.partialErrors) {
		return [200, { data: { repository: null }, errors: spec.partialErrors }];
	}
	return [200, { data: { repository: { isPrivate: Boolean(spec.private), defaults: spec.noFile ? null : { text: spec.text } } } }];
}

/** @type {(scenario: Scenario, variables: Record<string, string>) => [number, unknown]} */
function graphqlReply(scenario, variables) {
	if ('owner' in variables) {
		return accountReply(scenario, variables.owner);
	}
	const repos = scenario.repos ?? {};
	/** @type {string[]} */
	const names = [];
	for (let j = 0; `o${j}` in variables; j += 1) {
		names.push(`${variables[`o${j}`]}/${variables[`n${j}`]}`);
	}
	const specs = names.map((n) => repos[n] ?? { missing: true });
	if (specs.some((s) => s.failAlways || (s.failInBatch && names.length > 1))) {
		return [502, { message: 'Bad Gateway' }];
	}
	if (names.some((n) => (scenario.graphqlNullData ?? []).includes(n))) {
		return [200, { data: null, errors: [{ message: 'something went wrong' }] }];
	}
	if (names.some((n) => (scenario.graphqlStringData ?? []).includes(n))) {
		return [200, { data: 'nope', errors: [{ message: 'something odd went wrong' }] }];
	}
	/** @type {Record<string, unknown>} */
	const data = {};
	/** @type {unknown[]} */
	const errors = [];
	specs.forEach((s, j) => {
		if (s.missing) {
			data[`r${j}`] = null;
			errors.push({ type: 'NOT_FOUND', path: [`r${j}`], message: `Could not resolve to a Repository with the name '${names[j]}'.` });
		} else {
			data[`r${j}`] = { nameWithOwner: names[j], ...s.data };
		}
	});
	return [200, errors.length > 0 ? { data, errors } : { data }];
}

const tokenPrefix = 'ghs_installation_';

/**
 * Mocks the parts of the GitHub API the fleet App uses, recording every request.
 * Returns a function that removes the interceptors.
 * @type {(scenario: Scenario, record: (r: Recorded) => void) => () => void}
 */
export function mockGitHub(scenario, record) {
	const scope = nock('https://api.github.com').persist();
	/** @type {(handler: (request: { path: string, body: any, authorization: string }) => [number, unknown]) => (req: Request) => Promise<[number, unknown]>} */
	const handle = (handler) => async (req) => {
		const url = new URL(req.url);
		const path = `${url.pathname}${url.search}`;
		const text = await req.text();
		const body = text ? JSON.parse(text) : null;
		const authorization = req.headers.get('authorization') ?? '';
		record({
			method: req.method,
			path,
			body,
			authorization,
		});
		return handler({ path, body, authorization });
	};

	const interceptors = [
		scope.get(/^\/app\/installations(?:\?.*)?$/),
		scope.post(/^\/app\/installations\/\d+\/access_tokens$/),
		scope.get(/^\/installation\/repositories(?:\?.*)?$/),
		scope.post('/graphql'),
		scope.get(/^\/repos\/[^/]+\/[^/]+\/issues(?:\?.*)?$/),
		scope.post(/^\/repos\/[^/]+\/[^/]+\/issues$/),
		scope.patch(/^\/repos\/[^/]+\/[^/]+\/issues\/\d+$/),
		scope.post(/^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/),
		scope.get(/^\/repos\/[^/]+\/[^/]+\/commits(?:\?.*)?$/),
	];

	const [installations, tokens, installationRepos, graphql, listIssues, createIssue, updateIssue, comment, commits] = interceptors;

	installations.reply(handle(() => {
		const reply = scenario.installations ?? [];
		return isErrorReply(reply) ? [reply.status, reply.body ?? { message: 'error' }] : [200, reply];
	}));
	tokens.reply(handle(({ path, body }) => {
		const id = path.split('/')[3];
		const error = scenario.tokens?.[id];
		if (error) {
			return [error.status, error.body ?? { message: 'token error' }];
		}
		return [201, {
			token: `${tokenPrefix}${id}`,
			expires_at: '2099-01-01T00:00:00Z', // eslint-disable-line camelcase
			permissions: body?.permissions ?? {},
			repository_selection: 'all', // eslint-disable-line camelcase
		}];
	}));
	installationRepos.reply(handle(({ authorization }) => {
		const id = authorization.slice(authorization.indexOf(tokenPrefix) + tokenPrefix.length);
		const reply = scenario.installationRepos?.[id] ?? [];
		if (isErrorReply(reply)) {
			return [reply.status, reply.body ?? { message: 'error' }];
		}
		return [200, { total_count: reply.length, repositories: reply }]; // eslint-disable-line camelcase
	}));
	graphql.reply(handle(({ body }) => graphqlReply(scenario, body.variables)));
	listIssues.reply(handle(() => [200, scenario.issues ?? []]));
	createIssue.reply(handle(() => (scenario.createError
		? [scenario.createError.status, scenario.createError.body ?? { message: 'error' }]
		: [201, scenario.created ?? { number: 1, html_url: 'https://github.com/created/1' }]))); // eslint-disable-line camelcase
	updateIssue.reply(handle(() => [200, {}]));
	comment.reply(handle(() => [201, {}]));
	// keyed by `owner/name` as requested; unspecified, a repository has no matching commits
	const listCommits = handle(({ path }) => {
		const reply = scenario.commits?.[path.split('/').slice(2, 4).join('/')] ?? 0;
		if (isErrorReply(reply)) {
			return [reply.status, reply.body ?? { message: 'error' }];
		}
		return [200, Array.from({ length: reply }, (_, i) => ({ sha: `sha${i}` }))];
	});
	// `commitsDelay` holds each reply back that many milliseconds after the request is recorded
	commits.reply(async (/** @type {Request} */ req) => {
		const reply = await listCommits(req);
		await new Promise((resolve) => { setTimeout(resolve, scenario.commitsDelay ?? 0); });
		return reply;
	});

	return () => {
		interceptors.forEach((i) => nock.removeInterceptor(i));
	};
}
