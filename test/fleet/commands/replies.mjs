import { getOctokit } from '@actions/github';
import nock from 'nock';
import test from 'tape';

import {
	aboutOnly,
	earlierReplies,
	hideEarlierReplies,
	hideResolved,
	identify,
	onlyAbout,
	queueReplyAbout,
	repliedTo,
	replyMarker,
	supersedes,
	unmarked,
} from '../../../fleet/commands/replies.mjs';
import { parseCommand } from '../../../fleet/commands/syntax.mjs';

/** @import { Test } from 'tape' */
/** @import { Run, IssueComment } from '../../../fleet/commands/replies.mjs' */
/** @typedef {{ method: string, path: string, body: any }} Recorded */

const bot = 'fleet-bot[bot]';
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
 * The first line of a reply from before replies had a marker, as it was posted.
 * @type {(line: string) => string}
 */
function oldFirstLine(line) {
	const { type, dryRun } = command(line);
	if (dryRun) {
		return `\`${line}\` (a dry run, so nothing was changed${type === 'merge' ? ' or queued' : ''}; ${runLink}):`;
	}
	return `\`${line}\` (from each repository’s ${type === 'merge' ? '`fleet/workflows` and `actions-lock/relock` PRs by the App’s bot' : '`fleet/workflows` branch'}; ${runLink}):`;
}

/**
 * The parts of a reply from before replies had a marker, each as it was posted.
 * @type {(line: string, parts?: number) => string[]}
 */
function oldReply(line, parts = 1) {
	return Array.from({ length: parts }, (_, i) => [
		i === 0 ? `${oldFirstLine(line)}\n` : `_continued (${i + 1}/${parts})_\n`,
		'| Repository | Outcome |\n| --- | --- |\n| `o/a` | nothing |',
		i < parts - 1 ? `\n_continued below (${i + 2}/${parts})_` : '\nPrivate repositories matching these filters, if any, were also processed; nothing about them is shown here.',
	].join('\n'));
}

/**
 * The parts of a reply with a marker, each as it's posted.
 * @type {(line: string, parts?: number) => string[]}
 */
function newReply(line, parts = 1) {
	return oldReply(line, parts).map((body) => `${replyMarker(command(line))}\n${body}`);
}

/** @type {(id: number, body: string, login?: string) => IssueComment} */
function comment(id, body, login = bot) {
	return {
		id,
		node_id: `IC_${id}`, // eslint-disable-line camelcase
		body,
		user: { login },
	};
}

/**
 * Comments made of `bodies`, numbered from `first`, in order.
 * @type {(first: number, bodies: string[], login?: string) => IssueComment[]}
 */
function comments(first, bodies, login = bot) {
	return bodies.map((body, i) => comment(first + i, body, login));
}

test('identify and replyMarker', (t) => {
	t.deepEqual(identify(command('/fix LJHarb/QS rebase.yml, es-shims')), identify(command('/fix es-shims ljharb/qs Rebase.YML')), 'the same filters, in any order or case, are the same command');
	t.notDeepEqual(identify(command('/fix ljharb')), identify(command('/fix ljharb es-shims')), 'different filters are a different command');
	t.equal(identify(command('/dry-run merge ljharb')).verb, 'merge', 'with its verb');
	t.equal(identify(command('/dry-run merge ljharb')).dryRun, true, 'and whether it’s a dry run');

	const marker = replyMarker(command('/dry-run merge tape-testing/tape'));
	t.match(marker, /^<!-- fleet:reply:dry-run:merge:[0-9a-f]{64} -->$/, 'a dry run’s marker says so, and has the verb, and a digest of the filters');
	t.notOk(marker.includes('tape'), 'never naming a filter');
	t.match(replyMarker(command('/fix ljharb')), /^<!-- fleet:reply:fix:[0-9a-f]{64} -->$/, 'a real run’s doesn’t');
	t.equal(replyMarker(command(`/fix ${Array.from({ length: 500 }, (_, i) => `owner/repository-${i}`).join(' ')}`)).length, marker.length - 'dry-run:merge'.length + 'fix'.length, 'and is as short however many filters there are');

	t.equal(unmarked(`${marker}\nthe reply`), 'the reply', 'unmarked removes the marker');
	t.equal(unmarked('the reply'), 'the reply', 'and leaves anything without one as it is');
	t.equal(unmarked(`x\n${marker}\nthe reply`), `x\n${marker}\nthe reply`, 'even with one later on');

	t.end();
});

