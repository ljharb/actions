import { getOctokit } from '@actions/github';
import nock from 'nock';
import test from 'tape';

import {
	aboutEach,
	outdatedReplies,
	replyMarker,
	sweepReport,
} from '../../../fleet/commands/replies.mjs';
import { parseCommand } from '../../../fleet/commands/syntax.mjs';
import { fixBranch, readmeBranch } from '../../../fleet/lib/branches.mjs';
import { repoOf } from '../drift/helpers/report.mjs';

/** @import { Test } from 'tape' */
/** @import { Run, IssueComment } from '../../../fleet/commands/replies.mjs' */
/** @typedef {{ method: string, path: string, body: unknown }} Recorded */
/** @typedef {{ query: string, variables: { ids?: string[], id?: string, classifier?: string } }} GraphQLBody */

const bot = 'fleet-bot[bot]';
const legacy = 'github-actions[bot]';
const server = 'https://github.com';
const runLink = 'see [the run](https://github.com/o/r/actions/runs/1)';

/** @type {(line: string) => Run} */
function command(line) {
	const parsed = parseCommand(line);
	if (parsed.type !== 'fix' && parsed.type !== 'merge') {
		throw new TypeError(`not a command: ${line}`);
	}
	return parsed;
}

/**
 * The parts of a reply from before replies had a marker, each as it was posted, with a row for each of `rows`.
 * @type {(line: string, parts?: number, rows?: string[]) => string[]}
 */
function oldReply(line, parts = 1, rows = ['| `o/a` | nothing |']) {
	const { dryRun } = command(line);
	return Array.from({ length: parts }, (_, i) => [
		i === 0 ? `\`${line}\` (${dryRun ? 'a dry run, so nothing was changed' : 'from each repository’s `fleet/workflows` branch'}; ${runLink}):\n` : `_continued (${i + 1}/${parts})_\n`,
		`| Repository | Outcome |\n| --- | --- |\n${rows.join('\n')}`,
		i < parts - 1 ? `\n_continued below (${i + 2}/${parts})_` : '\nPrivate repositories matching these filters, if any, were also processed; nothing about them is shown here.',
	].join('\n'));
}

/**
 * The parts of a reply with a marker, each as it's posted.
 * @type {(line: string, parts?: number, rows?: string[]) => string[]}
 */
function newReply(line, parts = 1, rows = undefined) {
	return oldReply(line, parts, rows).map((body) => `${replyMarker(command(line))}\n${body}`);
}

