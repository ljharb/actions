import { getOctokit } from '@actions/github';
import nock from 'nock';
import test from 'tape';

import {
	classify,
	hideSaid,
	hideStale,
	marker,
	parseMarker,
} from '../../../fleet/lib/said.mjs';
import { bot, mallory } from './helpers/git.mjs';

/** @import { Test } from 'tape' */
/** @import { Current } from '../../../fleet/lib/said.mjs' */
/** @typedef {{ id?: number, node_id?: string, user?: { login: string } | null, body?: string }} Comment */
/**
 * How the mocked API answers: the PR's `comments` (or `listStatus`, failing that), which of them are already `minimized` (`deleted`: looked up as nothing, with a `NOT_FOUND` error, as GitHub answers an ID it can't find), and whether looking them up (`nodesStatus`, or `nodesErrors`, as GraphQL errors) or hiding each (`fails`, by node id, with those GraphQL errors) fails.
 * @typedef {{
 *   comments?: Comment[],
 *   listStatus?: number,
 *   minimized?: string[],
 *   deleted?: string[],
 *   nodesStatus?: number,
 *   nodesErrors?: unknown[],
 *   fails?: Record<string, unknown[]>,
 * }} Scenario
 */
/** @typedef {{ method: string, path: string, body: any }} Recorded */

const head = 'a'.repeat(40);
const oldHead = 'b'.repeat(40);
const base = 'c'.repeat(40);
const oldBase = 'd'.repeat(40);
const olderHead = 'e'.repeat(40);

/** @type {Current} */
const rebased = {
	previous: oldHead,
	head,
	base,
	resolved: [
		'foreign',
		'conflict',
		'empty',
	],
};