test('repliedTo', (t) => {
	t.deepEqual(repliedTo(newReply('/dry-run merge tape-testing/tape')[0]), { ...identify(command('/dry-run merge tape-testing/tape')), marked: true }, 'a marked reply, by its marker');
	t.deepEqual(repliedTo(newReply('/fix ljharb', 2)[1]), { ...identify(command('/fix ljharb')), marked: true }, 'every part of one');

	t.deepEqual(repliedTo(oldReply('/dry-run merge tape-testing/tape')[0]), { ...identify(command('/dry-run merge tape-testing/tape')), marked: false }, 'an unmarked dry run’s reply, by the command it quotes');
	t.deepEqual(repliedTo(oldReply('/merge Tape-Testing/tape')[0]), { ...identify(command('/merge tape-testing/tape')), marked: false }, 'an unmarked `/merge`’s');
	t.deepEqual(repliedTo(oldReply('/dry-run fix ljharb missing')[0]), { ...identify(command('/dry-run fix ljharb missing')), marked: false }, 'an unmarked `/dry-run fix`’s');
	t.deepEqual(repliedTo(oldReply('/fix ljharb')[0]), { ...identify(command('/fix ljharb')), marked: false }, 'an unmarked `/fix`’s');

	t.equal(repliedTo(oldReply('/fix ljharb', 2)[1]), null, 'an unmarked reply’s later part, on its own, isn’t known to be one');
	t.equal(repliedTo('/dry-run merge tape-testing/tape'), null, 'nor is the command itself');
	t.equal(repliedTo('Unknown command: `/frob ljharb`. Nothing was done.'), null, 'nor a reply to an invalid command');
	t.equal(repliedTo('Only people with write access to this repository can run fleet commands, so nothing was done.'), null, 'nor one to someone who can’t run them');
	t.equal(repliedTo('The merge queue, as of [this run](https://example.com):'), null, 'nor the merge queue’s');
	t.equal(repliedTo('`/fix ljharb` is what I ran (a dry run, so nothing'), null, 'nor one that only quotes a command');
	t.equal(repliedTo('`/frob ljharb` (a dry run, so nothing was changed):'), null, 'nor one quoting what isn’t a command');
	t.equal(repliedTo('<!-- fleet:reply:frob:abc -->\nhi'), null, 'nor one with a marker that isn’t a reply’s');

	t.end();
});

test('supersedes', (t) => {
	const dry = identify(command('/dry-run merge ljharb'));
	const real = identify(command('/merge ljharb'));
	t.ok(supersedes(dry, dry), 'a dry run supersedes the same dry run');
	t.ok(supersedes(real, dry), 'a real run supersedes a dry run of it');
	t.ok(supersedes(real, real), 'a real run supersedes the same real run');
	t.notOk(supersedes(dry, real), 'a dry run never supersedes a real run, which says what was done');
	t.notOk(supersedes(identify(command('/dry-run fix ljharb')), dry), 'nor does another verb');
	t.notOk(supersedes(identify(command('/dry-run merge ljharb es-shims')), dry), 'nor do other filters');
	t.end();
});

