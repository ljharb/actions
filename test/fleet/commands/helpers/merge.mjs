import nock from 'nock';

/** @import { ErrorReply, Recorded } from '../../lib/helpers/github.mjs' */
/**
 * What GitHub says about CI on one commit: its check runs, each with its annotations (from which its `output.annotations_count` is filled in, unless it has one), its check suites, its commit statuses, and the workflow runs on it (unless they say otherwise, completed as a success), each with its jobs; or `error`, for every request about it.
 * @typedef {{
 *   checkRuns?: (Record<string, unknown> & { annotations?: Record<string, unknown>[] })[],
 *   checkSuites?: Record<string, unknown>[],
 *   statuses?: Record<string, unknown>[],
 *   runs?: ({ id: number, jobs: Record<string, unknown>[] } & Record<string, unknown>)[],
 *   error?: ErrorReply,
 * }} CI
 */
/**
 * The parts of the GitHub API only `/merge` and the merge queue use:
 * - `openPulls`, keyed by `owner/name`: the open PRs listing them returns, narrowed by `head` as GitHub does (by the head repository's owner, and its branch)
 * - `prs`, keyed by `owner/name#number`: a PR, or an error
 * - `refs`, keyed by `owner/name`: the tip of every branch (unspecified, `base0`), or an error reading it
 * - `ci`, keyed by commit: its CI (unspecified, nothing at all)
 * - `commits`, keyed by `owner/name#number`: the PR's commits, of which GitHub lists only the first 250 (unspecified, one: the head of the PR in `prs` or `openPulls`, by the App's bot; none, without such a PR)
 * - `refUpdates`, keyed by `owner/name`: an error that updating a ref replies with (unspecified, it's updated)
 * - `queue`: the merge queue variable's value (unspecified, there's no such variable); `queueError`, an error reading it replies with, and `queueWriteError`, one writing it does
 * - `eyes`, keyed by comment id: the 👀 reactions on it; `eyesError`, an error listing them replies with
 * @typedef {{
 *   openPulls?: Record<string, Record<string, any>[]>,
 *   prs?: Record<string, Record<string, unknown> | ErrorReply>,
 *   refs?: Record<string, string | ErrorReply>,
 *   ci?: Record<string, CI>,
 *   commits?: Record<string, Record<string, unknown>[]>,
 *   refUpdates?: Record<string, ErrorReply>,
 *   queue?: string,
 *   queueError?: ErrorReply,
 *   queueWriteError?: ErrorReply,
 *   eyes?: Record<string, Record<string, unknown>[]>,
 *   eyesError?: ErrorReply,
 * }} MergeScenario
 */

/** @type {(reply: unknown) => reply is ErrorReply} */
function isErrorReply(reply) {
	return !!reply && typeof reply === 'object' && 'status' in reply && typeof reply.status === 'number';
}

/** @type {(reply: ErrorReply) => [number, unknown]} */
function errorReply(reply) {
	return [reply.status, reply.body ?? { message: 'error' }];
}

/**
 * One page of `items`, as `per_page` and `page` ask (unspecified, 30, and the first), with a `Link` to the next if there is one.
 * `key` is the property a list is wrapped in (eg, `check_runs`), if it is.
 * @type {(url: URL, items: unknown[], key?: string) => [number, unknown, Record<string, string>]}
 */
function paged(url, items, key) {
	const perPage = Number(url.searchParams.get('per_page') ?? 30);
	const page = Number(url.searchParams.get('page') ?? 1);
	const slice = items.slice((page - 1) * perPage, page * perPage);
	const next = new URL(url);
	next.searchParams.set('page', String(page + 1));
	return [
		200,
		key ? { total_count: items.length, [key]: slice } : slice, // eslint-disable-line camelcase
		items.length > page * perPage ? { link: `<${next.href}>; rel="next"` } : {},
	];
}

// the App's bot, as the App's default slug (in `mockGitHub`) makes it, and its user's ID (`GET /users/{username}`, as the commands' own mock has it too)
export const botUser = 'fleet-bot[bot]';
export const botId = 42;
export const botEmail = `${botId}+${botUser}@users.noreply.github.com`;

/**
 * One of a PR's commits, as GitHub lists it: by default, authored and committed by the App's bot, which GitHub links to its user, on the base's tip as the mocked API has it unless specified otherwise (`base0`). `author` and `committer` are the GitHub users GitHub links them to (`null`, none), and `authorEmail` and `committerEmail`, their emails in the commit itself (`null`, none); `parents`, its parents' SHAs.
 * @type {(sha: string, options?: { author?: string | null, committer?: string | null, authorEmail?: string | null, committerEmail?: string | null, parents?: string[] }) => Record<string, unknown>}
 */
