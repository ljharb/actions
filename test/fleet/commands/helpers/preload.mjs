// loaded via `node --import` into child processes; does nothing unless `FLEET_TEST_SCENARIO` is set
import { appendFileSync, readFileSync } from 'fs';

import nock from 'nock';

// the drift report's scenario: the App's installations, repositories, and issues, and the released node versions
import '../../drift/helpers/preload.mjs';
import { mockMerge } from './merge.mjs';

/** @typedef {import('../../lib/helpers/github.mjs').ErrorReply} ErrorReply */
/**
 * The parts of the GitHub API only the commands use, each keyed by `owner/name` (or, for `permissions`, a login):
 * - `permissions`: a commenter's permission on the repository running the commands (unspecified, `none`)
 * - `pulls`: the PRs listing a repository's `fleet/workflows` PRs returns (unspecified, none), or an error
 * - `serverURL`: where the `html_url` of a created or updated PR points
 * - `reactions`: the status removing the 👀 reaction replies with (unspecified, 204), and the one adding the final reaction does (unspecified, 201)
 * @typedef {{
 *   permissions?: Record<string, string>,
 *   pulls?: Record<string, unknown[] | ErrorReply>,
 *   serverURL?: string,
 *   reactions?: { remove?: number, finish?: number },
 * }} CommandsScenario
 */
/** @typedef {import('../../drift/helpers/preload.mjs').ChildScenario & { commands?: CommandsScenario, merge?: import('./merge.mjs').MergeScenario }} Scenario */

const { FLEET_TEST_SCENARIO } = process.env;

if (FLEET_TEST_SCENARIO) {
	/** @type {Scenario} */
	const scenario = JSON.parse(readFileSync(FLEET_TEST_SCENARIO, 'utf8'));
	const { log } = scenario;
	const commands = scenario.commands ?? {};
	const serverURL = commands.serverURL ?? 'https://github.com';

	// before the commands' own PR listing, so that its open PRs are `/merge`'s
	if (log) {
		mockMerge(scenario.merge ?? {}, (r) => appendFileSync(log, `${JSON.stringify(r)}\n`));
	}

	/** @type {(handler: (request: { path: string, body: any }) => [number, unknown]) => (req: Request) => Promise<[number, unknown]>} */
	const handle = (handler) => async (req) => {
		const url = new URL(req.url);
		const path = `${url.pathname}${url.search}`;
		const text = await req.text();
		const body = text ? JSON.parse(text) : null;
		if (log) {
			appendFileSync(log, `${JSON.stringify({
				method: req.method, path, body, authorization: req.headers.get('authorization') ?? '',
			})}\n`);
		}
		return handler({ path, body });
	};
	/** @type {(path: string) => string} */
	const repoOf = (path) => decodeURIComponent(path.split('/').slice(2, 4).join('/'));

	const scope = nock('https://api.github.com').persist();
	scope.get(/^\/repos\/[^/]+\/[^/]+\/collaborators\/[^/]+\/permission$/).reply(/** @type {any} */ (handle(({ path }) => [ // eslint-disable-line no-extra-parens
		200,
		{ permission: commands.permissions?.[decodeURIComponent(path.split('/')[5])] ?? 'none' },
	])));
	scope.post(/^\/repos\/[^/]+\/[^/]+\/issues\/comments\/\d+\/reactions$/).reply(/** @type {any} */ (handle(({ body }) => ( // eslint-disable-line no-extra-parens
		body.content === 'eyes' ? [201, { id: 501, content: 'eyes' }] : [commands.reactions?.finish ?? 201, { id: 502, content: body.content }]
	))));
	scope.delete(/^\/repos\/[^/]+\/[^/]+\/issues\/comments\/\d+\/reactions\/\d+$/).reply(/** @type {any} */ (handle(() => [commands.reactions?.remove ?? 204, '']))); // eslint-disable-line no-extra-parens
	scope.get(/^\/users\/[^/]+$/).reply(/** @type {any} */ (handle(() => [200, { id: 42, login: 'fleet-bot[bot]' }]))); // eslint-disable-line no-extra-parens
	scope.get(/^\/repos\/[^/]+\/[^/]+\/pulls\?/).reply(/** @type {any} */ (handle(({ path }) => { // eslint-disable-line no-extra-parens
		const reply = commands.pulls?.[repoOf(path)] ?? [];
		return Array.isArray(reply) ? [200, reply] : [reply.status, reply.body ?? { message: 'error' }];
	})));
	scope.post(/^\/repos\/[^/]+\/[^/]+\/pulls$/).reply(/** @type {any} */ (handle(({ path }) => [ // eslint-disable-line no-extra-parens
		201,
		{ number: 1, html_url: `${serverURL}/${repoOf(path)}/pull/1` }, // eslint-disable-line camelcase
	])));
	scope.patch(/^\/repos\/[^/]+\/[^/]+\/pulls\/\d+$/).reply(/** @type {any} */ (handle(({ path }) => [ // eslint-disable-line no-extra-parens
		200,
		{ html_url: `${serverURL}/${repoOf(path)}/pull/${path.split('/').pop()}` }, // eslint-disable-line camelcase
	])));
}