test('earlierReplies', (t) => {
	const dryMerge = command('/dry-run merge tape-testing/tape');
	t.deepEqual(
		earlierReplies(
			/** @type {IssueComment[]} */ ([]).concat(
				comments(1, ['/dry-run merge tape-testing/tape'], 'maintainer'),
				comments(2, oldReply('/dry-run merge tape-testing/tape', 3)),
				comments(5, ['/dry-run merge Tape-Testing/tape'], 'maintainer'),
				comments(6, newReply('/dry-run merge tape-testing/tape', 2)),
			),
			bot,
			dryMerge,
		),
		['IC_2', 'IC_3', 'IC_4', 'IC_6', 'IC_7'],
		'every part of each earlier reply to the same command, marked or not; never the commands',
	);
	t.deepEqual(
		earlierReplies(
			/** @type {IssueComment[]} */ ([]).concat(
				comments(1, oldReply('/dry-run merge tape-testing/tape', 2), 'FLEET-BOT[bot]'),
				comments(3, newReply('/dry-run merge tape-testing/tape'), 'mallory'),
				comments(4, oldReply('/dry-run merge tape-testing/tape'), 'mallory'),
				comments(5, newReply('/dry-run merge ljharb/qs', 2)),
				comments(7, oldReply('/dry-run merge ljharb/qs', 2)),
				comments(9, newReply('/dry-run fix tape-testing/tape')),
				comments(10, oldReply('/dry-run fix tape-testing/tape', 2)),
				comments(12, oldReply('/merge tape-testing/tape', 2)),
				comments(14, newReply('/merge tape-testing/tape')),
			),
			bot,
			dryMerge,
		),
		['IC_1', 'IC_2'],
		'the bot’s, however its login is cased; but nobody else’s, nor any to another command, nor any to a real run of it',
	);

	const [first, second, third] = oldReply('/dry-run merge tape-testing/tape', 3);
	t.deepEqual(
		earlierReplies(
			/** @type {IssueComment[]} */ ([]).concat(
				comments(1, [first, 'something else', second, third]),
				comments(5, [oldReply('/dry-run merge ljharb/qs', 2)[0], second]),
				comments(7, [first, third]),
				comments(9, [oldReply('/dry-run merge tape-testing/tape', 2)[0], third]),
				comments(11, [first]),
				comments(12, ['thanks!'], 'maintainer'),
				comments(13, [second, third, second]),
			),
			bot,
			dryMerge,
		),
		[
			'IC_1',
			'IC_7',
			'IC_9',
			'IC_11',
			'IC_13',
			'IC_14',
		],
		'an unmarked reply’s later parts are only those right after it, among the bot’s comments, in order, of as many parts',
	);

	t.deepEqual(
		earlierReplies(comments(1, oldReply('/dry-run merge tape-testing/tape', 2)), bot, command('/merge tape-testing/tape')),
		['IC_1', 'IC_2'],
		'a real run hides a dry run’s reply',
	);
	t.deepEqual(
		earlierReplies(comments(1, newReply('/merge tape-testing/tape', 2).concat(oldReply('/merge tape-testing/tape', 2))), bot, command('/merge tape-testing/tape')),
		['IC_1', 'IC_2', 'IC_3', 'IC_4'],
		'and an earlier real run’s',
	);
	t.deepEqual(
		earlierReplies(
			[
				{ id: 1, body: oldReply('/dry-run merge tape-testing/tape')[0], user: { login: bot } },
				{ id: 2, user: null },
				{ id: 3, node_id: 'IC_3', user: { login: bot } }, // eslint-disable-line camelcase
			],
			bot,
			dryMerge,
		),
		[],
		'a comment without a node id, or without a body or an author, is left alone',
	);

	t.end();
});

test('onlyAbout', (t) => {
	t.ok(onlyAbout(command('/merge Tape-Testing/Tape'), 'tape-testing/tape'), 'a command naming only that repository');
	t.ok(onlyAbout(command('/dry-run fix tape-testing/tape tape-testing rebase.yml drifted'), 'tape-testing/tape'), 'however else its filters narrow it, including by its own account');
	t.notOk(onlyAbout(command('/merge tape-testing/tape ljharb/qs'), 'tape-testing/tape'), 'not one naming another repository too');
	t.notOk(onlyAbout(command('/merge tape-testing/tape ljharb'), 'tape-testing/tape'), 'nor another account');
	t.notOk(onlyAbout(command('/merge tape-testing/tape tape-testing ljharb'), 'tape-testing/tape'), 'even alongside its own');
	t.notOk(onlyAbout(command('/merge tape-testing'), 'tape-testing/tape'), 'nor one naming only its account');
	t.notOk(onlyAbout(command('/merge ljharb/qs'), 'tape-testing/tape'), 'nor one about another repository');
	t.end();
});