/** @type {(repositories: string[]) => string[]} */
function queueReply(repositories) {
	return [`The merge queue, as of [this run](https://github.com/o/r/actions/runs/1):\n\n| Repository | Outcome |\n| --- | --- |\n${repositories.map((r, i) => `| \`${r}\` | merged ${server}/${r}/pull/${700 + i} |`).join('\n')}`];
}

/**
 * Comments made of `bodies`, numbered from `first`, in order.
 * @type {(first: number, bodies: string[], login?: string) => IssueComment[]}
 */
function comments(first, bodies, login = bot) {
	return bodies.map((body, i) => ({
		id: first + i,
		node_id: `IC_${first + i}`, // eslint-disable-line camelcase
		body,
		user: { login },
	}));
}

/** @type {(...lists: IssueComment[][]) => IssueComment[]} */
function thread(...lists) {
	return lists.flat();
}

test('outdatedReplies', (t) => {
	const authors = new Set([bot, legacy]);

	t.deepEqual(
		outdatedReplies(
			thread(
				comments(1, ['/dry-run fix tape-testing/tape'], 'maintainer'),
				comments(2, newReply('/dry-run fix tape-testing/tape')),
				comments(3, ['/fix tape-testing/tape'], 'maintainer'),
				comments(4, newReply('/fix tape-testing/tape')),
			),
			authors,
		),
		['IC_2'],
		'a dry run’s reply, that a later real run’s reply to the same command makes outdated; never a command, nor the latest reply',
	);

	t.deepEqual(
		outdatedReplies(
			thread(
				comments(1, newReply('/dry-run merge ljharb/qs')),
				comments(2, newReply('/dry-run merge LJHarb/qs')),
				comments(3, newReply('/merge ljharb/qs')),
				comments(4, newReply('/merge ljharb/qs')),
				comments(5, newReply('/dry-run merge ljharb/qs')),
			),
			authors,
		),
		[
			'IC_1',
			'IC_2',
			'IC_3',
		],
		'every dry run’s reply before a real one, and a real one posted twice, but its latest; a later dry run never makes a real run’s reply outdated, and is the latest reply to its own command',
	);

	t.deepEqual(
		outdatedReplies(
			thread(
				comments(1, newReply('/fix o/a', 3)),
				comments(4, newReply('/fix o/b')),
				comments(5, newReply('/fix o/a', 2)),
			),
			authors,
		),
		[
			'IC_1',
			'IC_2',
			'IC_3',
		],
		'every part of a reply that has several, and none of the latest one’s, which never outdate each other',
	);

	t.deepEqual(
		outdatedReplies(
			thread(
				comments(1, oldReply('/fix o/a', 2), legacy),
				comments(3, oldReply('/fix o/a', 2)),
				comments(5, newReply('/fix o/a')),
			),
			authors,
		),
		[
			'IC_1',
			'IC_2',
			'IC_3',
			'IC_4',
		],
		'replies from before they had a marker, whole, including GitHub Actions’ bot’s, from before the App replied',
	);

	const [first, second] = newReply('/fix o/a', 2);
	t.deepEqual(
		outdatedReplies(
			thread(
				comments(1, [first]),
				comments(2, newReply('/fix o/b')),
				comments(3, [second]),
			),
			authors,
		),
		[],
		'a reply’s later part, found on its own, never makes its first part outdated',
	);
	t.deepEqual(
		outdatedReplies(
			thread(
				comments(1, [first]),
				comments(2, newReply('/fix o/b')),
				comments(3, [second]),
				comments(4, newReply('/fix o/a')),
			),
			authors,
		),
		['IC_1', 'IC_3'],
		'but is outdated along with it',
	);

	const [a1, a2] = newReply('/fix ljharb/a', 2);
	const [b1, b2] = newReply('/fix ljharb/b', 2);
	t.deepEqual(
		outdatedReplies(
			thread(
				comments(1, [
					a1,
					b1,
					a2,
					b2,
				]),
				comments(5, newReply('/fix ljharb/b')),
			),
			authors,
		),
		['IC_2', 'IC_4'],
		'a part of one reply, posted between another’s parts, is never taken for one of the other’s, so the latest reply to its own command is never outdated',
	);

	t.deepEqual(
		outdatedReplies(
			thread(
				comments(1, newReply('/fix o/a')),
				comments(2, newReply('/fix o/a'), 'mallory'),
				comments(3, ['/fix o/a'], 'maintainer'),
				comments(4, ['thanks!']),
				[
					{ id: 5, body: newReply('/fix o/a')[0], user: null },
					{ id: 6, node_id: 'IC_6', user: { login: bot } }, // eslint-disable-line camelcase
				],
			),
			authors,
		),
		[],
		'anyone else’s comment is never a reply, so never makes one outdated, nor is outdated',
	);

	t.end();
});

test('aboutEach', (t) => {
	const about = aboutEach(
		thread(
			comments(1, ['/merge Tape-Testing/Tape'], 'maintainer'),
			comments(2, newReply('/merge tape-testing/tape', 1, [`| \`tape-testing/tape\` | queued ${server}/Tape-Testing/tape/pull/625 |`])),
			comments(3, ['/fix tape-testing/tape ljharb/qs'], 'maintainer'),
			comments(4, newReply('/fix tape-testing/tape ljharb/qs', 1, [`| \`tape-testing/tape\` | opened ${server}/tape-testing/tape/pull/626 |`])),
			comments(5, ['/dry-run fix tape-testing/tape'], 'maintainer'),
			comments(6, newReply('/dry-run fix tape-testing/tape', 1, ['| `tape-testing/tape` | would open a PR |'])),
			comments(7, [`/fix tape-testing/tape\n\nsee ${server}/tape-testing/tape/pull/1`], 'mallory'),
			comments(8, newReply('/fix tape-testing/tape', 1, [`| \`tape-testing/tape\` | opened https://example.com/tape-testing/tape/pull/2, see ${server}/tape-testing/tape/pull/625 and ${server}/ljharb/qs/pull/3 |`])),
			comments(9, queueReply(['ljharb/qs'])),
			comments(10, ['/merge ljharb'], 'maintainer'),
			comments(11, ['/merge ljharb/qs ljharb'], 'maintainer'),
			comments(12, ['/merge ljharb/qs other'], 'maintainer'),
			[
				{ id: 13, node_id: 'IC_13', user: { login: bot } }, // eslint-disable-line camelcase
				{ id: 14, node_id: 'IC_14', body: '/merge tape-testing/tape', user: null }, // eslint-disable-line camelcase
				{ id: 15, node_id: 'IC_15', body: `/merge tape-testing/tape\n\n${server}/tape-testing/tape/pull/9`, user: {} }, // eslint-disable-line camelcase
			],
		),
		new Set([bot, legacy]),
		server,
	);
	t.deepEqual(
		Array.from(about),
		[
			[
				'tape-testing/tape',
				{
					ids: [
						'IC_1',
						'IC_2',
						'IC_5',
						'IC_6',
						'IC_7',
						'IC_8',
						'IC_14',
						'IC_15',
					],
					prs: [625],
				},
			],
			[
				'ljharb/qs',
				{
					ids: [
						'IC_9',
						'IC_11',
					],
					prs: [700],
				},
			],
		],
		'each repository that comments are only about, with those comments, and its PRs that only the App’s replies among them link to, on the server, each once; never a comment about more than one repository',
	);
	t.end();
});

