import {
	readFileSync,
	writeFileSync,
} from 'fs';
import path from 'path';

import { getOctokit } from '@actions/github';
import nock from 'nock';
import test from 'tape';

import { appAuth } from '../../../fleet/lib/app.mjs';
import { fixBranch } from '../../../fleet/lib/branches.mjs';
import {
	assertBotOwned,
	botIdentity,
	checkout,
	closePR,
	commentOnce,
	commitChanges,
	findMarked,
	findPR,
	foreignCommits,
	isSingleOnBase,
	ownCommits,
	publish,
	pushBranch,
	remoteTip,
} from '../../../fleet/lib/pr.mjs';
import { privateKey } from './helpers/github.mjs';
import {
	bot,
	git as fixtureGit,
	isolateProcessGit,
	mallory,
	makeServer,
	tempDir,
	writeFiles,
} from './helpers/git.mjs';

/** @import { PRState } from '../../../fleet/lib/pr.mjs' */
/** @import { Server, Person } from './helpers/git.mjs' */
/** @import { Test } from 'tape' */
/** @typedef {{ method: string, path: string, body: any, authorization: string }} Recorded */
/** @typedef {(request: { path: string, body: any }) => [number, unknown]} Handler */

const repository = 'o/r';
const owner = 'o';
const name = 'r';
const base = 'main';
const branch = fixBranch;
const lockfile = '.github/workflows/actions.lock';
const files = {
	[lockfile]: 'base lock\n',
	'.github/workflows/ci.yml': 'on: push\n',
	'README.md': 'readme\n',
};
/** @type {(file: string) => boolean} */
const isWorkflow = (file) => file.startsWith('.github/workflows/');
/** @type {(file: string) => boolean} */
const isLockfile = (file) => file === lockfile;

/**
 * Mocks the GitHub REST API: each handler is `[method, path pattern, reply]`; every request is recorded.
 * @type {(t: Test, handlers: [string, RegExp, Handler][]) => Recorded[]}
 */
function mockAPI(t, handlers) {
	nock.disableNetConnect();
	/** @type {Recorded[]} */
	const requests = [];
	const scope = nock('https://api.github.com').persist();
	handlers.forEach(([method, pattern, handler]) => {
		scope.intercept(pattern, method).reply(/** @type {any} */ (async (/** @type {Request} */ req) => {
			const url = new URL(req.url);
			const text = await req.text();
			const body = text ? JSON.parse(text) : null;
			const requestPath = `${url.pathname}${url.search}`;
			requests.push({
				method: req.method,
				path: requestPath,
				body,
				authorization: req.headers.get('authorization') ?? '',
			});
			return handler({ path: requestPath, body });
		}));
	});
	t.teardown(() => {
		nock.cleanAll();
		// nock's net-connect block is process-wide; lift it so later test files in this tape process are unaffected
		nock.enableNetConnect();
	});
	return requests;
}

/** @type {Handler} */
const updated = ({ path: p }) => [200, { html_url: `https://github.com/o/r/pull/${p.split('/').pop()}` }]; // eslint-disable-line camelcase

/**
 * Runs `fn`, returning the values it masks via `core.setSecret`, which writes `::add-mask::` commands to stdout.
 * @type {<T>(fn: () => T) => { result: T, masks: string[] }}
 */
function captureMasks(fn) {
	/** @type {string[]} */
	const masks = [];
	const { write } = process.stdout;
	process.stdout.write = /** @type {typeof write} */ (function (/** @type {string} */ chunk, /** @type {any[]} */ ...rest) {
		const match = String(chunk).match(/^::add-mask::(?<value>.*)$/m);
		if (match?.groups) {
			masks.push(match.groups.value);
			return true;
		}
		return write.call(process.stdout, chunk, ...rest);
	});
	try {
		return { result: fn(), masks };
	} finally {
		process.stdout.write = write;
	}
}

/** @type {(t: Test, server: Server, extra?: { base?: string }) => ReturnType<typeof checkout> & { dir: string }} */
function clone(t, server, extra = {}) {
	const dir = path.join(tempDir(t, 'fleet-pr-clone'), 'repo');
	return {
		...captureMasks(() => checkout({
			serverURL: server.serverURL,
			repository,
			base: extra.base ?? base,
			token: 'ghs_test',
			identity: bot,
			dir,
		})).result,
		dir,
	};
}

/** @type {(t: Test, key: string, value: string | undefined) => void} */
function setEnv(t, key, value) {
	const saved = process.env[key];
	if (typeof value === 'undefined') {
		delete process.env[key];
	} else {
		process.env[key] = value;
	}
	t.teardown(() => {
		if (typeof saved === 'undefined') {
			delete process.env[key];
		} else {
			process.env[key] = saved;
		}
	});
}

/** @type {(t: Test, extra?: Record<string, string>) => Server} */
function setup(t, extra = {}) {
	isolateProcessGit(t);
	return makeServer(t, repository, { ...files, ...extra });
}

/** @type {(dir: string, message: string, contents: Record<string, string | null>) => void} */
function botCommit(dir, message, contents) {
	writeFiles(dir, contents);
	fixtureGit(dir, ['add', '--all'], bot);
	fixtureGit(dir, ['commit', '--quiet', '--message', message], bot);
}