test('aboutOnly', (t) => {
	const tape = new Set(['tape-testing/tape']);
	t.deepEqual(
		aboutOnly(
			/** @type {IssueComment[]} */ ([]).concat(
				comments(1, ['/dry-run merge tape-testing/tape'], 'maintainer'),
				comments(2, oldReply('/dry-run merge tape-testing/tape', 2)),
				comments(4, ['/fix Tape-Testing/tape rebase.yml'], 'someone'),
				comments(5, newReply('/fix tape-testing/tape rebase.yml')),
				comments(6, newReply('/dry-run fix tape-testing/tape rebase.yml')),
				comments(7, newReply('/fix tape-testing/tape')),
				comments(8, ['/merge tape-testing/tape ljharb/qs'], 'maintainer'),
				comments(9, newReply('/merge tape-testing/tape ljharb/qs')),
				comments(10, ['/merge ljharb/qs', 'thanks!', 'not a command: /merge tape-testing/tape'], 'maintainer'),
				comments(13, ['/merge tape-testing/tape']),
				[{ id: 14, body: '/merge tape-testing/tape', user: { login: 'maintainer' } }, { id: 15, user: null }],
			),
			bot,
			tape,
		),
		[
			'IC_1',
			'IC_2',
			'IC_3',
			'IC_4',
			'IC_5',
			'IC_13',
		],
		'every command only about it, by anyone (but one without a node id), and every part of the bot’s replies to one of those, in order; never a reply to a command that isn’t on the issue (a dry run, when only the real one is), nor anything about another repository too',
	);
	t.deepEqual(aboutOnly(comments(1, ['/merge tape-testing/tape']), bot, new Set()), [], 'about no repository, nothing');
	t.end();
});

/**
 * The parts of a reply of the merge queue's, with a row for each of `repositories` (split evenly between the parts, in order), each as it was posted.
 * @type {(repositories: string[], parts?: number) => string[]}
 */
function queueReply(repositories, parts = 1) {
	return Array.from({ length: parts }, (_, i) => [
		i === 0 ? 'The merge queue, as of [this run](https://github.com/o/r/actions/runs/1):\n' : `_continued (${i + 1}/${parts})_\n`,
		'| Repository | Outcome |\n| --- | --- |',
		repositories.slice(i * Math.ceil(repositories.length / parts), (i + 1) * Math.ceil(repositories.length / parts)).map((r) => `| \`${r}\` | merged https://github.com/${r}/pull/1 (queued by [this comment](https://github.com/o/r/issues/9#issuecomment-1)) |`).join('\n'),
		i < parts - 1 ? `\n_continued below (${i + 2}/${parts})_` : '\nPrivate repositories in the queue, if any, were also processed; nothing about them is shown here.',
	].join('\n'));
}

test('queueReplyAbout', (t) => {
	t.equal(queueReplyAbout(comments(1, queueReply(['Tape-Testing/tape']))), 'tape-testing/tape', 'a reply of the merge queue’s with only one repository’s rows is about it');
	t.equal(queueReplyAbout(comments(1, queueReply(['tape-testing/tape', 'tape-testing/tape'], 2))), 'tape-testing/tape', 'across all its parts');
	t.equal(queueReplyAbout(comments(1, queueReply(['tape-testing/tape', 'ljharb/qs'], 2))), null, 'but not one with another repository’s rows too, in any part');
	t.equal(queueReplyAbout(comments(1, queueReply([]))), null, 'nor one with no rows');
	t.equal(queueReplyAbout(comments(1, oldReply('/merge tape-testing/tape'))), null, 'nor a reply to a command');
	t.equal(queueReplyAbout([{ id: 1, user: null }]), null, 'nor a comment with no body');
	t.end();
});