/**
 * A GraphQL request's `body`, as the App sends it.
 * @type {(body: unknown) => GraphQLBody}
 */
function graphQL(body) {
	return /** @type {GraphQLBody} */ (body);
}

/**
 * How the mocked API answers: the issue's `comments` (or `listStatus`, failing that), each PR's state (`pulls`, keyed by `owner/name#number`, or a status, failing that; unspecified, `closed`), the App's open PRs in a repository (`open`, keyed by `owner/name`, or a status, failing that), which comments are already `minimized`, and whether looking them up (`nodesStatus`) or hiding each (`fails`, by node id, with those GraphQL errors) fails.
 * @type {(t: Test, scenario: {
 *   comments?: IssueComment[],
 *   listStatus?: number,
 *   pulls?: Record<string, string | number>,
 *   open?: Record<string, { number: number, head: { ref: string, repo: { full_name: string } }, user: { login: string } }[] | number>,
 *   minimized?: string[],
 *   nodesStatus?: number,
 *   fails?: Record<string, unknown[]>,
 * }) => Recorded[]}
 */
function mockAPI(
	t,
	{
		comments: listed = [],
		listStatus,
		pulls = {},
		open = {},
		minimized = [],
		nodesStatus,
		fails = {},
	},
) {
	nock.disableNetConnect();
	/** @type {Recorded[]} */
	const requests = [];
	const scope = nock('https://api.github.com').persist();
	/** @type {(handler: (request: { path: string, body: unknown }) => [number, unknown]) => (req: Request) => Promise<[number, unknown]>} */
	function handle(handler) {
		return async (req) => {
			const url = new URL(req.url);
			const text = await req.text();
			/** @type {unknown} */
			const body = text ? JSON.parse(text) : null;
			const path = `${url.pathname}${url.search}`;
			requests.push({
				method: req.method,
				path,
				body,
			});
			return handler({ path, body });
		};
	}
	scope.get(/^\/repos\/o\/r\/issues\/9\/comments\?/).reply(handle(() => (listStatus ? [listStatus, { message: 'Not Found: tape-testing/tape' }] : [200, listed])));
	scope.get(/^\/repos\/[^/]+\/[^/]+\/pulls\/\d+$/).reply(handle(({ path }) => {
		const state = pulls[`${repoOf(path)}#${path.split('/')[5]}`] ?? 'closed';
		return typeof state === 'number' ? [state, { message: `Not Found: ${repoOf(path)}` }] : [200, { state }];
	}));
	scope.get(/^\/repos\/[^/]+\/[^/]+\/pulls\?/).reply(handle(({ path }) => {
		const prs = open[repoOf(path)] ?? [];
		if (typeof prs === 'number') {
			return [prs, { message: `Server Error: ${repoOf(path)}` }];
		}
		const head = new URLSearchParams(path.split('?')[1]).get('head');
		return [200, prs.filter((pr) => `${repoOf(path).split('/')[0]}:${pr.head.ref}` === head)];
	}));
	scope.post('/graphql').reply(handle(({ body }) => {
		const { query, variables } = graphQL(body);
		if (query.includes('nodes(')) {
			if (nodesStatus) {
				return [nodesStatus, { message: 'Server Error: tape-testing/tape' }];
			}
			const { ids = [] } = variables;
			return [200, { data: { nodes: ids.map((id) => ({ id, isMinimized: minimized.includes(id) })) } }];
		}
		const failed = fails[variables.id ?? ''];
		return failed
			? [200, { data: { minimizeComment: null }, errors: failed }]
			: [200, { data: { minimizeComment: { minimizedComment: { isMinimized: true } } } }];
	}));
	t.teardown(() => {
		nock.cleanAll();
		nock.enableNetConnect();
	});
	return requests;
}