test('botIdentity', async (t) => {
	t.test('the App’s bot user', async (st) => {
		const requests = mockAPI(st, [
			['GET', /^\/app$/, () => [200, { id: 1, slug: 'fleet-bot' }]],
			['POST', /^\/app\/installations\/5\/access_tokens$/, () => [201, { token: 'ghs_identity', expires_at: '2099-01-01T00:00:00Z' }]], // eslint-disable-line camelcase
			['GET', /^\/users\//, () => [200, { id: 42, login: 'fleet-bot[bot]' }]],
		]);

		const identity = await botIdentity(appAuth('1', privateKey()), 5);

		st.deepEqual(identity, bot, 'the bot’s login and noreply email');
		st.deepEqual(
			requests.map((r) => `${r.method} ${r.path}`),
			[
				'GET /app',
				'POST /app/installations/5/access_tokens',
				'GET /users/fleet-bot%5Bbot%5D',
			],
			'reads the App, then a token, then the bot user',
		);
		st.deepEqual(requests[1].body, { permissions: { metadata: 'read' } }, 'the token only needs to read metadata');
		st.equal(requests[2].authorization, 'token ghs_identity', 'the bot user is read with the installation token');
		st.end();
	});

	t.test('no slug', async (st) => {
		const requests = mockAPI(st, [['GET', /^\/app$/, () => [200, { id: 1 }]]]);

		await botIdentity(appAuth('1', privateKey()), 5).then(
			() => st.fail('should reject'),
			(e) => st.equal(e.message, 'could not determine the GitHub App’s slug', 'rejects without a slug'),
		);
		st.equal(requests.length, 1, 'stops after reading the App');
		st.end();
	});

	t.test('no App', async (st) => {
		mockAPI(st, [['GET', /^\/app$/, () => [200, null]]]);

		await botIdentity(appAuth('1', privateKey()), 5).then(
			() => st.fail('should reject'),
			(e) => st.equal(e.message, 'could not determine the GitHub App’s slug', 'rejects without an App'),
		);
		st.end();
	});

	t.test('API errors', async (st) => {
		mockAPI(st, [
			['GET', /^\/app$/, () => [200, { id: 1, slug: 'fleet-bot' }]],
			['POST', /^\/app\/installations\/5\/access_tokens$/, () => [201, { token: 'ghs_identity', expires_at: '2099-01-01T00:00:00Z' }]], // eslint-disable-line camelcase
			['GET', /^\/users\//, () => [404, { message: 'Not Found' }]],
		]);

		await botIdentity(appAuth('1', privateKey()), 5).then(
			() => st.fail('should reject'),
			(e) => st.equal(e.status, 404, 'propagates a failure to read the bot user'),
		);
		st.end();
	});

	t.end();
});

test('checkout', (t) => {
	const server = setup(t);
	server.commit('dev', { 'dev.txt': 'dev\n' }, { from: 'main' });

	const { git, env, dir } = clone(t, server, { base: 'dev' });

	t.equal(readFileSync(path.join(dir, 'dev.txt'), 'utf8'), 'dev\n', 'clones the base branch');
	t.equal(git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim(), 'dev', 'checked out');
	t.equal(git(['config', '--get', 'remote.origin.tagOpt']).stdout.trim(), '--no-tags', 'without tags');
	t.equal(git(['config', '--get', `http.${server.serverURL}/.extraheader`]).stdout.trim(), `AUTHORIZATION: basic ${Buffer.from('x-access-token:ghs_test').toString('base64')}`, 'authenticated to the server');
	t.equal(git(['config', '--local', '--get-regexp', 'extraheader'], { allowFailure: true }).status, 1, 'without the token in `.git/config`');
	t.deepEqual(
		env,
		{
			GIT_CONFIG_COUNT: '1',
			GIT_CONFIG_KEY_0: `http.${server.serverURL}/.extraheader`,
			GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from('x-access-token:ghs_test').toString('base64')}`,
			GIT_TERMINAL_PROMPT: '0',
			GIT_AUTHOR_NAME: bot.name,
			GIT_AUTHOR_EMAIL: bot.email,
			GIT_COMMITTER_NAME: bot.name,
			GIT_COMMITTER_EMAIL: bot.email,
		},
		'returns the environment it runs git with',
	);

	writeFiles(dir, { 'new.txt': 'new\n' });
	git(['add', 'new.txt']);
	git(['commit', '--quiet', '--message', 'm']);
	t.equal(git(['log', '-1', '--format=%an <%ae>|%cn <%ce>']).stdout.trim(), `${bot.name} <${bot.email}>|${bot.name} <${bot.email}>`, 'commits as the bot');
	t.equal(git(['status', '--porcelain'], { input: '' }).stdout, '', 'passes options through');

	t.throws(
		() => clone(t, server, { base: 'nope' }),
		/`git clone --quiet --no-tags --branch nope /,
		'throws when the clone fails',
	);
	t.end();
});

test('checkout: partial', (t) => {
	const server = setup(t);
	server.commit('main', { 'README.md': 'second\n' });
	server.commit('other', { 'other.txt': 'other\n' }, { from: 'main' });
	const dir = path.join(tempDir(t, 'fleet-pr-clone'), 'repo');
	// a `file://` URL, since a local clone ignores `--depth` and `--filter`
	const { git } = captureMasks(() => checkout({
		serverURL: `file://${server.serverURL}`,
		repository,
		base,
		token: 'ghs_test',
		identity: bot,
		dir,
		partial: { depth: 1 },
	})).result;

	t.equal(git(['rev-parse', '--is-shallow-repository']).stdout.trim(), 'true', 'only as many commits as asked for');
	t.equal(git(['rev-list', '--count', 'HEAD']).stdout.trim(), '1', 'which is one');
	t.equal(git(['config', '--get', 'remote.origin.partialclonefilter']).stdout.trim(), 'blob:none', 'without any file’s contents, which are fetched as they’re read');
	t.equal(git(['config', '--get-all', 'remote.origin.fetch']).stdout.trim(), `+refs/heads/${base}:refs/remotes/origin/${base}`, 'and only the base');
	t.equal(readFileSync(path.join(dir, 'README.md'), 'utf8'), 'second\n', 'at its tip');

	const head = server.commit(branch, { 'x.txt': 'x\n' }, { from: 'main' });
	t.equal(remoteTip(git, branch, { depth: 2 }), head, 'fetching another branch, as deep as asked');
	t.equal(git(['rev-parse', `${head}^`]).stdout.trim(), server.tip('main'), 'with its parent');

	const whole = path.join(tempDir(t, 'fleet-pr-clone'), 'repo');
	const { git: deep } = captureMasks(() => checkout({
		serverURL: `file://${server.serverURL}`,
		repository,
		base,
		token: 'ghs_test',
		identity: bot,
		dir: whole,
		partial: {},
	})).result;
	t.equal(deep(['rev-parse', '--is-shallow-repository']).stdout.trim(), 'false', 'without a depth, every commit');
	t.equal(deep(['config', '--get', 'remote.origin.partialclonefilter']).stdout.trim(), 'blob:none', 'still without any file’s contents');
	t.end();
});

test('checkout: masks the token, and the header that encodes it', (t) => {
	const server = setup(t);
	const dir = path.join(tempDir(t, 'fleet-pr-clone'), 'repo');

	const { masks } = captureMasks(() => checkout({
		serverURL: server.serverURL,
		repository,
		base,
		token: 'ghs_masked',
		identity: bot,
		dir,
	}));

	t.deepEqual(masks, ['ghs_masked', Buffer.from('x-access-token:ghs_masked').toString('base64')], 'both are masked');
	t.end();
});

test('checkout: a server URL with trailing slashes', (t) => {
	const server = setup(t);
	const dir = path.join(tempDir(t, 'fleet-pr-clone'), 'repo');

	const { git, env } = captureMasks(() => checkout({
		serverURL: `${server.serverURL}//`,
		repository,
		base,
		token: 'ghs_test',
		identity: bot,
		dir,
	})).result;

	t.equal(git(['config', '--get', 'remote.origin.url']).stdout.trim(), `${server.serverURL}/o/r.git`, 'clones without doubled slashes');
	t.equal(env.GIT_CONFIG_KEY_0, `http.${server.serverURL}/.extraheader`, 'and authenticates to the same server');
	t.end();
});

test('checkout: the workflow’s server', (t) => {
	const server = setup(t);
	setEnv(t, 'GITHUB_SERVER_URL', `${server.serverURL}/`);
	const dir = path.join(tempDir(t, 'fleet-pr-clone'), 'repo');

	const { git, env } = captureMasks(() => checkout({
		repository,
		base,
		token: 'ghs_test',
		identity: bot,
		dir,
	})).result;

	t.equal(git(['config', '--get', 'remote.origin.url']).stdout.trim(), `${server.serverURL}/o/r.git`, 'clones from `GITHUB_SERVER_URL`');
	t.equal(env.GIT_CONFIG_KEY_0, `http.${server.serverURL}/.extraheader`, 'authenticated to it');
	t.end();
});

test('checkout: the default server', (t) => {
	const server = setup(t);
	setEnv(t, 'GITHUB_SERVER_URL', undefined);
	// stands in for github.com, so the default server URL is really cloned from, without any network access
	const config = path.join(tempDir(t, 'fleet-pr-config'), 'gitconfig');
	writeFileSync(config, `[url "${server.serverURL}/"]\n\tinsteadOf = https://github.com/\n`);
	process.env.GIT_CONFIG_GLOBAL = config;
	const dir = path.join(tempDir(t, 'fleet-pr-clone'), 'repo');

	const { git, env } = captureMasks(() => checkout({
		repository,
		base,
		token: 'ghs_test',
		identity: bot,
		dir,
	})).result;

	t.equal(git(['config', '--get', 'remote.origin.url']).stdout.trim(), 'https://github.com/o/r.git', 'clones from github.com');
	t.equal(env.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraheader', 'authenticated to github.com');
	t.equal(readFileSync(path.join(dir, 'README.md'), 'utf8'), 'readme\n', 'cloned');
	t.end();
});

test('findPR', async (t) => {
	/** @type {[string, unknown[], PRState][]} */
	const cases = [
		['none', [], { mode: 'create' }],
		[
			'merged',
			[{
				number: 3,
				state: 'closed',
				merged_at: '2026-01-01T00:00:00Z', // eslint-disable-line camelcase
				head: { sha: 'abc' },
			}],
			{ mode: 'create' },
		],
		[
			'open',
			[{
				number: 4,
				state: 'open',
				merged_at: null, // eslint-disable-line camelcase
				head: { sha: 'def' },
			}],
			{ mode: 'update', number: 4, head: 'def' },
		],
		[
			'closed',
			[{
				number: 5,
				state: 'closed',
				merged_at: null, // eslint-disable-line camelcase
				head: { sha: '123' },
			}],
			{ mode: 'reopen', number: 5, head: '123' },
		],
	];
	cases.forEach(([label, prs, expected]) => {
		t.test(label, async (st) => {
			const requests = mockAPI(st, [['GET', /^\/repos\/o\/r\/pulls/, () => [200, prs]]]);

			st.deepEqual(
				await findPR(getOctokit('ghs_test'), {
					owner,
					name,
					base,
					branch,
				}),
				expected,
				`${label}: ${expected.mode}`,
			);
			const { searchParams } = new URL(requests[0].path, 'https://api.github.com');
			st.deepEqual(
				Object.fromEntries(searchParams),
				{
					head: `o:${branch}`,
					base,
					state: 'all',
					sort: 'created',
					direction: 'desc',
					per_page: '1', // eslint-disable-line camelcase
				},
				'asks for the newest PR from the owner’s branch into the base',
			);
			st.end();
		});
	});
	t.end();
});

test('remoteTip', (t) => {
	const server = setup(t);
	const { git } = clone(t, server);

	t.equal(remoteTip(git, branch), null, 'no branch');
	const head = server.commit(branch, { 'x.txt': 'x\n' }, { from: 'main' });
	t.equal(remoteTip(git, branch), head, 'the branch’s tip');
	t.equal(git(['cat-file', '-t', head]).stdout.trim(), 'commit', 'fetched');
	t.equal(remoteTip(git, 'fleet'), null, 'not a prefix of it');
	t.end();
});

/** @type {(dir: string, message: string, contents: Record<string, string | null>, committer: Person) => void} */
function commitAs(dir, message, contents, committer) {
	writeFiles(dir, contents);
	fixtureGit(dir, ['add', '--all'], committer);
	fixtureGit(dir, ['commit', '--quiet', '--author', `${bot.name} <${bot.email}>`, '--message', message], committer);
}

test('ownCommits, foreignCommits, and isSingleOnBase', (t) => {
	const server = setup(t);
	const one = server.commit(branch, { [lockfile]: 'bot lock\n' }, { who: bot, from: 'main' });
	const { git } = clone(t, server);
	const at = (/** @type {string} */ tip) => ({
		base,
		tip,
		identity: bot,
	});

	t.deepEqual(ownCommits(git, at(one)), [one], 'one commit of its own');
	t.equal(foreignCommits(git, at(one)), 0, 'the bot’s');
	t.ok(isSingleOnBase(git, at(one)), 'one commit, on the base’s tip');
	t.deepEqual(ownCommits(git, at(server.tip('main'))), [], 'the base has none');
	t.notOk(isSingleOnBase(git, at(server.tip('main'))), 'so isn’t one commit on it');

	const two = server.commit(branch, { [lockfile]: 'newer lock\n' }, { who: bot });
	remoteTip(git, branch);
	t.deepEqual(ownCommits(git, at(two)), [two, one], 'two commits, newest first');
	t.notOk(isSingleOnBase(git, at(two)), 'isn’t one commit');

	const theirs = server.commit(branch, { 'README.md': 'theirs\n' }, { who: mallory });
	remoteTip(git, branch);
	t.equal(foreignCommits(git, at(theirs)), 1, 'someone else’s commit');
	const shouting = server.commit(branch, { 'README.md': 'loud\n' }, { who: { name: bot.name, email: bot.email.toUpperCase() } });
	remoteTip(git, branch);
	t.equal(foreignCommits(git, at(shouting)), 1, 'emails are matched in any case: only the earlier one is someone else’s');

	server.commit('main', { 'README.md': 'moved\n' });
	git(['fetch', '--quiet', 'origin']);
	t.notOk(isSingleOnBase(git, at(one)), 'one commit, on an older base commit, isn’t');

	const { git: other, dir } = clone(t, server);
	commitAs(dir, 'committed by someone else', { [lockfile]: 'x\n' }, mallory);
	const head = other(['rev-parse', 'HEAD']).stdout.trim();
	t.equal(
		foreignCommits(other, {
			base,
			tip: head,
			identity: bot,
		}),
		1,
		'the bot’s authorship, committed by someone else, is someone else’s',
	);
	t.end();
});

test('assertBotOwned', (t) => {
	const server = setup(t);
	const mine = server.commit(branch, { [lockfile]: 'bot lock\n' }, { who: bot, from: 'main' });
	const theirs = server.commit(branch, { 'README.md': 'theirs\n' }, { who: mallory });
	const { git } = clone(t, server);
	remoteTip(git, branch);

	t.doesNotThrow(
		() => assertBotOwned(git, {
			base,
			branch,
			tip: mine,
			identity: bot,
		}),
		'only the bot’s commits',
	);
	t.throws(
		() => assertBotOwned(git, {
			base,
			branch,
			tip: theirs,
			identity: bot,
		}),
		new Error('`fleet/workflows` has 1 commit(s) by someone else, so it is never overwritten; remove them from the branch, or delete the branch, so the next run can rebuild it'),
		'refuses anyone else’s',
	);
	t.end();
});

test('commitChanges', (t) => {
	t.test('nothing to commit', (st) => {
		const server = setup(st);
		const { git } = clone(st, server);
		st.equal(
			commitChanges(git, {
				base,
				message: 'm',
				paths: ['.github/workflows'],
				allowed: isWorkflow,
			}),
			false,
			'commits nothing',
		);
		st.equal(git(['rev-parse', 'HEAD']).stdout.trim(), server.tip('main'), 'still at the base');
		st.end();
	});

	t.test('changes to allowed files', (st) => {
		const server = setup(st);
		const { git, dir } = clone(st, server);
		writeFiles(dir, { [lockfile]: 'new lock\n', '.github/workflows/new.yml': 'on: pull_request\n', 'README.md': 'not staged\n' });
		st.equal(
			commitChanges(git, {
				base,
				message: 'the message',
				paths: ['.github/workflows'],
				allowed: isWorkflow,
			}),
			true,
			'commits',
		);
		st.equal(git(['rev-parse', 'HEAD^']).stdout.trim(), server.tip('main'), 'on the base’s tip');
		st.equal(git(['log', '-1', '--format=%s|%ae|%ce']).stdout.trim(), `the message|${bot.email}|${bot.email}`, 'as the bot');
		st.deepEqual(git(['diff', '--name-only', 'HEAD^', 'HEAD']).stdout.trim().split('\n'), ['.github/workflows/actions.lock', '.github/workflows/new.yml'], 'only what’s under the paths');
		st.end();
	});

	t.test('changes that aren’t `worth` a commit', (st) => {
		const server = setup(st);
		const { git, dir } = clone(st, server);
		writeFiles(dir, { [lockfile]: 'new lock\n', '.github/workflows/new.yml': 'on: pull_request\n' });
		/** @type {string[][]} */
		const seen = [];
		st.equal(
			commitChanges(git, {
				base,
				message: 'm',
				paths: ['.github/workflows'],
				allowed: isWorkflow,
				worth(changed) {
					seen.push(changed);
					return false;
				},
			}),
			false,
			'commits nothing',
		);
		st.deepEqual(seen, [['.github/workflows/actions.lock', '.github/workflows/new.yml']], 'given every staged file');
		st.equal(git(['rev-parse', 'HEAD']).stdout.trim(), server.tip('main'), 'still at the base');
		st.end();
	});

	t.test('changes to anything else: refused', (st) => {
		const server = setup(st);
		const { git, dir } = clone(st, server);
		writeFiles(dir, { [lockfile]: 'new lock\n', '.github/workflows/ci.yml': null });
		st.throws(
			() => commitChanges(git, {
				base,
				message: 'm',
				paths: ['.github/workflows'],
				allowed: isLockfile,
			}),
			new Error('refusing to commit changes to files this job doesn’t write: `.github/workflows/ci.yml`'),
			'names what isn’t allowed',
		);
		st.equal(git(['rev-parse', 'HEAD']).stdout.trim(), server.tip('main'), 'commits nothing');
		st.end();
	});

	t.test('not at the base’s tip: refused', (st) => {
		const server = setup(st);
		const { git, dir } = clone(st, server);
		botCommit(dir, 'already', { [lockfile]: 'x\n' });
		writeFiles(dir, { [lockfile]: 'y\n' });
		st.throws(
			() => commitChanges(git, {
				base,
				message: 'm',
				paths: ['.github/workflows'],
				allowed: isWorkflow,
			}),
			new Error('the clone is not at `main`’s tip, so nothing is committed'),
			'so the commit is always one on the base',
		);
		st.end();
	});

	t.end();
});

test('pushBranch', (t) => {
	t.test('only the App’s own branches', (st) => {
		const server = setup(st);
		const before = server.tip('main');
		const { git, dir } = clone(st, server);
		botCommit(dir, 'm', { [lockfile]: 'x\n' });
		st.throws(
			() => pushBranch(git, {
				base,
				branch: 'main',
				tip: null,
				identity: bot,
			}),
			new Error('`main` is not one of the App’s own branches, so it is never overwritten'),
			'refuses any other branch',
		);
		st.equal(server.tip('main'), before, 'pushes nothing');
		st.end();
	});

	t.test('only one commit, on the base’s tip', (st) => {
		const server = setup(st);
		const { git, dir } = clone(st, server);
		st.throws(
			() => pushBranch(git, {
				base,
				branch,
				tip: null,
				identity: bot,
			}),
			new Error('refusing to push `fleet/workflows`: it must be one commit on top of `main`’s tip'),
			'refuses the base itself',
		);
		botCommit(dir, 'one', { [lockfile]: 'x\n' });
		botCommit(dir, 'two', { [lockfile]: 'y\n' });
		st.throws(
			() => pushBranch(git, {
				base,
				branch,
				tip: null,
				identity: bot,
			}),
			/must be one commit/,
			'refuses two commits',
		);
		st.equal(server.tip(`refs/heads/${branch}`), '', 'pushes nothing');
		st.end();
	});

	t.test('no branch yet: a plain push', (st) => {
		const server = setup(st);
		const { git, dir } = clone(st, server);
		botCommit(dir, 'm', { [lockfile]: 'x\n' });
		st.equal(
			pushBranch(git, {
				base,
				branch,
				tip: null,
				identity: bot,
			}),
			'pushed',
			'pushes',
		);
		st.equal(server.tip(`refs/heads/${branch}`), git(['rev-parse', 'HEAD']).stdout.trim(), 'the commit');
		st.end();
	});

	t.test('already that tree, on the base’s tip: left alone', (st) => {
		const server = setup(st);
		const head = server.commit(branch, { [lockfile]: 'x\n' }, { who: bot, from: 'main' });
		const { git, dir } = clone(st, server);
		const tip = remoteTip(git, branch);
		botCommit(dir, 'rebuilt', { [lockfile]: 'x\n' });
		st.notEqual(git(['rev-parse', 'HEAD']).stdout.trim(), head, 'a new commit');
		st.equal(
			pushBranch(git, {
				base,
				branch,
				tip,
				identity: bot,
			}),
			'unchanged',
			'pushes nothing',
		);
		st.equal(server.tip(`refs/heads/${branch}`), head, 'the branch is as it was');
		st.end();
	});

	t.test('anything else: replaced, with a lease', (st) => {
		const server = setup(st);
		server.commit(branch, { [lockfile]: 'x\n' }, { who: bot, from: 'main' });
		server.commit(branch, { [lockfile]: 'y\n' }, { who: bot });
		const { git, dir } = clone(st, server);
		const tip = remoteTip(git, branch);
		botCommit(dir, 'rebuilt', { [lockfile]: 'y\n' });
		st.equal(
			pushBranch(git, {
				base,
				branch,
				tip,
				identity: bot,
			}),
			'pushed',
			'two commits with the same tree are replaced by one',
		);
		st.deepEqual(server.log(`main..${branch}`).map((line) => line.split('|')[2]), ['rebuilt'], 'which is all the branch has');

		server.commit('main', { 'README.md': 'moved\n' });
		const { git: again, dir: againDir } = clone(st, server);
		const before = remoteTip(again, branch);
		botCommit(againDir, 'rebuilt again', { [lockfile]: 'y\n' });
		st.equal(
			pushBranch(again, {
				base,
				branch,
				tip: before,
				identity: bot,
			}),
			'pushed',
			'the same tree on an older base commit is rebuilt on the new one',
		);
		st.equal(server.log(`${branch}`)[0].split('|')[3], server.tip('main'), 'whose only parent is the base’s tip');
		st.end();
	});

	t.test('someone else’s commits: refused', (st) => {
		const server = setup(st);
		server.commit(branch, { [lockfile]: 'x\n' }, { who: bot, from: 'main' });
		const theirs = server.commit(branch, { 'README.md': 'theirs\n' }, { who: mallory });
		const { git, dir } = clone(st, server);
		const tip = remoteTip(git, branch);
		botCommit(dir, 'rebuilt', { [lockfile]: 'z\n' });
		st.throws(
			() => pushBranch(git, {
				base,
				branch,
				tip,
				identity: bot,
			}),
			/has 1 commit\(s\) by someone else, so it is never overwritten/,
			'refuses',
		);
		st.equal(server.tip(`refs/heads/${branch}`), theirs, 'their work survives');
		st.end();
	});

	t.test('the branch moved after it was read: the lease fails', (st) => {
		const server = setup(st);
		server.commit(branch, { [lockfile]: 'x\n' }, { who: bot, from: 'main' });
		const { git, dir } = clone(st, server);
		const tip = remoteTip(git, branch);
		const moved = server.commit(branch, { [lockfile]: 'pushed meanwhile\n' }, { who: bot });
		botCommit(dir, 'rebuilt', { [lockfile]: 'z\n' });
		st.throws(
			() => pushBranch(git, {
				base,
				branch,
				tip,
				identity: bot,
			}),
			new Error('`fleet/workflows` changed after it was read, so it was not overwritten (its push was rejected); the next run rebuilds it from what it is now'),
			'refuses, without retrying',
		);
		st.equal(server.tip(`refs/heads/${branch}`), moved, 'the other push survives');
		st.end();
	});

	t.end();
});

/** @type {(requests: Recorded[]) => [string, any][]} */
const writes = (requests) => requests.map((r) => [`${r.method} ${r.path}`, r.body]);

test('publish', (t) => {
	const common = {
		owner,
		name,
		base,
		branch,
		identity: bot,
		title: 'the title',
		body: 'the body',
		isPrivate: false,
	};

	t.test('a branch that isn’t the App’s: refused before anything', async (st) => {
		const server = setup(st);
		const requests = mockAPI(st, []);
		const { git, dir } = clone(st, server);
		botCommit(dir, 'the title', { [lockfile]: 'bot lock\n' });
		await publish({
			...common,
			branch: 'feature',
			octokit: getOctokit('ghs_test'),
			git,
			state: { mode: 'reopen', number: 5, head: 'abc' },
			tip: null,
		}).then(
			() => st.fail('should reject'),
			(e) => st.equal(e.message, '`feature` is not one of the App’s own branches, so it is never overwritten', 'rejects'),
		);
		st.equal(server.tip('refs/heads/feature'), '', 'pushes nothing');
		st.deepEqual(requests, [], 'touches no PR');
		st.end();
	});

	t.test('someone else’s commits: refused, before pushing or touching the PR', async (st) => {
		const server = setup(st);
		const head = server.commit(branch, { [lockfile]: 'their lock\n' }, { who: mallory, from: 'main' });
		server.setRef('refs/pull/5/head', head);
		server.deleteRef(`refs/heads/${branch}`);
		const requests = mockAPI(st, [['PATCH', /^\/repos\/o\/r\/pulls\/\d+$/, updated]]);
		const { git, dir } = clone(st, server);
		botCommit(dir, 'the title', { [lockfile]: 'bot lock\n' });

		await publish({
			...common,
			octokit: getOctokit('ghs_test'),
			git,
			state: { mode: 'reopen', number: 5, head },
			tip: null,
		}).then(
			() => st.fail('should reject'),
			(e) => st.match(e.message, /has 1 commit\(s\) by someone else, so it is never overwritten/, 'rejects via `assertBotOwned`'),
		);
		st.equal(server.tip(`refs/heads/${branch}`), '', 'pushes nothing, not even the restored branch');
		st.deepEqual(requests, [], 'touches no PR');
		st.end();
	});

	t.test('create', async (st) => {
		const server = setup(st);
		const requests = mockAPI(st, [['POST', /^\/repos\/o\/r\/pulls$/, () => [201, { html_url: 'https://github.com/o/r/pull/9' }]]]); // eslint-disable-line camelcase
		const { git, dir } = clone(st, server);
		botCommit(dir, 'the title', { [lockfile]: 'bot lock\n' });

		const outcome = await publish({
			...common,
			octokit: getOctokit('ghs_test'),
			git,
			state: { mode: 'create' },
			tip: null,
		});

		st.equal(outcome, 'created https://github.com/o/r/pull/9', 'reports the new PR');
		st.equal(server.tip(`refs/heads/${branch}`), git(['rev-parse', 'HEAD']).stdout.trim(), 'pushes the branch');
		st.deepEqual(
			writes(requests),
			[[
				'POST /repos/o/r/pulls',
				{
					base,
					head: branch,
					title: 'the title',
					body: 'the body',
				},
			]],
			'opens the PR',
		);
		st.end();
	});

	t.test('update', async (st) => {
		const server = setup(st);
		const head = server.commit(branch, { [lockfile]: 'bot lock\n' }, { who: bot, from: 'main' });
		const requests = mockAPI(st, [['PATCH', /^\/repos\/o\/r\/pulls\/\d+$/, updated]]);
		const { git, dir } = clone(st, server);
		const tip = remoteTip(git, branch);
		botCommit(dir, 'the title', { [lockfile]: 'newer lock\n' });

		const outcome = await publish({
			...common,
			octokit: getOctokit('ghs_test'),
			git,
			state: { mode: 'update', number: 4, head },
			tip,
		});

		st.equal(outcome, 'updated https://github.com/o/r/pull/4', 'reports the PR');
		st.equal(server.show(branch, lockfile), 'newer lock', 'pushes the branch');
		st.deepEqual(server.log(`main..${branch}`).map((line) => line.split('|')[2]), ['the title'], 'as one commit, replacing the old one');
		st.deepEqual(writes(requests), [['PATCH /repos/o/r/pulls/4', { title: 'the title', body: 'the body' }]], 'updates the PR');
		st.end();
	});

	t.test('update, with nothing new', async (st) => {
		const server = setup(st);
		const head = server.commit(branch, { [lockfile]: 'bot lock\n' }, { who: bot, from: 'main' });
		const requests = mockAPI(st, [['PATCH', /^\/repos\/o\/r\/pulls\/\d+$/, updated]]);
		const { git, dir } = clone(st, server);
		const tip = remoteTip(git, branch);
		botCommit(dir, 'the title', { [lockfile]: 'bot lock\n' });

		const outcome = await publish({
			...common,
			octokit: getOctokit('ghs_test'),
			git,
			state: { mode: 'update', number: 4, head },
			tip,
		});

		st.equal(outcome, 'already up to date: https://github.com/o/r/pull/4', 'says so');
		st.equal(server.tip(`refs/heads/${branch}`), head, 'pushes nothing');
		st.deepEqual(writes(requests), [['PATCH /repos/o/r/pulls/4', { title: 'the title', body: 'the body' }]], 'still updates the PR’s title and body');
		st.end();
	});

	t.test('reopen, with the remote branch', async (st) => {
		const server = setup(st);
		const head = server.commit(branch, { [lockfile]: 'bot lock\n' }, { who: bot, from: 'main' });
		const requests = mockAPI(st, [['PATCH', /^\/repos\/o\/r\/pulls\/\d+$/, updated]]);
		const { git, dir } = clone(st, server);
		const tip = remoteTip(git, branch);
		botCommit(dir, 'the title', { [lockfile]: 'newer lock\n' });

		const outcome = await publish({
			...common,
			octokit: getOctokit('ghs_test'),
			git,
			state: { mode: 'reopen', number: 5, head },
			tip,
		});

		st.equal(outcome, 'reopened and updated https://github.com/o/r/pull/5', 'reports the PR');
		st.equal(server.show(branch, lockfile), 'newer lock', 'pushes the branch');
		st.deepEqual(
			writes(requests),
			[
				['PATCH /repos/o/r/pulls/5', { state: 'open' }],
				['PATCH /repos/o/r/pulls/5', { title: 'the title', body: 'the body' }],
			],
			'reopens, then updates, the PR',
		);
		st.end();
	});

	t.test('reopen, when its update would be refused: refused before reopening', async (st) => {
		const server = setup(st);
		server.commit(branch, { [lockfile]: 'bot lock\n' }, { who: bot, from: 'main' });
		const requests = mockAPI(st, [['PATCH', /^\/repos\/o\/r\/pulls\/\d+$/, updated]]);
		const { git, dir } = clone(st, server);
		const tip = remoteTip(git, branch);
		const moved = server.commit(branch, { [lockfile]: 'pushed meanwhile\n' }, { who: bot });
		botCommit(dir, 'the title', { [lockfile]: 'newer lock\n' });

		await publish({
			...common,
			octokit: getOctokit('ghs_test'),
			git,
			state: { mode: 'reopen', number: 5, head: String(tip) },
			tip,
		}).then(
			() => st.fail('should reject'),
			(e) => st.equal(e.message, '`fleet/workflows` changed after it was read, so it was not overwritten (its push was rejected); the next run rebuilds it from what it is now', 'a branch that moved since it was read would fail the lease'),
		);
		st.equal(server.tip(`refs/heads/${branch}`), moved, 'pushes nothing');

		server.setRef('refs/pull/5/head', moved);
		await publish({
			...common,
			octokit: getOctokit('ghs_test'),
			git,
			state: { mode: 'reopen', number: 5, head: moved },
			tip: null,
		}).then(
			() => st.fail('should reject'),
			(e) => st.match(e.message, /changed after it was read/, 'as would a branch that’s there, when it wasn’t'),
		);

		const { git: two, dir: twoDir } = clone(st, server);
		const twoTip = remoteTip(two, branch);
		botCommit(twoDir, 'one', { [lockfile]: 'one\n' });
		botCommit(twoDir, 'two', { [lockfile]: 'two\n' });
		await publish({
			...common,
			octokit: getOctokit('ghs_test'),
			git: two,
			state: { mode: 'reopen', number: 5, head: String(twoTip) },
			tip: twoTip,
		}).then(
			() => st.fail('should reject'),
			(e) => st.equal(e.message, 'refusing to push `fleet/workflows`: it must be one commit on top of `main`’s tip', 'as would anything but one commit on the base’s tip'),
		);
		st.equal(server.tip(`refs/heads/${branch}`), moved, 'pushing nothing');
		st.deepEqual(requests, [], 'never reopening the PR');
		st.end();
	});

	t.test('reopen, without the remote branch', async (st) => {
		const server = setup(st);
		const head = server.commit(branch, { [lockfile]: 'bot lock\n' }, { who: bot, from: 'main' });
		server.setRef('refs/pull/5/head', head);
		server.deleteRef(`refs/heads/${branch}`);
		/** @type {string[]} */
		const tipsAtReopen = [];
		const requests = mockAPI(st, [[
			'PATCH',
			/^\/repos\/o\/r\/pulls\/\d+$/,
			(request) => {
				tipsAtReopen.push(server.tip(`refs/heads/${branch}`));
				return updated(request);
			},
		]]);
		const { git, dir } = clone(st, server);
		botCommit(dir, 'the title', { [lockfile]: 'newer lock\n' });
		const final = git(['rev-parse', 'HEAD']).stdout.trim();

		const outcome = await publish({
			...common,
			octokit: getOctokit('ghs_test'),
			git,
			state: { mode: 'reopen', number: 5, head },
			tip: null,
		});

		st.equal(outcome, 'reopened and updated https://github.com/o/r/pull/5', 'reports the PR');
		st.deepEqual(tipsAtReopen, [head, final], 'restores the branch at the PR’s head before reopening, then replaces it');
		st.deepEqual(server.log(`main..${branch}`).length, 1, 'with one commit');
		st.deepEqual(
			writes(requests),
			[
				['PATCH /repos/o/r/pulls/5', { state: 'open' }],
				['PATCH /repos/o/r/pulls/5', { title: 'the title', body: 'the body' }],
			],
			'reopens, then updates, the PR',
		);
		st.end();
	});

	t.test('update: hides what the App said on it that no longer applies', async (st) => {
		const server = setup(st);
		const head = server.commit(branch, { [lockfile]: 'bot lock\n' }, { who: bot, from: 'main' });
		const { git, dir } = clone(st, server);
		const tip = remoteTip(git, branch);
		botCommit(dir, 'the title', { [lockfile]: 'newer lock\n' });
		const final = git(['rev-parse', 'HEAD']).stdout.trim();
		const requests = mockAPI(st, [
			['PATCH', /^\/repos\/o\/r\/pulls\/\d+$/, updated],
			[
				'GET',
				/^\/repos\/o\/r\/issues\/4\/comments\?/,
				() => [
					200,
					[
						{ node_id: 'C_conflict', user: { login: bot.name }, body: `<!-- fleet:conflict:${head}:${'d'.repeat(40)} -->\nconflicts` }, // eslint-disable-line camelcase
						{ node_id: 'C_stuck', user: { login: bot.name }, body: `<!-- fleet:stuck:${head} -->\nstuck` }, // eslint-disable-line camelcase
						{ node_id: 'C_current', user: { login: bot.name }, body: `<!-- fleet:stuck:${final} -->\nabout the new head` }, // eslint-disable-line camelcase
						{ node_id: 'C_theirs', user: { login: mallory.name }, body: `<!-- fleet:stuck:${head} -->\nnot the bot` }, // eslint-disable-line camelcase
					],
				],
			],
			['POST', /^\/graphql$/, ({ body }) => [200, { data: body.variables.ids ? { nodes: body.variables.ids.map((/** @type {string} */ id) => ({ id, isMinimized: false })) } : { minimizeComment: { minimizedComment: { isMinimized: true } } } }]],
		]);

		const outcome = await publish({
			...common,
			octokit: getOctokit('ghs_test'),
			git,
			state: { mode: 'update', number: 4, head },
			tip,
		});

		st.equal(outcome, 'updated https://github.com/o/r/pull/4; hid 2 of the App’s earlier comments on it that no longer apply', 'reports the PR, and what it hid');
		st.deepEqual(
			requests.filter((r) => r.path === '/graphql' && r.body.variables.classifier).map((r) => [r.body.variables.id, r.body.variables.classifier]),
			[
				['C_conflict', 'RESOLVED'],
				['C_stuck', 'OUTDATED'],
			],
			'once it’s one commit on its base’s tip, a conflict it reported is resolved, and that it was stuck is outdated; what’s about its new head, and anyone else’s, are left alone',
		);
		st.end();
	});

	t.test('update: failing to hide what the App said only warns, and, in a private repository, not even that', async (st) => {
		const server = setup(st);
		const head = server.commit(branch, { [lockfile]: 'bot lock\n' }, { who: bot, from: 'main' });
		mockAPI(st, [
			['PATCH', /^\/repos\/o\/r\/pulls\/\d+$/, updated],
			['GET', /^\/repos\/o\/r\/issues\/4\/comments\?/, () => [200, [{ node_id: 'C_stuck', user: { login: bot.name }, body: `<!-- fleet:stuck:${head} -->\nstuck` }]]], // eslint-disable-line camelcase
			['POST', /^\/graphql$/, ({ body }) => [200, body.variables.ids ? { data: { nodes: body.variables.ids.map((/** @type {string} */ id) => ({ id, isMinimized: false })) } } : { data: { minimizeComment: null }, errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible by integration: o/r' }] }]],
		]);
		/** @type {(isPrivate: boolean, contents: string) => Promise<{ outcome: string, stdout: string }>} */
		const update = async (isPrivate, contents) => {
			const { git, dir } = clone(st, server);
			const tip = remoteTip(git, branch);
			botCommit(dir, 'the title', { [lockfile]: contents });
			let stdout = '';
			const { write } = process.stdout;
			process.stdout.write = /** @type {typeof write} */ (function (/** @type {string} */ chunk) {
				stdout += String(chunk);
				return true;
			});
			try {
				const outcome = await publish({
					...common,
					octokit: getOctokit('ghs_test'),
					git,
					state: { mode: 'update', number: 4, head },
					tip,
					isPrivate,
				});
				return { outcome, stdout };
			} finally {
				process.stdout.write = write;
			}
		};

		const shown = await update(false, 'newer lock\n');
		st.equal(shown.outcome, 'updated https://github.com/o/r/pull/4', 'a public repository’s PR is still updated');
		st.equal(shown.stdout, '::warning::could not hide 1 of the App’s earlier comments on one of its PRs that no longer apply (FORBIDDEN)\n', 'warning, without saying where');

		const hidden = await update(true, 'newest lock\n');
		st.equal(hidden.outcome, 'updated https://github.com/o/r/pull/4', 'a private repository’s PR is still updated');
		st.equal(hidden.stdout, '', 'logging nothing');
		st.end();
	});

	t.test('update, with nothing new: what’s about its head still applies', async (st) => {
		const server = setup(st);
		const head = server.commit(branch, { [lockfile]: 'bot lock\n' }, { who: bot, from: 'main' });
		const requests = mockAPI(st, [
			['PATCH', /^\/repos\/o\/r\/pulls\/\d+$/, updated],
			['GET', /^\/repos\/o\/r\/issues\/4\/comments\?/, () => [200, [{ node_id: 'C_current', user: { login: bot.name }, body: `<!-- fleet:stuck:${head} -->\nstuck` }]]], // eslint-disable-line camelcase
		]);
		const { git, dir } = clone(st, server);
		const tip = remoteTip(git, branch);
		botCommit(dir, 'the title', { [lockfile]: 'bot lock\n' });

		const outcome = await publish({
			...common,
			octokit: getOctokit('ghs_test'),
			git,
			state: { mode: 'update', number: 4, head },
			tip,
		});

		st.equal(outcome, 'already up to date: https://github.com/o/r/pull/4', 'hides nothing');
		st.deepEqual(requests.filter((r) => r.path === '/graphql'), [], 'not even looking anything up');
		st.end();
	});

	t.end();
});

test('commentOnce', async (t) => {
	const marker = '<!-- fleet:x:abc -->';
	/** @type {[string, Record<string, unknown>[], boolean][]} */
	const cases = [
		['no comments', [], true],
		['the marker, by someone else', [{ id: 1, user: { login: 'mallory' }, body: `${marker}\nhi` }], true],
		['another marker, by the bot', [{ id: 1, user: { login: bot.name }, body: '<!-- fleet:x:def -->' }], true],
		['a comment without a body, or a user', [{ id: 1, user: null }], true],
		['the marker, by the bot, but not on its first line', [{ id: 1, user: { login: bot.name }, body: `quoting\n${marker}\nsaid` }], true],
		['the marker, by the bot', [{ id: 1, user: { login: bot.name }, body: `${marker}\nsaid` }], false],
	];
	await cases.reduce(
		async (previous, [label, comments, expected]) => {
			await previous;
			const requests = mockAPI(t, [
				['GET', /^\/repos\/o\/r\/issues\/3\/comments\?/, () => [200, comments]],
				['POST', /^\/repos\/o\/r\/issues\/3\/comments$/, () => [201, {}]],
			]);
			const commented = await commentOnce({
				octokit: getOctokit('ghs_test'),
				owner,
				name,
				number: 3,
				author: bot.name,
				marker,
				body: 'the body',
			});
			t.equal(commented, expected, `${label}: ${expected ? 'comments' : 'says nothing'}`);
			t.deepEqual(requests.filter((r) => r.method === 'POST').map((r) => r.body), expected ? [{ body: `${marker}\nthe body` }] : [], `${label}: with the marker`);
			nock.cleanAll();
		},
		Promise.resolve(),
	);
	t.end();
});

test('findMarked', async (t) => {
	mockAPI(t, [[
		'GET',
		/^\/repos\/o\/r\/issues\/3\/comments\?/,
		() => [
			200,
			[
				{ id: 1, user: { login: 'mallory' }, body: '<!-- a -->\nhi' },
				{ id: 2, user: { login: bot.name }, body: '<!-- c -->\nsaid' },
				{ id: 3, user: { login: bot.name }, body: '<!-- b -->\nsaid' },
			],
		],
	]]);
	t.equal(
		await findMarked({
			octokit: getOctokit('ghs_test'),
			owner,
			name,
			number: 3,
			author: bot.name,
			markers: ['<!-- a -->', '<!-- b -->', '<!-- c -->'],
		}),
		'<!-- b -->',
		'the first of the markers that a comment of the author’s starts with',
	);
	nock.cleanAll();
	mockAPI(t, [['GET', /^\/repos\/o\/r\/issues\/3\/comments\?/, () => [200, [{ id: 1, user: { login: 'mallory' }, body: '<!-- a -->\nhi' }]]]]);
	t.equal(
		await findMarked({
			octokit: getOctokit('ghs_test'),
			owner,
			name,
			number: 3,
			author: bot.name,
			markers: ['<!-- a -->'],
		}),
		null,
		'or none',
	);
	nock.cleanAll();
	t.end();
});

test('closePR', (t) => {
	t.test('with a comment', async (st) => {
		const requests = mockAPI(st, [
			['POST', /^\/repos\/o\/r\/issues\/\d+\/comments$/, () => [201, {}]],
			['PATCH', /^\/repos\/o\/r\/pulls\/\d+$/, updated],
		]);

		await closePR({
			octokit: getOctokit('ghs_test'),
			owner,
			name,
			number: 4,
			comment: 'nothing left',
		});

		st.deepEqual(
			writes(requests),
			[
				['POST /repos/o/r/issues/4/comments', { body: 'nothing left' }],
				['PATCH /repos/o/r/pulls/4', { state: 'closed' }],
			],
			'explains, then closes',
		);
		st.end();
	});

	t.test('without a comment', async (st) => {
		const requests = mockAPI(st, [['PATCH', /^\/repos\/o\/r\/pulls\/\d+$/, updated]]);

		await closePR({
			octokit: getOctokit('ghs_test'),
			owner,
			name,
			number: 4,
		});

		st.deepEqual(writes(requests), [['PATCH /repos/o/r/pulls/4', { state: 'closed' }]], 'just closes');
		st.end();
	});

	t.end();
});

test('closePR: hiding what the App said on it', (t) => {
	const head = 'a'.repeat(40);
	const listed = [
		{ node_id: 'C_stuck', user: { login: bot.name }, body: `<!-- fleet:stuck:${head} -->\nstuck` }, // eslint-disable-line camelcase
		{ node_id: 'C_older', user: { login: bot.name }, body: `<!-- fleet:matches:${'b'.repeat(40)} -->\nabout an older head` }, // eslint-disable-line camelcase
		{ node_id: 'C_why', user: { login: bot.name }, body: `<!-- fleet:matches:${head} -->\nwhy it’s closed` }, // eslint-disable-line camelcase
		{ node_id: 'C_theirs', user: { login: mallory.name }, body: `<!-- fleet:stuck:${head} -->\nnot the bot` }, // eslint-disable-line camelcase
		{ node_id: 'C_plain', user: { login: bot.name }, body: 'no marker' }, // eslint-disable-line camelcase
	];
	/** @type {(requests: { path: string, body: any }[]) => [string, string][]} */
	const hidden = (requests) => requests.filter((r) => r.path === '/graphql' && r.body.variables.classifier).map((r) => [r.body.variables.id, r.body.variables.classifier]);
	/** @type {(fn: () => Promise<void>) => Promise<string>} */
	const output = async (fn) => {
		let stdout = '';
		const { write } = process.stdout;
		process.stdout.write = /** @type {typeof write} */ (function (/** @type {string} */ chunk) {
			stdout += String(chunk);
			return true;
		});
		try {
			await fn();
		} finally {
			process.stdout.write = write;
		}
		return stdout;
	};

	t.test('hides the App’s, as resolved, but what says why it’s closed', async (st) => {
		const requests = mockAPI(st, [
			['PATCH', /^\/repos\/o\/r\/pulls\/\d+$/, updated],
			['GET', /^\/repos\/o\/r\/issues\/4\/comments\?/, () => [200, listed]],
			['POST', /^\/graphql$/, ({ body }) => [200, { data: body.variables.ids ? { nodes: body.variables.ids.map((/** @type {string} */ id) => ({ id, isMinimized: false })) } : { minimizeComment: { minimizedComment: { isMinimized: true } } } }]],
		]);

		await closePR({
			octokit: getOctokit('ghs_test'),
			owner,
			name,
			number: 4,
			said: {
				author: bot.name,
				isPrivate: false,
				kept: { kind: 'matches', head },
			},
		});

		st.deepEqual(writes(requests)[0], ['PATCH /repos/o/r/pulls/4', { state: 'closed' }], 'closes it first');
		st.deepEqual(
			hidden(requests),
			[
				['C_stuck', 'RESOLVED'],
				['C_older', 'RESOLVED'],
			],
			'then hides what the App said on it, about any head commit; never what says why it’s closed, anyone else’s, or a comment without a marker',
		);
		st.end();
	});

	t.test('without anything to keep, hides all of it', async (st) => {
		const requests = mockAPI(st, [
			['PATCH', /^\/repos\/o\/r\/pulls\/\d+$/, updated],
			['GET', /^\/repos\/o\/r\/issues\/4\/comments\?/, () => [200, listed]],
			['POST', /^\/graphql$/, ({ body }) => [200, { data: body.variables.ids ? { nodes: body.variables.ids.map((/** @type {string} */ id) => ({ id, isMinimized: false })) } : { minimizeComment: { minimizedComment: { isMinimized: true } } } }]],
		]);

		await closePR({
			octokit: getOctokit('ghs_test'),
			owner,
			name,
			number: 4,
			said: { author: bot.name, isPrivate: false },
		});

		st.deepEqual(hidden(requests).map(([id]) => id), ['C_stuck', 'C_older', 'C_why'], 'every one of the App’s');
		st.end();
	});

	t.test('failing to hide only warns, and, in a private repository, not even that', async (st) => {
		/** @type {(isPrivate: boolean) => Promise<string>} */
		const close = (isPrivate) => {
			mockAPI(st, [
				['PATCH', /^\/repos\/o\/r\/pulls\/\d+$/, updated],
				['GET', /^\/repos\/o\/r\/issues\/4\/comments\?/, () => [200, listed.slice(0, 1)]],
				['POST', /^\/graphql$/, ({ body }) => [200, body.variables.ids ? { data: { nodes: body.variables.ids.map((/** @type {string} */ id) => ({ id, isMinimized: false })) } } : { data: { minimizeComment: null }, errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible by integration: o/r' }] }]],
			]);
			return output(() => closePR({
				octokit: getOctokit('ghs_test'),
				owner,
				name,
				number: 4,
				said: { author: bot.name, isPrivate },
			}));
		};

		st.match(await close(false), /^::warning::could not hide 1 of the App’s comments on a PR it closed as resolved \(FORBIDDEN\)$/m, 'warns, without saying where');
		st.equal(await close(true), '', 'says nothing about a private one');
		st.end();
	});

	t.test('failing to read its comments only warns', async (st) => {
		mockAPI(st, [
			['PATCH', /^\/repos\/o\/r\/pulls\/\d+$/, updated],
			['GET', /^\/repos\/o\/r\/issues\/4\/comments\?/, () => [502, {}]],
		]);

		const stdout = await output(() => closePR({
			octokit: getOctokit('ghs_test'),
			owner,
			name,
			number: 4,
			said: { author: bot.name, isPrivate: false },
		}));

		st.match(stdout, /^::warning::could not read the App’s comments on a PR it closed, to hide them as resolved/m, 'warns');
		st.end();
	});

	t.end();
});