test('aboutOnly: the merge queue’s replies', (t) => {
	t.deepEqual(
		aboutOnly(
			/** @type {IssueComment[]} */ ([]).concat(
				comments(1, queueReply(['tape-testing/tape', 'tape-testing/tape'], 2)),
				comments(3, queueReply(['tape-testing/tape', 'ljharb/qs'])),
				comments(4, queueReply(['tape-testing/tape']), 'mallory'),
				comments(5, queueReply(['ljharb/qs'])),
				comments(6, queueReply(['Tape-Testing/Tape'])),
				[{ id: 7, body: queueReply(['tape-testing/tape'])[0], user: { login: bot } }],
			),
			bot,
			new Set(['tape-testing/tape']),
		),
		[
			'IC_1',
			'IC_2',
			'IC_6',
		],
		'every part of each of the bot’s merge queue replies only about it (but one without a node id); never one about another repository too, or only another one, nor anyone else’s',
	);
	t.end();
});

/**
 * How the mocked API answers: the issue's `comments` (or `listStatus`, failing that), which of them are already `minimized`, and whether looking them up (`nodesStatus`) or hiding each (`fails`, by node id, with those GraphQL errors) fails.
 * @type {(t: Test, scenario: { comments?: IssueComment[], listStatus?: number, minimized?: string[], nodesStatus?: number, fails?: Record<string, unknown[]> }) => Recorded[]}
 */
function mockAPI(
	t,
	{
		comments: listed = [],
		listStatus,
		minimized = [],
		nodesStatus,
		fails = {},
	},
) {
	nock.disableNetConnect();
	/** @type {Recorded[]} */
	const requests = [];
	const scope = nock('https://api.github.com').persist();
	/** @type {(handler: (body: any) => [number, unknown]) => (req: Request) => Promise<[number, unknown]>} */
	const handle = (handler) => async (req) => {
		const url = new URL(req.url);
		const text = await req.text();
		const body = text ? JSON.parse(text) : null;
		requests.push({
			method: req.method,
			path: `${url.pathname}${url.search}`,
			body,
		});
		return handler(body);
	};
	scope.get(/^\/repos\/o\/r\/issues\/9\/comments\?/).reply(/** @type {any} */ (handle(() => (listStatus ? [listStatus, { message: 'Not Found: o/secret' }] : [200, listed]))));
	scope.post('/graphql').reply(/** @type {any} */ (handle(({ query, variables }) => {
		if (query.includes('nodes(')) {
			if (nodesStatus) {
				return [nodesStatus, { message: 'Server Error: o/secret' }];
			}
			/** @type {{ ids: string[] }} */
			const { ids } = variables;
			return [200, { data: { nodes: ids.map((id) => ({ id, isMinimized: minimized.includes(id) })) } }];
		}
		return fails[variables.id]
			? [200, { data: { minimizeComment: null }, errors: fails[variables.id] }]
			: [200, { data: { minimizeComment: { minimizedComment: { isMinimized: true } } } }];
	})));
	t.teardown(() => {
		nock.cleanAll();
		nock.enableNetConnect();
	});
	return requests;
}

/** @type {(requests: Recorded[]) => [string, string][]} */
function hidden(requests) {
	return requests.filter((r) => r.path === '/graphql' && r.body.query.includes('minimizeComment')).map((r) => [r.body.variables.id, r.body.variables.classifier]);
}

/**
 * Runs `hideEarlierReplies` on issue 9 of `o/r`, for a reply to `line` in comments `ours` (by the bot), returning how many it hid and what it logged.
 * @type {(line: string, ours: { id: number, author?: string }[]) => Promise<{ count: number, stdout: string }>}
 */
async function hide(line, ours) {
	let stdout = '';
	const { write } = process.stdout;
	process.stdout.write = /** @type {typeof write} */ (function (/** @type {string} */ chunk) {
		stdout += String(chunk);
		return true;
	});
	try {
		const count = await hideEarlierReplies({
			octokit: getOctokit('ghs_test'),
			owner: 'o',
			repo: 'r',
			number: 9,
			command: command(line),
			ours,
		});
		return { count, stdout };
	} finally {
		process.stdout.write = write;
	}
}

