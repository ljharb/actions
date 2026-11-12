import nock from 'nock';

/** @import { Recorded } from '../../lib/helpers/github.mjs' */

/**
 * What sweeping the report reads, besides the issue (see `mockGitHub`): the report issue's `comments`, each PR's state (`pulls`, keyed by `owner/name#number`; unspecified, `open`), and the PRs listing a repository's open PRs returns (`open`, keyed by `owner/name`; unspecified, none).
 * Only mocked when a scenario has it, so that it never answers in place of what the commands' tests mock.
 * @typedef {{
 *   comments?: unknown[],
 *   pulls?: Record<string, string>,
 *   open?: Record<string, unknown[]>,
 * }} ReportScenario
 */

/**
 * The repository (`owner/name`) that a request's `path` (`/repos/owner/name/...`) is in.
 * @type {(path: string) => string}
 */
export function repoOf(path) {
	return decodeURIComponent(path.split('/').slice(2, 4).join('/'));
}

/**
 * Mocks the parts of the GitHub API only sweeping the report reads, recording every request.
 * @type {(scenario: ReportScenario, record: (r: Recorded) => void) => void}
 */
export function mockReport(scenario, record) {
	/** @type {(handler: (path: string) => [number, unknown]) => (req: Request) => Promise<[number, unknown]>} */
	function handle(handler) {
		return async (req) => {
			const url = new URL(req.url);
			const path = `${url.pathname}${url.search}`;
			record({
				method: req.method,
				path,
				body: null,
				authorization: req.headers.get('authorization') ?? '',
			});
			return handler(path);
		};
	}
	const scope = nock('https://api.github.com').persist();
	scope.get(/^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments(?:\?.*)?$/).reply(handle(() => [200, scenario.comments ?? []]));
	scope.get(/^\/repos\/[^/]+\/[^/]+\/pulls\/\d+$/).reply(handle((path) => [200, { state: scenario.pulls?.[`${repoOf(path)}#${path.split('/')[5]}`] ?? 'open' }]));
	scope.get(/^\/repos\/[^/]+\/[^/]+\/pulls\?/).reply(handle((path) => [200, scenario.open?.[repoOf(path)] ?? []]));
}