/** @type {(t: Test, scenario: Scenario) => Recorded[]} */
function mockAPI(
	t,
	{
		comments = [],
		listStatus,
		minimized = [],
		deleted = [],
		nodesStatus,
		nodesErrors,
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
		requests.push({ method: req.method, path: `${url.pathname}${url.search}`, body });
		return handler(body);
	};
	scope.get(/^\/repos\/o\/r\/issues\/3\/comments\?/).reply(/** @type {any} */ (handle(() => (listStatus ? [listStatus, { message: 'Not Found: o/r' }] : [200, comments]))));
	scope.post('/graphql').reply(/** @type {any} */ (handle(({ query, variables }) => {
		if (query.includes('nodes(')) {
			if (nodesStatus) {
				return [nodesStatus, { message: 'Server Error: o/r' }];
			}
			/** @type {{ ids: string[] }} */
			const { ids } = variables;
			const data = { nodes: ids.map((id) => (deleted.includes(id) ? null : { id, isMinimized: minimized.includes(id) })) };
			const errors = /** @type {unknown[]} */ ([]).concat(
				nodesErrors ?? [],
				ids.filter((id) => deleted.includes(id)).map((id) => ({ type: 'NOT_FOUND', path: ['nodes', ids.indexOf(id)], message: `Could not resolve to a node with the global id of '${id}'` })),
			);
			return [200, errors.length > 0 ? { data, errors } : { data }];
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

/** @type {(requests: Recorded[]) => string[][]} */
function lookedUp(requests) {
	return requests.filter((r) => r.path === '/graphql' && r.body.query.includes('nodes(')).map((r) => r.body.variables.ids);
}

/**
 * Runs `hideStale` on PR 3 of `o/r` with `current`, in a public repository unless `isPrivate`, returning how many it hid and what it logged.
 * @type {(current?: Current, isPrivate?: boolean) => Promise<{ count: number, stdout: string }>}
 */
async function hide(current = rebased, isPrivate = false) {
	let stdout = '';
	const { write } = process.stdout;
	process.stdout.write = /** @type {typeof write} */ (function (/** @type {string} */ chunk) {
		stdout += String(chunk);
		return true;
	});
	try {
		const count = await hideStale({
			octokit: getOctokit('ghs_test'),
			owner: 'o',
			name: 'r',
			number: 3,
			author: bot.name,
			current,
			isPrivate,
		});
		return { count, stdout };
	} finally {
		process.stdout.write = write;
	}
}

/** @type {(id: string, body: string, login?: string) => Comment} */
function said(id, body, login = bot.name) {
	return {
		id: Number(id.replace(/\D/g, '')) || 1,
		node_id: id, // eslint-disable-line camelcase
		user: { login },
		body,
	};
}

test('marker and parseMarker', (t) => {
	t.equal(marker('stuck', head), `<!-- fleet:stuck:${head} -->`, 'a marker about a head commit');
	t.equal(marker('conflict', head, base), `<!-- fleet:conflict:${head}:${base} -->`, 'and about a base’s tip too');

	t.deepEqual(parseMarker(`${marker('foreign', head)}\nsaid`), { kind: 'foreign', head }, '`foreign` is about a head commit');
	t.deepEqual(parseMarker(`${marker('stuck', head)}\nsaid`), { kind: 'stuck', head }, 'as is `stuck`');
	t.deepEqual(parseMarker(`${marker('conflict', head, base)}\nsaid`), { kind: 'conflict', head, base }, '`conflict` is about a base’s tip too');
	t.deepEqual(parseMarker(`${marker('empty', head, base)}\nsaid`), { kind: 'empty', head, base }, 'as is `empty`');

	/** @type {[string, string | null | undefined][]} */
	const others = [
		['no body', undefined],
		['a null body', null],
		['no marker', 'just a comment'],
		['a marker that isn’t on the first line', `quoting\n${marker('stuck', head)}\nsaid`],
		['a marker with nothing after it', marker('stuck', head)],
		['an unknown kind', `<!-- fleet:other:${head} -->\nsaid`],
		['`conflict` without a base’s tip', `${marker('conflict', head)}\nsaid`],
		['`empty` without a base’s tip', `${marker('empty', head)}\nsaid`],
		['`stuck` with a base’s tip', `${marker('stuck', head, base)}\nsaid`],
		['`foreign` with a base’s tip', `${marker('foreign', head, base)}\nsaid`],
		['a head that isn’t a commit', '<!-- fleet:stuck:HEAD -->\nsaid'],
	];
	others.forEach(([label, body]) => {
		t.equal(parseMarker(body), null, `${label}: not one of the App’s`);
	});
	t.end();
});

test('classify', (t) => {
	/** @type {[string, Parameters<typeof classify>[0], Current, ReturnType<typeof classify>][]} */
	const cases = [
		['`foreign`, about the current head', { kind: 'foreign', head }, rebased, null],
		['`stuck`, about the current head', { kind: 'stuck', head }, rebased, null],
		['`conflict`, about the current head and base’s tip', { kind: 'conflict', head, base }, rebased, null],
		['`empty`, about the current head and base’s tip', { kind: 'empty', head, base }, rebased, null],
		['`foreign`, about the head the update replaced, which it resolved', { kind: 'foreign', head: oldHead }, rebased, 'RESOLVED'],
		['`conflict`, about the head a clean rebase replaced', { kind: 'conflict', head: oldHead, base: oldBase }, rebased, 'RESOLVED'],
		['`conflict`, about the head a clean rebase replaced, on its base’s current tip', { kind: 'conflict', head: oldHead, base }, rebased, 'RESOLVED'],
		['`conflict`, about the current head on an earlier base’s tip, after a rebase that kept it', { kind: 'conflict', head, base: oldBase }, rebased, 'OUTDATED'],
		['`empty`, about the head replaced by one that changes something on its base’s tip', { kind: 'empty', head: oldHead, base }, rebased, 'RESOLVED'],
		['`stuck`, about the head a rebase only replaced', { kind: 'stuck', head: oldHead }, rebased, 'OUTDATED'],
		['`stuck`, about the head replaced by an update that resolved it', { kind: 'stuck', head: oldHead }, { ...rebased, resolved: ['stuck'] }, 'RESOLVED'],
		['`conflict`, about an earlier base’s tip, by an update that didn’t resolve it', { kind: 'conflict', head: oldHead, base: oldBase }, { ...rebased, resolved: [] }, 'OUTDATED'],
		['`foreign`, about the head replaced by an update that didn’t resolve it', { kind: 'foreign', head: oldHead }, { ...rebased, resolved: [] }, 'OUTDATED'],
		['`conflict`, about a head an earlier update had already replaced', { kind: 'conflict', head: olderHead, base: oldBase }, rebased, 'OUTDATED'],
		['`stuck`, about a head an earlier update had already replaced, even by one that resolves it', { kind: 'stuck', head: olderHead }, { ...rebased, resolved: ['stuck'] }, 'OUTDATED'],
		['`foreign`, with no head known to have been replaced', { kind: 'foreign', head: oldHead }, { ...rebased, previous: null }, 'OUTDATED'],
	];
	cases.forEach(([label, marked, current, expected]) => {
		t.equal(classify(marked, current), expected, `${label}: ${expected ?? 'still applies'}`);
	});
	t.end();
});

test('hideStale', (t) => {
	t.test('hides each of the bot’s comments that no longer applies, and nothing else', async (st) => {
		const requests = mockAPI(st, {
			comments: [
				said('C_foreign', `${marker('foreign', oldHead)}\nhas someone else’s commits`),
				said('C_conflict', `${marker('conflict', oldHead, oldBase)}\nconflicts`),
				said('C_empty', `${marker('empty', oldHead, base)}\nempty`),
				said('C_stuck', `${marker('stuck', oldHead)}\nstuck`),
				said('C_older', `${marker('conflict', olderHead, oldBase)}\nconflicted, at a head replaced even earlier`),
				said('C_current_stuck', `${marker('stuck', head)}\nstill stuck`),
				said('C_current_conflict', `${marker('conflict', head, base)}\nstill conflicts`),
				said('C_theirs', `${marker('foreign', oldHead)}\nquoting the bot`, mallory.name),
				said('C_plain', 'no marker'),
				said('C_minimized', `${marker('stuck', oldHead)}\nalready hidden`),
				said('C_deleted', `${marker('foreign', oldHead)}\ndeleted since it was listed`),
				{ id: 99, user: { login: bot.name }, body: `${marker('stuck', oldHead)}\nno node id` },
				{ id: 100, user: null, body: `${marker('stuck', oldHead)}\nno user` },
			],
			minimized: ['C_minimized'],
			deleted: ['C_deleted'],
		});
		const { count, stdout } = await hide();
		st.deepEqual(
			lookedUp(requests),
			[[
				'C_foreign',
				'C_conflict',
				'C_empty',
				'C_stuck',
				'C_older',
				'C_minimized',
				'C_deleted',
			]],
			'looks up whether each of the bot’s comments that no longer applies is already hidden, in one query',
		);
		st.deepEqual(
			hidden(requests),
			[
				['C_foreign', 'RESOLVED'],
				['C_conflict', 'RESOLVED'],
				['C_empty', 'RESOLVED'],
				['C_stuck', 'OUTDATED'],
				['C_older', 'OUTDATED'],
			],
			'hides each, as resolved or outdated; never what still applies, anyone else’s, one without a marker, one already hidden, or one deleted since it was listed',
		);
		st.equal(count, 5, 'returning how many it hid');
		st.equal(stdout, '', 'warning about nothing');
		st.end();
	});

	t.test('with nothing to hide, looks nothing up', async (st) => {
		const requests = mockAPI(st, {
			comments: [said('C_current', `${marker('stuck', head)}\nstill stuck`), said('C_theirs', `${marker('stuck', oldHead)}\nnot the bot`, mallory.name)],
		});
		const { count, stdout } = await hide();
		st.equal(count, 0, 'hides nothing');
		st.deepEqual(requests.map((r) => `${r.method} ${r.path.split('?')[0]}`), ['GET /repos/o/r/issues/3/comments'], 'only listing the comments');
		st.equal(stdout, '', 'warning about nothing');
		st.end();
	});

	t.test('looks comments up 100 at a time', async (st) => {
		const comments = Array.from({ length: 101 }, (_, i) => said(`C_${i}`, `${marker('stuck', oldHead)}\nstuck`));
		const requests = mockAPI(st, { comments });
		const { count } = await hide();
		st.deepEqual(lookedUp(requests).map((ids) => ids.length), [100, 1], 'in two queries');
		st.equal(count, 101, 'hiding them all');
		st.end();
	});

	t.test('a failure to list or look up the comments only warns, without saying where', async (st) => {
		mockAPI(st, { listStatus: 404 });
		const listed = await hide();
		st.equal(listed.count, 0, 'listing: hides nothing');
		st.equal(listed.stdout, '::warning::could not read the App’s earlier comments on one of its PRs, to hide those that no longer apply (HTTP 404)\n', 'listing: warns, with only its status');
		nock.cleanAll();

		const requests = mockAPI(st, { comments: [said('C_stuck', `${marker('stuck', oldHead)}\nstuck`)], nodesStatus: 500 });
		const looked = await hide();
		st.equal(looked.count, 0, 'looking up: hides nothing');
		st.deepEqual(hidden(requests), [], 'looking up: never tries to');
		st.equal(looked.stdout, '::warning::could not read the App’s earlier comments on one of its PRs, to hide those that no longer apply (HTTP 500)\n', 'looking up: warns, with only its status');
		nock.cleanAll();

		const erred = mockAPI(st, {
			comments: [said('C_stuck', `${marker('stuck', oldHead)}\nstuck`), said('C_deleted', `${marker('stuck', oldHead)}\ndeleted`)],
			deleted: ['C_deleted'],
			nodesErrors: [{ type: 'RATE_LIMITED', message: 'something about o/r' }],
		});
		const limited = await hide();
		st.equal(limited.count, 0, 'looking up, with any error but a missing comment: hides nothing');
		st.deepEqual(hidden(erred), [], 'looking up, with any error but a missing comment: never tries to');
		st.equal(limited.stdout, '::warning::could not read the App’s earlier comments on one of its PRs, to hide those that no longer apply (RATE_LIMITED, NOT_FOUND)\n', 'looking up, with any error but a missing comment: warns, with only its error types');
		st.end();
	});

	t.test('in a private repository, a failure isn’t even warned about', async (st) => {
		mockAPI(st, { listStatus: 404 });
		const listed = await hide(rebased, true);
		st.equal(listed.count, 0, 'listing: hides nothing');
		st.equal(listed.stdout, '', 'listing: logs nothing');
		nock.cleanAll();

		mockAPI(st, {
			comments: [said('C_1', `${marker('stuck', oldHead)}\nstuck`), said('C_2', `${marker('stuck', oldHead)}\nstuck`)],
			fails: { C_1: [{ type: 'FORBIDDEN', message: 'Resource not accessible by integration: o/r' }] },
		});
		const hid = await hide(rebased, true);
		st.equal(hid.count, 1, 'hiding: counts only what it hid');
		st.equal(hid.stdout, '', 'hiding: logs nothing');
		st.end();
	});

	t.test('a failure to hide one only warns, without saying where, and the rest are still hidden', async (st) => {
		const requests = mockAPI(st, {
			comments: [
				said('C_1', `${marker('stuck', oldHead)}\nstuck`),
				said('C_2', `${marker('stuck', oldHead)}\nstuck`),
				said('C_3', `${marker('stuck', oldHead)}\nstuck`),
			],
			fails: {
				C_1: [{ type: 'FORBIDDEN', message: 'Resource not accessible by integration: o/r' }],
				C_3: [{ message: 'something about o/r' }],
			},
		});
		const { count, stdout } = await hide();
		st.deepEqual(
			hidden(requests).map(([id]) => id),
			[
				'C_1',
				'C_2',
				'C_3',
			],
			'tries each',
		);
		st.equal(count, 1, 'counting only what it hid');
		st.equal(stdout, '::warning::could not hide 2 of the App’s earlier comments on one of its PRs that no longer apply (FORBIDDEN)\n', 'warns once, with only the first failure’s error type');
		nock.cleanAll();

		mockAPI(st, {
			comments: [said('C_1', `${marker('stuck', oldHead)}\nstuck`)],
			fails: { C_1: [{ message: 'something about o/r' }] },
		});
		const untyped = await hide();
		st.equal(untyped.stdout, '::warning::could not hide 1 of the App’s earlier comments on one of its PRs that no longer apply\n', 'with no details, when there are none to give');
		st.end();
	});

	t.end();
});

test('hideSaid', (t) => {
	/** @type {(writer: () => Promise<ReturnType<typeof getOctokit>>) => Promise<{ count: number, stdout: string }>} */
	const resolve = async (writer) => {
		let stdout = '';
		const { write } = process.stdout;
		process.stdout.write = /** @type {typeof write} */ (function (/** @type {string} */ chunk) {
			stdout += String(chunk);
			return true;
		});
		try {
			const count = await hideSaid({
				octokit: getOctokit('ghs_read'),
				writer,
				owner: 'o',
				name: 'r',
				number: 3,
				author: bot.name,
				isPrivate: false,
				classifierOf: () => 'RESOLVED',
				unread: 'unread',
				unhidden: (n) => `unhidden ${n}`,
			});
			return { count, stdout };
		} finally {
			process.stdout.write = write;
		}
	};

	t.test('hides with what `writer` makes, only when there’s something to hide', async (st) => {
		const requests = mockAPI(st, {
			comments: [
				said('C_stuck', `${marker('stuck', head)}\nstuck`),
				said('C_minimized', `${marker('stuck', oldHead)}\nalready hidden`),
			],
			minimized: ['C_minimized'],
		});
		let made = 0;
		const { count } = await resolve(async () => {
			made += 1;
			return getOctokit('ghs_write');
		});
		st.equal(count, 1, 'hiding what’s left');
		st.deepEqual(hidden(requests), [['C_stuck', 'RESOLVED']], 'as `classifierOf` says');
		st.equal(made, 1, 'with a writer made once');
	});

	t.test('with nothing left to hide, never makes the writer', async (st) => {
		mockAPI(st, {
			comments: [said('C_minimized', `${marker('stuck', oldHead)}\nalready hidden`)],
			minimized: ['C_minimized'],
		});
		const { count } = await resolve(async () => {
			throw new Error('never made');
		});
		st.equal(count, 0, 'hiding nothing');
	});

	t.test('failing to make the writer only warns', async (st) => {
		mockAPI(st, { comments: [said('C_stuck', `${marker('stuck', head)}\nstuck`)] });
		const { count, stdout } = await resolve(async () => {
			throw Object.assign(new Error('no token for o/r'), { status: 422 });
		});
		st.equal(count, 0, 'hiding nothing');
		st.equal(stdout, '::warning::unread (HTTP 422)\n', 'warning, without saying where');
	});

	t.end();
});