test('hideEarlierReplies', (t) => {
	const line = '/dry-run merge o/secret';

	t.test('hides every part of each earlier reply to the same command, as outdated', async (st) => {
		const requests = mockAPI(st, {
			comments: /** @type {IssueComment[]} */ ([]).concat(
				comments(1, oldReply(line, 2)),
				comments(3, newReply(line)),
				comments(4, newReply(line)),
				comments(5, newReply('/dry-run merge o/other')),
				comments(6, newReply(line, 2)),
				comments(8, newReply(line)),
			),
			minimized: ['IC_3'],
		});
		const { count, stdout } = await hide(line, [{ id: 6, author: bot }, { id: 7, author: bot }]);
		st.equal(count, 3, 'saying how many it hid');
		st.deepEqual(hidden(requests), [['IC_1', 'OUTDATED'], ['IC_2', 'OUTDATED'], ['IC_4', 'OUTDATED']], 'skipping one already hidden, another command’s, the reply just posted, and anything posted after it');
		st.equal(stdout, 'hid 3 of the App’s earlier replies to this command as outdated\n', 'logging only how many');
	});

	t.test('when the reply just posted isn’t listed yet, every other comment is earlier', async (st) => {
		const requests = mockAPI(st, { comments: comments(1, newReply(line)) });
		const { count } = await hide(line, [{ id: 6, author: bot }]);
		st.equal(count, 1, 'hiding it');
		st.deepEqual(hidden(requests), [['IC_1', 'OUTDATED']], 'as outdated');
	});

	t.test('nothing to hide', async (st) => {
		const requests = mockAPI(st, { comments: comments(1, newReply('/merge o/secret')) });
		const { count, stdout } = await hide(line, [{ id: 6, author: bot }]);
		st.equal(count, 0, 'hides nothing');
		st.deepEqual(requests.map((r) => r.method), ['GET'], 'without even looking them up');
		st.equal(stdout, '', 'and logs nothing');
	});

	t.test('without knowing who the bot is', async (st) => {
		const requests = mockAPI(st, { comments: comments(1, newReply(line)) });
		st.equal((await hide(line, [{ id: 6 }])).count, 0, 'hides nothing');
		st.equal((await hide(line, [])).count, 0, 'nor without any reply');
		st.deepEqual(requests, [], 'reading nothing');
	});

	t.test('failing to read the comments only warns, never saying which command, nor what GitHub said', async (st) => {
		mockAPI(st, { listStatus: 404 });
		const { count, stdout } = await hide(line, [{ id: 6, author: bot }]);
		st.equal(count, 0, 'hides nothing');
		st.equal(stdout, '::warning::could not read the App’s earlier replies to this command, to hide them as outdated (HTTP 404)\n', 'warning');
		st.notOk(stdout.includes('secret'), 'never naming the command’s filters');
	});

	t.test('failing to look them up only warns', async (st) => {
		mockAPI(st, { comments: comments(1, newReply(line)), nodesStatus: 500 });
		const { count, stdout } = await hide(line, [{ id: 6, author: bot }]);
		st.equal(count, 0, 'hides nothing');
		st.equal(stdout, '::warning::could not read the App’s earlier replies to this command, to hide them as outdated (HTTP 500)\n', 'warning');
	});

	t.test('failing to hide one only warns, and hides the rest', async (st) => {
		const requests = mockAPI(st, {
			comments: comments(1, newReply(line, 3)),
			fails: { IC_2: [{ type: 'FORBIDDEN', message: 'Resource not accessible by integration: o/secret IC_2' }] },
		});
		const { count, stdout } = await hide(line, [{ id: 6, author: bot }]);
		st.equal(count, 2, 'hiding the rest');
		st.deepEqual(hidden(requests).map(([id]) => id), ['IC_1', 'IC_2', 'IC_3'], 'having tried every one');
		st.equal(stdout, '::warning::could not hide 1 of the App’s earlier replies to this command as outdated (FORBIDDEN)\nhid 2 of the App’s earlier replies to this command as outdated\n', 'warning, never naming the command’s filters');
	});

	t.test('a failure with nothing to say about it only warns that it failed', async (st) => {
		mockAPI(st, {
			comments: comments(1, newReply(line)),
			fails: { IC_1: [{ message: 'something went wrong with o/secret' }] },
		});
		const { count, stdout } = await hide(line, [{ id: 6, author: bot }]);
		st.equal(count, 0, 'hiding nothing');
		st.equal(stdout, '::warning::could not hide 1 of the App’s earlier replies to this command as outdated\n', 'warning, without anything GitHub said');
	});

	t.end();
});