/** @type {(requests: Recorded[]) => [string, string][]} */
function hidden(requests) {
	return requests.flatMap((r) => {
		if (r.path !== '/graphql') {
			return [];
		}
		const { query, variables: { id, classifier } } = graphQL(r.body);
		/** @type {[string, string][]} */
		const minimized = query.includes('minimizeComment') ? [[String(id), String(classifier)]] : [];
		return minimized;
	});
}

/** @type {(requests: Recorded[]) => string[]} */
function pullRequests(requests) {
	return requests.filter((r) => (/\/pulls/).test(r.path)).map((r) => r.path);
}

/**
 * Sweeps issue 9 of `o/r`, returning how many it hid as each, and what it logged.
 * @type {(options?: { dryRun?: boolean, serverURL?: string }) => Promise<{ count: { outdated: number, resolved: number }, stdout: string }>}
 */
async function sweep({ dryRun = false, serverURL } = {}) {
	let stdout = '';
	const { write } = process.stdout;
	const { GITHUB_SERVER_URL } = process.env;
	if (serverURL) {
		process.env.GITHUB_SERVER_URL = serverURL;
	} else {
		delete process.env.GITHUB_SERVER_URL;
	}
	process.stdout.write = function (/** @type {string} */ chunk) {
		stdout += String(chunk);
		return true;
	};
	try {
		const count = await sweepReport({
			octokit: getOctokit('ghs_test'),
			owner: 'o',
			repo: 'r',
			number: 9,
			bot,
			dryRun,
		});
		return { count, stdout };
	} finally {
		process.stdout.write = write;
		if (typeof GITHUB_SERVER_URL === 'string') {
			process.env.GITHUB_SERVER_URL = GITHUB_SERVER_URL;
		} else {
			delete process.env.GITHUB_SERVER_URL;
		}
	}
}