export function prCommit(sha, {
	author = botUser, committer = botUser, authorEmail = botEmail, committerEmail = botEmail, parents = ['base0'],
} = {}) {
	return {
		sha,
		parents: parents.map((parent) => ({ sha: parent })),
		author: author === null ? null : { login: author },
		committer: committer === null ? null : { login: committer },
		commit: {
			author: { name: 'someone', ...authorEmail === null ? {} : { email: authorEmail } },
			committer: { name: 'someone', ...committerEmail === null ? {} : { email: committerEmail } },
		},
	};
}

/** @type {(path: string) => string} */
function repoOf(path) {
	return decodeURIComponent(path.split('/').slice(2, 4).join('/'));
}

/**
 * Mocks the parts of the GitHub API `/merge` and the merge queue use, recording every request; the queue variable's value is kept as it's written.
 * Returns a function that removes the interceptors.
 * @type {(scenario: MergeScenario, record: (r: Recorded) => void) => () => void}
 */
export function mockMerge(scenario, record) {
	let { queue } = scenario;
	const scope = nock('https://api.github.com').persist();
	/** @type {(handler: (request: { url: URL, path: string, body: any }) => [number, unknown] | [number, unknown, Record<string, string>]) => (req: Request) => Promise<[number, unknown] | [number, unknown, Record<string, string>]>} */
	const handle = (handler) => async (req) => {
		const url = new URL(req.url);
		const path = `${url.pathname}${url.search}`;
		const text = await req.text();
		const body = text ? JSON.parse(text) : null;
		record({
			method: req.method, path, body, authorization: req.headers.get('authorization') ?? '',
		});
		return handler({ url, path, body });
	};
	/** @type {(sha: string) => CI} */
	const ciOf = (sha) => scenario.ci?.[sha] ?? {};

	/** @type {[nock.Interceptor, ReturnType<typeof handle>][]} */
	const routes = [
		// only `/merge` lists only open PRs; the `/fix` commands list them all
		[scope.get(/^\/repos\/[^/]+\/[^/]+\/pulls\?(?=.*\bstate=open\b)/), handle(({ url, path }) => {
			const head = String(url.searchParams.get('head'));
			const [user, branch] = [head.slice(0, head.indexOf(':')), head.slice(head.indexOf(':') + 1)];
			const prs = (scenario.openPulls?.[repoOf(path)] ?? []).filter((pr) => pr.head?.ref === branch && pr.head?.repo?.owner?.login === user);
			return paged(url, prs);
		})],
		[scope.get(/^\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/commits(?:\?.*)?$/), handle(({ url, path }) => {
			const repository = repoOf(path);
			const number = Number(path.split('/')[5]);
			const key = `${repository}#${number}`;
			const known = scenario.prs?.[key];
			const head = known && !isErrorReply(known) ? known.head : (scenario.openPulls?.[repository] ?? []).find((p) => p.number === number)?.head;
			const sha = head && typeof head === 'object' && 'sha' in head ? head.sha : null;
			const commits = scenario.commits?.[key] ?? (typeof sha === 'string' ? [prCommit(sha)] : []);
			return paged(url, commits.slice(0, 250));
		})],
		[scope.get(/^\/users\/[^/]+$/), handle(({ path }) => [200, { id: botId, login: decodeURIComponent(path.split('/')[2]) }])],
		[scope.get(/^\/repos\/[^/]+\/[^/]+\/pulls\/\d+$/), handle(({ path }) => {
			const reply = scenario.prs?.[`${repoOf(path)}#${path.split('/').pop()}`] ?? { status: 404, body: { message: 'Not Found' } };
			return isErrorReply(reply) ? errorReply(reply) : [200, reply];
		})],
		[scope.get(/^\/repos\/[^/]+\/[^/]+\/git\/ref\/.+$/), handle(({ path }) => {
			const reply = scenario.refs?.[repoOf(path)] ?? 'base0';
			return isErrorReply(reply) ? errorReply(reply) : [200, { object: { sha: reply } }];
		})],
		[scope.patch(/^\/repos\/[^/]+\/[^/]+\/git\/refs\/.+$/), handle(({ path, body }) => {
			const error = scenario.refUpdates?.[repoOf(path)];
			return error ? errorReply(error) : [200, { object: { sha: body.sha } }];
		})],
		[scope.get(/^\/repos\/[^/]+\/[^/]+\/commits\/[^/]+\/check-runs(?:\?.*)?$/), handle(({ url, path }) => {
			const ci = ciOf(decodeURIComponent(path.split('/')[5]));
			return ci.error ? errorReply(ci.error) : paged(url, (ci.checkRuns ?? []).map(({ annotations, ...run }) => ({ output: { annotations_count: annotations?.length ?? 0 }, ...run })), 'check_runs'); // eslint-disable-line camelcase
		})],
		[scope.get(/^\/repos\/[^/]+\/[^/]+\/commits\/[^/]+\/check-suites(?:\?.*)?$/), handle(({ url, path }) => {
			const ci = ciOf(decodeURIComponent(path.split('/')[5]));
			return ci.error ? errorReply(ci.error) : paged(url, ci.checkSuites ?? [], 'check_suites');
		})],
		[scope.get(/^\/repos\/[^/]+\/[^/]+\/check-runs\/\d+\/annotations(?:\?.*)?$/), handle(({ url, path }) => {
			const id = Number(path.split('/')[5]);
			const run = Object.values(scenario.ci ?? {}).flatMap((ci) => ci.checkRuns ?? []).find((r) => r.id === id);
			return paged(url, run?.annotations ?? []);
		})],
		[scope.get(/^\/repos\/[^/]+\/[^/]+\/commits\/[^/]+\/status(?:\?.*)?$/), handle(({ url, path }) => {
			const ci = ciOf(decodeURIComponent(path.split('/')[5].split('?')[0]));
			if (ci.error) {
				return errorReply(ci.error);
			}
			const [status, body] = paged(url, ci.statuses ?? [], 'statuses');
			return [status, { state: 'pending', ...(/** @type {object} */ (body)) }]; // eslint-disable-line no-extra-parens
		})],
		[scope.get(/^\/repos\/[^/]+\/[^/]+\/actions\/runs\?/), handle(({ url }) => {
			const ci = ciOf(String(url.searchParams.get('head_sha')));
			return ci.error ? errorReply(ci.error) : paged(url, (ci.runs ?? []).map((run) => ({
				name: `workflow ${run.id}`, status: 'completed', conclusion: 'success', ...run, jobs: void undefined,
			})), 'workflow_runs');
		})],
		[scope.get(/^\/repos\/[^/]+\/[^/]+\/actions\/runs\/\d+\/jobs(?:\?.*)?$/), handle(({ url, path }) => {
			const id = Number(path.split('/')[6].split('?')[0]);
			const run = Object.values(scenario.ci ?? {}).flatMap((ci) => ci.runs ?? []).find((r) => r.id === id);
			return paged(url, run?.jobs ?? [], 'jobs');
		})],
		[scope.get(/^\/repos\/[^/]+\/[^/]+\/actions\/variables\/[^/]+$/), handle(({ path }) => {
			if (scenario.queueError) {
				return errorReply(scenario.queueError);
			}
			return typeof queue === 'string' ? [200, { name: path.split('/').pop(), value: queue }] : [404, { message: 'Not Found' }];
		})],
		[scope.patch(/^\/repos\/[^/]+\/[^/]+\/actions\/variables\/[^/]+$/), handle(({ body }) => {
			if (scenario.queueWriteError) {
				return errorReply(scenario.queueWriteError);
			}
			queue = body.value;
			return [204, ''];
		})],
		[scope.post(/^\/repos\/[^/]+\/[^/]+\/actions\/variables$/), handle(({ body }) => {
			if (scenario.queueWriteError) {
				return errorReply(scenario.queueWriteError);
			}
			queue = body.value;
			return [201, {}];
		})],
		[scope.get(/^\/repos\/[^/]+\/[^/]+\/issues\/comments\/\d+\/reactions(?:\?.*)?$/), handle(({ url, path }) => (scenario.eyesError ? errorReply(scenario.eyesError) : paged(url, scenario.eyes?.[path.split('/')[6]] ?? [])))],
	];

	routes.forEach(([interceptor, handler]) => {
		interceptor.reply(/** @type {any} */ (handler)); // eslint-disable-line no-extra-parens
	});

	return () => {
		routes.forEach(([interceptor]) => nock.removeInterceptor(interceptor));
	};
}