/**
 * Runs `hideResolved` on issue 9 of `o/r`, for `repositories`, once the comments `ours` (by the bot) are posted, returning how many it hid and what it logged.
 * @type {(repositories: string[], ours: { id: number, author?: string }[]) => Promise<{ count: number, stdout: string }>}
 */
async function hideAbout(repositories, ours) {
	let stdout = '';
	const { write } = process.stdout;
	process.stdout.write = /** @type {typeof write} */ (function (/** @type {string} */ chunk) {
		stdout += String(chunk);
		return true;
	});
	try {
		const count = await hideResolved({
			octokit: getOctokit('ghs_test'),
			owner: 'o',
			repo: 'r',
			number: 9,
			repositories,
			ours,
		});
		return { count, stdout };
	} finally {
		process.stdout.write = write;
	}
}

test('hideResolved', (t) => {
	const listed = /** @type {IssueComment[]} */ ([]).concat(
		comments(1, ['/merge O/Secret'], 'maintainer'),
		comments(2, newReply('/merge o/secret')),
		comments(3, ['/merge o/other'], 'maintainer'),
		comments(4, newReply('/merge o/other')),
		comments(5, newReply('/merge o/secret')),
	);

	t.test('hides every comment only about those repositories before the App’s, as resolved', async (st) => {
		const requests = mockAPI(st, { comments: listed, minimized: ['IC_2'] });
		const { count, stdout } = await hideAbout(['o/secret'], [{ id: 5, author: bot }]);
		st.equal(count, 1, 'saying how many it hid');
		st.deepEqual(hidden(requests), [['IC_1', 'RESOLVED']], 'skipping one already hidden, those about another repository, and the App’s own new comment');
		st.equal(stdout, 'hid 1 comment about a repository whose PRs the App has all merged as resolved\n', 'logging only how many');
	});

	t.test('hides what’s about each of them', async (st) => {
		const requests = mockAPI(st, { comments: listed });
		const { count, stdout } = await hideAbout(['o/secret', 'O/Other'], [{ id: 5, author: bot }]);
		st.equal(count, 4, 'hiding those about each');
		st.deepEqual(hidden(requests).map(([id]) => id), ['IC_1', 'IC_2', 'IC_3', 'IC_4'], 'whatever case they’re in');
		st.equal(stdout, 'hid 4 comments about a repository whose PRs the App has all merged as resolved\n', 'logging how many');
	});

	t.test('about no repository, reads nothing', async (st) => {
		const requests = mockAPI(st, { comments: listed });
		st.equal((await hideAbout([], [{ id: 5, author: bot }])).count, 0, 'hides nothing');
		st.deepEqual(requests, [], 'reading nothing');
	});

	t.test('failing only warns, never naming a repository', async (st) => {
		mockAPI(st, { listStatus: 404 });
		const unread = await hideAbout(['o/secret'], [{ id: 5, author: bot }]);
		st.equal(unread.stdout, '::warning::could not read the comments on the report, to hide those about a repository whose PRs the App has all merged as resolved (HTTP 404)\n', 'when they can’t be read');

		nock.cleanAll();
		mockAPI(st, {
			comments: listed,
			fails: { IC_1: [{ type: 'FORBIDDEN', message: 'o/secret' }] },
		});
		const { count, stdout } = await hideAbout(['o/secret'], [{ id: 5, author: bot }]);
		st.equal(count, 1, 'hiding the rest');
		st.equal(stdout, '::warning::could not hide 1 of the comments about a repository whose PRs the App has all merged as resolved (FORBIDDEN)\nhid 1 comment about a repository whose PRs the App has all merged as resolved\n', 'or when one can’t be hidden');
		st.notOk(stdout.includes('secret'), 'never naming it');
	});

	t.end();
});