// what's on the report: tape-testing/tape's only App PR, #625, is closed; ljharb/qs's #3 is still open
const tapeRow = [`| \`tape-testing/tape\` | opened ${server}/tape-testing/tape/pull/625 |`];
const report = thread(
	comments(1, ['/dry-run fix tape-testing/tape'], 'maintainer'),
	comments(2, newReply('/dry-run fix tape-testing/tape', 1, ['| `tape-testing/tape` | would open a PR |'])),
	comments(3, ['/fix tape-testing/tape'], 'maintainer'),
	comments(4, newReply('/fix tape-testing/tape', 1, tapeRow)),
	comments(5, ['/merge tape-testing/tape ljharb/qs'], 'maintainer'),
	comments(6, newReply('/merge tape-testing/tape ljharb/qs', 1, tapeRow)),
	comments(7, ['/dry-run merge ljharb/qs'], 'maintainer'),
	comments(8, newReply('/dry-run merge ljharb/qs', 1, [`| \`ljharb/qs\` | would queue ${server}/ljharb/qs/pull/3 |`])),
	comments(9, ['/merge ljharb/qs'], 'maintainer'),
	comments(10, newReply('/merge ljharb/qs', 1, [`| \`ljharb/qs\` | queued ${server}/ljharb/qs/pull/3 |`])),
	comments(11, newReply('/merge ljharb/qs', 1, [`| \`ljharb/qs\` | queued ${server}/ljharb/qs/pull/3 |`])),
	comments(12, ['/dry-run fix ljharb/other'], 'maintainer'),
	comments(13, newReply('/dry-run fix ljharb/other', 1, ['| `ljharb/other` | would open a PR |'])),
);

test('sweepReport', (t) => {
	t.test('hides what’s only about a repository whose PRs are all closed as resolved, and replies later ones make outdated as outdated', async (st) => {
		const requests = mockAPI(st, { comments: report, pulls: { 'ljharb/qs#3': 'open' } });
		const { count, stdout } = await sweep({ serverURL: server });
		st.deepEqual(count, { outdated: 2, resolved: 4 }, 'saying how many it hid as each');
		st.deepEqual(
			hidden(requests),
			[
				['IC_1', 'RESOLVED'],
				['IC_2', 'RESOLVED'],
				['IC_3', 'RESOLVED'],
				['IC_4', 'RESOLVED'],
				['IC_8', 'OUTDATED'],
				['IC_10', 'OUTDATED'],
			],
			'every comment only about tape-testing/tape (but what’s about another repository too), once, as resolved; and, of the App’s replies, a superseded dry run’s, and the earlier of the same real one’s posted twice, as outdated, never the latest one’s, nor a command, nor anything about a repository with an open PR as resolved, nor what’s only about a repository no PR is named for',
		);
		st.deepEqual(
			pullRequests(requests),
			[
				'/repos/tape-testing/tape/pulls/625',
				`/repos/tape-testing/tape/pulls?head=tape-testing%3A${encodeURIComponent(fixBranch)}&state=open&per_page=100`,
				'/repos/tape-testing/tape/pulls?head=tape-testing%3Aactions-lock%2Frelock&state=open&per_page=100',
				`/repos/tape-testing/tape/pulls?head=tape-testing%3A${encodeURIComponent(readmeBranch)}&state=open&per_page=100`,
				'/repos/ljharb/qs/pulls/3',
			],
			'reading only the PRs named, and the App’s open PRs only where every one named is closed',
		);
		st.equal(
			stdout,
			'hid 2 of the App’s replies on the report that later replies make outdated, as outdated\nhid 4 comments on the report about a repository whose PRs the App has all closed or merged, as resolved\n',
			'logging only how many',
		);
		st.notOk((/tape|qs|other/).test(stdout), 'never naming a repository');
	});

	t.test('a repository where the App still has an open PR isn’t resolved', async (st) => {
		const requests = mockAPI(st, {
			comments: report,
			pulls: { 'ljharb/qs#3': 'open' },
			open: {
				'tape-testing/tape': [
					{
						number: 630,
						head: { ref: fixBranch, repo: { full_name: 'tape-testing/tape' } }, // eslint-disable-line camelcase
						user: { login: bot },
					},
				],
			},
		});
		const { count, stdout } = await sweep();
		st.deepEqual(count, { outdated: 3, resolved: 0 }, 'hiding nothing as resolved');
		st.deepEqual(
			hidden(requests),
			[
				['IC_2', 'OUTDATED'],
				['IC_8', 'OUTDATED'],
				['IC_10', 'OUTDATED'],
			],
			'but still hiding replies later ones make outdated',
		);
		st.equal(stdout, 'hid 3 of the App’s replies on the report that later replies make outdated, as outdated\n', 'logging how many');
	});

	t.test('one the App’s replies name no PR of isn’t resolved', async (st) => {
		const requests = mockAPI(st, {
			comments: thread(
				comments(1, ['/dry-run fix tape-testing/tape'], 'maintainer'),
				comments(2, newReply('/dry-run fix tape-testing/tape', 1, ['| `tape-testing/tape` | would open a PR |'])),
				comments(3, newReply('/fix tape-testing/tape', 1, [`| \`tape-testing/tape\` | opened ${server}/tape-testing/tape/pull/625 |`]), 'mallory'),
			),
		});
		const { count, stdout } = await sweep();
		st.deepEqual(count, { outdated: 0, resolved: 0 }, 'hiding nothing');
		st.deepEqual(requests.map((r) => `${r.method} ${r.path}`), ['GET /repos/o/r/issues/9/comments?per_page=100'], 'reading no PR, nor looking any comment up');
		st.equal(stdout, '', 'logging nothing');
	});

	t.test('skips what’s already hidden', async (st) => {
		const requests = mockAPI(st, {
			comments: report,
			pulls: { 'ljharb/qs#3': 'open' },
			minimized: [
				'IC_1',
				'IC_2',
				'IC_8',
			],
		});
		const { count, stdout } = await sweep();
		st.deepEqual(count, { outdated: 1, resolved: 2 }, 'counting only what it hid');
		st.deepEqual(hidden(requests).map(([id]) => id), ['IC_3', 'IC_4', 'IC_10'], 'hiding the rest');
		st.equal(stdout, 'hid 1 of the App’s replies on the report that later replies make outdated, as outdated\nhid 2 comments on the report about a repository whose PRs the App has all closed or merged, as resolved\n', 'logging how many');
	});

	t.test('a dry run hides nothing, but says how many it would have', async (st) => {
		const requests = mockAPI(st, { comments: report, pulls: { 'ljharb/qs#3': 'open' } });
		const { count, stdout } = await sweep({ dryRun: true });
		st.deepEqual(count, { outdated: 2, resolved: 4 }, 'counting what it would have hidden');
		st.deepEqual(hidden(requests), [], 'hiding nothing');
		st.equal(stdout, 'dry run: would have hidden 2 of the App’s replies on the report that later replies make outdated, as outdated\ndry run: would have hidden 4 comments on the report about a repository whose PRs the App has all closed or merged, as resolved\n', 'logging how many');
	});

	t.test('one comment, resolved', async (st) => {
		const requests = mockAPI(st, { comments: thread(comments(1, queueReply(['tape-testing/tape']))) });
		const { count, stdout } = await sweep();
		st.deepEqual(count, { outdated: 0, resolved: 1 }, 'counting it');
		st.deepEqual(hidden(requests), [['IC_1', 'RESOLVED']], 'hiding it');
		st.equal(stdout, 'hid 1 comment on the report about a repository whose PRs the App has all closed or merged, as resolved\n', 'logging it');
	});

	t.test('nothing to hide', async (st) => {
		const requests = mockAPI(st, { comments: thread(comments(1, newReply('/fix o/a'))) });
		const { count, stdout } = await sweep();
		st.deepEqual(count, { outdated: 0, resolved: 0 }, 'hides nothing');
		st.deepEqual(requests.map((r) => r.method), ['GET'], 'without looking anything up');
		st.equal(stdout, '', 'logging nothing');
	});

	t.test('failures only warn, never naming a repository or a comment', async (st) => {
		mockAPI(st, { listStatus: 404 });
		const unread = await sweep();
		st.deepEqual(unread.count, { outdated: 0, resolved: 0 }, 'hiding nothing when the comments can’t be read');
		st.equal(unread.stdout, '::warning::could not read the comments on the report, to hide those that are outdated or resolved (HTTP 404)\n', 'warning');

		nock.cleanAll();
		const unchecked = mockAPI(st, { comments: report, pulls: { 'ljharb/qs#3': 404 } });
		const checks = await sweep();
		st.deepEqual(checks.count, { outdated: 2, resolved: 4 }, 'hiding the rest, when a repository’s PRs can’t be read');
		st.deepEqual(hidden(unchecked).filter(([id]) => id === 'IC_9'), [], 'and nothing only about it');
		st.equal(checks.stdout, '::warning::could not tell whether the App has any PRs still open in 1 of the repositories that comments on the report are only about, so nothing only about those is hidden as resolved (HTTP 404)\nhid 2 of the App’s replies on the report that later replies make outdated, as outdated\nhid 4 comments on the report about a repository whose PRs the App has all closed or merged, as resolved\n', 'warning');

		nock.cleanAll();
		mockAPI(st, {
			comments: report,
			pulls: { 'ljharb/qs#3': 'open' },
			open: { 'tape-testing/tape': 500 },
		});
		const listing = await sweep();
		st.deepEqual(listing.count, { outdated: 3, resolved: 0 }, 'or when its open PRs can’t be listed');
		st.match(listing.stdout, /^::warning::could not tell whether the App has any PRs still open in 1 of the repositories that comments on the report are only about, so nothing only about those is hidden as resolved \(HTTP 500\)\n/, 'warning');

		nock.cleanAll();
		mockAPI(st, { comments: report, nodesStatus: 502 });
		const lookup = await sweep();
		st.deepEqual(lookup.count, { outdated: 0, resolved: 0 }, 'hiding nothing when they can’t be looked up');
		st.equal(lookup.stdout, '::warning::could not read the comments on the report, to hide those that are outdated or resolved (HTTP 502)\n', 'warning');

		nock.cleanAll();
		const failing = mockAPI(st, {
			comments: report,
			pulls: { 'ljharb/qs#3': 'open' },
			fails: {
				IC_1: [{ type: 'FORBIDDEN', message: 'tape-testing/tape IC_1' }],
				IC_8: [{ message: 'ljharb/qs IC_8' }],
			},
		});
		const hiding = await sweep();
		st.deepEqual(hiding.count, { outdated: 1, resolved: 3 }, 'hiding the rest, when some can’t be hidden');
		st.equal(hidden(failing).length, 6, 'having tried every one');
		st.equal(hiding.stdout, '::warning::could not hide 2 of the comments on the report that are outdated or resolved (FORBIDDEN)\nhid 1 of the App’s replies on the report that later replies make outdated, as outdated\nhid 3 comments on the report about a repository whose PRs the App has all closed or merged, as resolved\n', 'warning');

		[unread, checks, listing, lookup, hiding].forEach(({ stdout }) => {
			st.notOk((/tape|qs|other|IC_/).test(stdout), 'never naming a repository or a comment');
		});
	});

	t.test('a failure with nothing to say about it only warns that it failed', async (st) => {
		mockAPI(st, {
			comments: thread(comments(1, newReply('/fix o/a')), comments(2, newReply('/fix o/a'))),
			fails: { IC_1: [{ message: 'something went wrong with o/a' }] },
		});
		const { count, stdout } = await sweep();
		st.deepEqual(count, { outdated: 0, resolved: 0 }, 'hiding nothing');
		st.equal(stdout, '::warning::could not hide 1 of the comments on the report that are outdated or resolved\n', 'warning, without anything GitHub said');
	});

	t.end();
});
