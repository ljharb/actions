import {
	chmodSync,
	mkdirSync,
	renameSync,
	writeFileSync,
} from 'fs';
import path from 'path';

import nock from 'nock';
import test from 'tape';

import { appAuth } from '../../../fleet/lib/app.mjs';
import { fixBranch, relockBranch } from '../../../fleet/lib/branches.mjs';
import { maintain, marker, permissions } from '../../../fleet/merge/maintain.mjs';
import { pr } from '../commands/helpers/merge-run.mjs';
import { mockMerge, prCommit } from '../commands/helpers/merge.mjs';
import { template } from '../drift/helpers/states.mjs';
import {
	bot,
	git as fixtureGit,
	isolateProcessGit,
	mallory,
	makeServer,
	tempDir,
} from '../lib/helpers/git.mjs';
import { installedRepo, mockGitHub, privateKey } from '../lib/helpers/github.mjs';

/** @import { Recorded, Scenario } from '../lib/helpers/github.mjs' */
/** @import { MergeScenario } from '../commands/helpers/merge.mjs' */
/** @import { Server } from '../lib/helpers/git.mjs' */
/** @import { Test } from 'tape' */
/** @typedef {{ key: string, user: { login: string }, body: string, node_id?: string }} Comment */

const repository = 'ljharb/r';
const message = '[actions] update workflow files to match ljharb/actions’ templates';
const pretest = '.github/workflows/node-pretest.yml';
const aught = '.github/workflows/node-aught.yml';
const config = '.github/ljharb-actions.json';
const botLine = `${bot.name} <${bot.email}>`;

// tape-testing/tape#625: the App's PR dropped `skip-engines` (still needed) and `skip-ls-check` (not)
const tapePretest = `${template('node-pretest.yml')}    with:\n      skip-engines: true # bin/tape requires node 8+, but the rest of tape supports 0.4+\n`;
const tapeAught = `name: 'Tests: node.js < 10'

on: [pull_request, push]

permissions:
  contents: read

jobs:
  tests:
    uses: ljharb/actions/.github/workflows/node.yml@main
    with:
      range: '< 10'
      type: minors
      command: npm run tests-only
      skip-ls-check: true

  node:
    name: 'node < 10'
    needs: [tests]
    runs-on: ubuntu-latest
    steps:
      - run: true
`;
const fixedAught = tapeAught.replace('      skip-ls-check: true\n', '');

/** @type {() => void} */
let current = () => {};

/**
 * Runs `maintain` once against the mocked API and `server`, returning how many failed, what it logged, and every request.
 * Comments the bot posted on a PR in earlier runs (`posted`, which this adds to) are listed as its comments.
 * With `offline`, the server's repository is out of reach while it runs, so that anything that clones it fails.
 * With `partial`, it's cloned by a `file://` URL from a server that allows filters, so that a clone is really as shallow, and as partial, as asked for (a local clone ignores `--depth` and `--filter`).
 * @type {(t: Test, options: { server: Server, github: Scenario, merge: MergeScenario, posted?: Comment[], offline?: boolean, partial?: boolean }) => Promise<{ errors: number, stdout: string, requests: Recorded[] }>}
 */
async function run(
	t,
	{
		server,
		github,
		merge,
		posted = [],
		offline = false,
		partial = false,
	},
) {
	current();
	nock.disableNetConnect();
	/** @type {Recorded[]} */
	const requests = [];
	const scope = nock('https://api.github.com').persist();
	const listComments = scope.get(/^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments(?:\?.*)?$/);
	listComments.reply(/** @type {any} */ ((/** @type {Request} */ req) => {
		const { pathname, search } = new URL(req.url);
		requests.push({
			method: 'GET',
			path: `${pathname}${search}`,
			body: null,
			authorization: '',
		});
		return [200, posted.filter((c) => c.key === pathname.replace(/\/comments$/, ''))];
	}));
	const teardowns = [mockMerge(merge, (r) => requests.push(r)), mockGitHub(github, (r) => requests.push(r))];
	current = () => {
		nock.removeInterceptor(listComments);
		teardowns.forEach((teardown) => teardown());
		current = () => {};
	};
	t.teardown(() => {
		current();
		nock.enableNetConnect();
	});

	let stdout = '';
	const { write } = process.stdout;
	process.stdout.write = /** @type {typeof write} */ (function (/** @type {string} */ chunk) {
		stdout += String(chunk);
		return true;
	});
	/** @type {number} */
	let errors;
	if (offline) {
		renameSync(server.remote, `${server.remote}.offline`);
	}
	try {
		errors = await maintain(appAuth('1', privateKey()), new Set(['ljharb']), {
			bot: () => Promise.resolve(bot.name),
			serverURL: partial ? `file://${server.serverURL}` : server.serverURL,
		});
	} finally {
		process.stdout.write = write;
		if (offline) {
			renameSync(`${server.remote}.offline`, server.remote);
		}
	}
	requests.filter((x) => x.method === 'POST' && (/\/issues\/\d+\/comments$/).test(x.path)).forEach((r) => {
		posted.push({ key: r.path.replace(/\/comments$/, ''), user: { login: bot.name }, body: r.body.body });
	});
	return { errors, stdout, requests };
}

/** @type {(repos: { name: string, private?: boolean, archived?: boolean, fork?: boolean, open?: [number, number] }[], extra?: Scenario) => Scenario} */
function installed(repos, extra = {}) {
	return {
		installations: [{ id: 1, account: { login: 'ljharb' } }],
		installationRepos: { 1: repos.map((r) => installedRepo('ljharb', r.name, { private: !!r.private })) },
		repos: Object.fromEntries(repos.map((r) => [
			`ljharb/${r.name}`,
			{
				data: {
					isArchived: !!r.archived,
					isFork: !!r.fork,
					p0: { totalCount: r.open?.[0] ?? 1 },
					p1: { totalCount: r.open?.[1] ?? 0 },
				},
			},
		])),
		...extra,
	};
}

/**
 * The commits on `head` that aren't on `main`, as GitHub lists a PR's: oldest first, each linked to the bot's user when it has the bot's email, as GitHub links it.
 * @type {(server: Server, head: string) => Record<string, unknown>[]}
 */
function commitsOf(server, head) {
	/** @type {(email: string) => string | null} */
	const login = (email) => (email === bot.email ? bot.name : null);
	return fixtureGit(server.remote, ['log', '--reverse', '--format=%H %P|%ae|%ce', `main..${head}`]).split('\n').filter(Boolean).map((line) => {
		const [shas, author, committer] = line.split('|');
		const [sha, ...parents] = shas.split(' ');
		return prCommit(sha, {
			author: login(author),
			committer: login(committer),
			authorEmail: author,
			committerEmail: committer,
			parents,
		});
	});
}

/**
 * What the API shows of `server` now: its open PRs (each `[number, branch, head]`), with their commits, and `main`'s tip; and `extra`.
 * @type {(server: Server, pulls: [number, string, string][], extra?: MergeScenario) => MergeScenario}
 */
function shown(server, pulls, extra = {}) {
	return {
		openPulls: { [repository]: pulls.map(([number, branch, sha]) => pr(repository, number, branch, { sha })) },
		commits: Object.fromEntries(pulls.map(([number, , sha]) => [`${repository}#${number}`, commitsOf(server, sha)])),
		refs: { [repository]: server.tip('main') },
		...extra,
	};
}

/** @type {(requests: Recorded[]) => string[]} */
function comments(requests) {
	return requests.filter((r) => r.method === 'POST' && (/\/issues\/\d+\/comments$/).test(r.path)).map((r) => r.body.body);
}

/** @type {(stdout: string) => string[]} */
function logged(stdout) {
	return stdout.split('\n').filter((line) => line && !line.startsWith('::add-mask::'));
}

/** @type {(t: Test, files?: Record<string, string>) => Server} */
function setup(t, files = { [pretest]: tapePretest, [aught]: tapeAught, 'README.md': 'readme\n' }) {
	isolateProcessGit(t);
	return makeServer(t, repository, files);
}

/** @type {(server: Server, number?: number) => string} */
function prURL(server, number = 1) {
	return `${server.serverURL}/ljharb/r/pull/${number}`;
}

/** @type {(head: string, files: string[]) => MergeScenario['ci']} */
function failedIn(head, files) {
	return {
		[head]: {
			checkRuns: [{
				id: 1,
				name: 'tests / engines',
				status: 'completed',
				conclusion: 'failure',
			}],
			runs: files.map((file, i) => ({
				id: 40944612252 + i,
				name: 'Tests: pretest/posttest',
				path: file,
				conclusion: 'failure',
				jobs: [],
			})),
		},
	};
}

/** @typedef {{ checkRuns: Record<string, unknown>[], runs: ({ id: number, jobs: Record<string, unknown>[] } & Record<string, unknown>)[] }} Runs */

/** @typedef {'failed' | 'optional' | 'hidden' | 'passed'} JobOutcome */

/**
 * A GitHub Actions run of `file`, with a job (and its check run, in the run's check suite) for each of `jobs`, each named as its key: one that `failed` failed the run; one that's `optional` failed, but its `continue-on-error` hid that, so the run still succeeded; one that's `hidden` had a step whose failure `continue-on-error` hid, which only its check run's `failure` annotation shows; and one that `passed` passed. `id` is its own, and its check suite's; the IDs after it are its jobs', one each. Unless `extra` says otherwise, the run completed as a failure when any job `failed`, else as a success.
 * @type {(id: number, file: string, jobs: Record<string, JobOutcome>, extra?: Record<string, unknown>) => Runs}
 */
function actionsRun(id, file, jobs, extra = {}) {
	const names = Object.keys(jobs);
	/** @type {(i: number) => string} */
	const url = (i) => `https://api.github.com/repos/ljharb/r/check-runs/${id + i + 1}`;
	return {
		checkRuns: names.map((name, i) => ({
			id: id + i + 1,
			name,
			status: 'completed',
			conclusion: jobs[name] === 'failed' || jobs[name] === 'optional' ? 'failure' : 'success',
			app: { slug: 'github-actions' },
			check_suite: { id }, // eslint-disable-line camelcase
			url: url(i),
			annotations: jobs[name] === 'hidden'
				? [{ annotation_level: 'failure', message: 'Process completed with exit code 1.' }] // eslint-disable-line camelcase
				: [],
		})),
		runs: [
			{
				id,
				path: file,
				check_suite_id: id, // eslint-disable-line camelcase
				conclusion: names.some((name) => jobs[name] === 'failed') ? 'failure' : 'success',
				...extra,
				jobs: names.map((name, i) => ({ name, check_run_url: url(i), steps: [], run_id: id })), // eslint-disable-line camelcase
			},
		],
	};
}

/** @type {(...parts: Runs[]) => Runs} */
function together(...parts) {
	return { checkRuns: parts.flatMap((p) => p.checkRuns), runs: parts.flatMap((p) => p.runs) };
}

test('maintain: with no open PRs from the App’s branches, exits fast', async (t) => {
	const server = setup(t);
	const none = await run(t, { server, github: {}, merge: {} });
	t.equal(none.errors, 0, 'no installations: nothing failed');
	t.deepEqual(logged(none.stdout), ['no open PRs from the App’s branches to keep up to date'], 'says so');
	t.deepEqual(none.requests.map((r) => `${r.method} ${r.path}`), ['GET /app/installations?per_page=100'], 'having only listed the installations');

	const others = await run(t, {
		server,
		github: {
			...installed([
				{ name: 'archived', archived: true },
				{ name: 'fork', fork: true },
				{ name: 'quiet', open: [0, 0] },
			]),
			installations: [
				{ id: 1, account: { login: 'ljharb' } },
				{ id: 2, account: { login: 'stranger' } },
				{ id: 3, account: { login: 'ljharb' }, suspended_at: '2026-01-01T00:00:00Z' }, // eslint-disable-line camelcase
				{ id: 4 },
			],
			installationRepos: {
				1: [
					installedRepo('ljharb', 'archived'),
					installedRepo('ljharb', 'fork'),
					installedRepo('ljharb', 'quiet'),
					installedRepo('ljharb', 'missing'),
					installedRepo('browserify', 'admin'),
				],
			},
		},
		merge: {},
	});
	t.equal(others.errors, 0, 'nothing failed');
	t.deepEqual(logged(others.stdout), ['no open PRs from the App’s branches to keep up to date'], 'an archived repository, a fork, one with no such PRs, one that can’t be read, an ignored one, another account’s, and a suspended installation’s have none');
	t.end();
});

test('maintain: the installed repositories are found in batches, by how many PRs are open from each of the App’s branches', async (t) => {
	const server = setup(t);
	const names = Array.from({ length: 21 }, (_, i) => ({ name: `quiet${i}`, open: /** @type {[number, number]} */ ([0, 0]) }));
	const { requests, stdout } = await run(t, { server, github: installed(names), merge: {} });
	const queries = requests.filter((r) => r.path === '/graphql');
	t.equal(queries.length, 2, 'twenty at a time');
	t.deepEqual(Object.keys(queries[1].body.variables), ['o0', 'n0', 'b0', 'b1'], 'each with the App’s branches');
	t.deepEqual([queries[1].body.variables.b0, queries[1].body.variables.b1], [fixBranch, relockBranch], 'named');
	t.match(queries[0].body.query, /p0: pullRequests\(states: OPEN, headRefName: \$b0\) \{ totalCount \}/, 'counting the open PRs from each');
	t.equal(requests.find((r) => r.path.endsWith('/access_tokens'))?.body.permissions.pull_requests, 'read', 'with a token that can read PRs');
	t.ok(stdout.includes('no open PRs'), 'none open');
	t.end();
});

test('maintain: an installation that can’t be read fails, without naming what it couldn’t read', async (t) => {
	const server = setup(t);
	const { errors, stdout } = await run(t, {
		server,
		github: { ...installed([]), installationRepos: { 1: { status: 500, body: { message: 'ljharb/secret is broken' } } } },
		merge: {},
	});
	t.equal(errors, 1, 'one failure');
	t.ok(stdout.includes('::warning::installation 1 could not be read (HTTP 500)'), 'warning with only its status');
	t.notOk(stdout.includes('secret'), 'never its message');

	const failedQuery = await run(t, { server, github: installed([{ name: 'r' }], { graphqlNullData: ['ljharb/r'] }), merge: {} });
	t.equal(failedQuery.errors, 1, 'as does one whose query fails outright');
	t.ok(failedQuery.stdout.includes('::warning::installation 1 could not be read'), 'warning about it');
	t.end();
});

test('maintain: an installation waiting on its account to approve the App’s permissions is skipped, not failed', async (t) => {
	const server = setup(t);
	const granted = { ...permissions, metadata: 'read' };
	const waiting = await run(t, {
		server,
		github: installed([{ name: 'r' }], {
			installations: [
				{ id: 1, account: { login: 'ljharb' }, permissions: { ...granted, workflows: 'read' } },
				{ id: 2, account: { login: 'es-shims' }, permissions: { metadata: 'read', contents: 'write' } },
			],
		}),
		merge: {},
	});
	t.equal(waiting.errors, 0, 'nothing failed');
	t.deepEqual(
		logged(waiting.stdout),
		[
			'::notice::installation 1 (ljharb) is waiting on its account to approve the App’s permissions (workflows: write), so it’s skipped until then',
			'no open PRs from the App’s branches to keep up to date',
		],
		'saying so, for an installation without a permission keeping its PRs up to date needs',
	);
	t.deepEqual(waiting.requests.map((r) => `${r.method} ${r.path}`), ['GET /app/installations?per_page=100', 'GET /app'], 'without asking for a token, or reading anything but what permissions the App itself has');

	const unavailable = await run(t, {
		server,
		github: installed([{ name: 'r' }], {
			installations: [{ id: 1, account: { login: 'ljharb' }, permissions: { ...granted, workflows: 'read' } }],
			appPermissions: { ...granted, workflows: 'read' },
		}),
		merge: {},
	});
	t.equal(unavailable.errors, 1, 'one lacking a permission the App itself doesn’t have fails, since no approval can give it that');
	t.ok(unavailable.stdout.split('\n').includes('::warning::installation 1: the App itself doesn’t have permissions this needs (workflows: write); give them to it in its settings'), 'naming it');
	t.deepEqual(unavailable.requests.filter((r) => r.path.endsWith('/access_tokens')), [], 'without asking for a token');

	const refused = await run(t, {
		server,
		github: installed([{ name: 'r' }], {
			installations: [{ id: 1, account: { login: 'ljharb' }, permissions: granted }],
			deniedPermissions: ['pull_requests'],
		}),
		merge: {},
	});
	t.equal(refused.errors, 1, 'a token refused for an installation listed with every permission still fails');
	t.ok(refused.stdout.includes('::warning::installation 1 could not be read (HTTP 422)'), 'and is warned about');
	t.end();
});

test('maintain: rebases a PR onto its base’s tip', async (t) => {
	const server = setup(t);
	const head = server.commit(fixBranch, { [aught]: fixedAught }, { who: bot, from: 'main', message });
	const mainTip = server.commit('main', { 'README.md': 'moved\n' });

	const { errors, stdout, requests } = await run(t, {
		server,
		github: installed([{ name: 'r' }]),
		merge: shown(server, [[1, fixBranch, head]]),
	});

	t.equal(errors, 0, 'nothing failed');
	t.ok(logged(stdout).includes(`${prURL(server)}: rebased onto \`main\`’s tip`), 'says so');
	t.notOk(requests.some((r) => r.path.includes('/check-runs') || r.path.includes('/actions/runs')), 'without reading its CI, which is only for one on its base’s tip');
	const tip = server.tip(`refs/heads/${fixBranch}`);
	t.deepEqual(server.log(`main..${tip}`), [`${botLine}|${botLine}|${message}|${mainTip}`], 'one commit by the bot, with its message, whose only parent is the base’s tip');
	t.equal(server.show(tip, aught), fixedAught.trim(), 'with its change');
	t.equal(server.show(tip, 'README.md'), 'moved', 'and the base’s');
	t.deepEqual(comments(requests), [], 'saying nothing on the PR');
	const token = requests.find((r) => r.path.endsWith('/access_tokens') && r.body?.repositories);
	t.deepEqual(token?.body, { repositories: ['r'], permissions }, 'with a token for only that repository');
	t.deepEqual(
		permissions,
		{
			contents: 'write',
			pull_requests: 'write', // eslint-disable-line camelcase
			workflows: 'write',
			checks: 'read',
			actions: 'read',
			statuses: 'read',
		},
		'that can push workflow files, comment, and read CI',
	);
	t.ok(stdout.includes('Open PRs in private repositories, if any, were also kept up to date; nothing about them is shown here.'), 'always ending with the same note about private ones');
	t.end();
});

test('maintain: rebasing keeps `package.json`’s entry for `.github/ljharb-actions.json` there exactly when the file is', async (t) => {
	/** @type {(ignore: string[]) => string} */
	const pkg = (ignore) => `${JSON.stringify(
		{
			name: 'pkg',
			devDependencies: { npmignore: '^0.3.1' },
			publishConfig: { ignore },
		},
		null,
		2,
	)}\n`;
	const files = {
		[pretest]: tapePretest,
		[aught]: tapeAught,
		'README.md': 'readme\n',
	};
	/** @type {(initial: Record<string, string>, change: Record<string, string>, moved: Record<string, string | null>, label: string) => Promise<{ pkgJson: string, line: string | undefined }>} */
	const rebased = async (initial, change, moved, label) => {
		const server = setup(t, { ...files, ...initial });
		const head = server.commit(fixBranch, { [aught]: fixedAught, ...change }, { who: bot, from: 'main', message });
		const mainTip = server.commit('main', moved);
		const { errors, stdout } = await run(t, {
			server,
			github: installed([{ name: 'r' }]),
			merge: shown(server, [[1, fixBranch, head]]),
		});
		t.equal(errors, 0, `${label}: nothing failed`);
		const tip = server.tip(`refs/heads/${fixBranch}`);
		t.deepEqual(server.log(`main..${tip}`), [`${botLine}|${botLine}|${message}|${mainTip}`], `${label}: one commit by the bot, on the base’s tip`);
		t.equal(server.show(tip, aught), fixedAught.trim(), `${label}: with its change`);
		return { pkgJson: `${server.show(tip, 'package.json')}\n`, line: logged(stdout).find((l) => l.startsWith(prURL(server))) };
	};

	const gained = await rebased({ 'package.json': pkg(['.github/workflows', config]) }, { 'package.json': pkg(['.github/workflows']) }, { [config]: '{}\n' }, 'a PR that removed the entry, whose base then gained the config file');
	t.equal(gained.pkgJson, pkg(['.github/workflows', config]), 'the entry is added back, since the config file is there');
	t.ok(String(gained.line).endsWith(': rebased onto `main`’s tip, and added `.github/ljharb-actions.json`, which it now has, to `package.json`’s `publishConfig.ignore`'), 'and says so');

	const lost = await rebased({ 'package.json': pkg(['.github/workflows']), [config]: '{}\n' }, { 'package.json': pkg(['.github/workflows', config]) }, { [config]: null }, 'a PR that added the entry, whose base then lost the config file');
	t.equal(lost.pkgJson, pkg(['.github/workflows']), 'the entry is removed, since the config file isn’t there');
	t.ok(String(lost.line).endsWith(': rebased onto `main`’s tip, and removed `.github/ljharb-actions.json`, which it no longer has, from `package.json`’s `publishConfig.ignore`'), 'and says so');

	const kept = await rebased({ 'package.json': pkg(['.github/workflows']), [config]: '{}\n' }, { 'package.json': pkg(['.github/workflows', config]) }, { 'README.md': 'moved\n' }, 'a PR that added the entry, whose base still has the config file');
	t.equal(kept.pkgJson, pkg(['.github/workflows', config]), 'the entry is kept');
	t.ok(String(kept.line).endsWith(': rebased onto `main`’s tip'), 'and nothing else is said');

	const untouched = await rebased({ 'package.json': pkg(['.github/workflows']) }, {}, { [config]: '{}\n' }, 'a PR that doesn’t touch either, whose base then gained the config file');
	t.equal(untouched.pkgJson, pkg(['.github/workflows']), 'is only replayed, since what the base has isn’t its change');
	t.ok(String(untouched.line).endsWith(': rebased onto `main`’s tip'), 'and nothing else is said');
	t.end();
});

test('maintain: rebasing and restoring work in a shallow clone without file contents', async (t) => {
	const server = setup(t, {
		[pretest]: tapePretest,
		[aught]: tapeAught,
		'README.md': 'readme\n',
		'big.txt': 'not needed\n',
	});
	fixtureGit(server.remote, ['config', 'uploadpack.allowFilter', 'true']);
	server.commit('main', { 'old.txt': 'history\n' });
	const rebasing = server.commit(fixBranch, { [aught]: fixedAught }, { who: bot, from: 'main', message });
	const mainTip = server.commit('main', { 'README.md': 'moved\n' });
	const first = await run(t, {
		server,
		github: installed([{ name: 'r' }]),
		merge: shown(server, [[1, fixBranch, rebasing]]),
		partial: true,
	});
	t.equal(first.errors, 0, 'rebasing: nothing failed');
	const rebased = server.tip(`refs/heads/${fixBranch}`);
	t.deepEqual(server.log(`main..${rebased}`), [`${botLine}|${botLine}|${message}|${mainTip}`], 'rebasing: one commit by the bot, on the base’s tip');
	t.equal(server.show(rebased, aught), fixedAught.trim(), 'rebasing: with its change');
	t.equal(server.show(rebased, 'README.md'), 'moved', 'rebasing: and the base’s');

	const other = setup(t, {
		[pretest]: tapePretest,
		[aught]: tapeAught,
		'README.md': 'readme\n',
		'big.txt': 'not needed\n',
	});
	fixtureGit(other.remote, ['config', 'uploadpack.allowFilter', 'true']);
	const otherTip = other.commit('main', { 'old.txt': 'history\n' });
	const restoring = other.commit(fixBranch, { [pretest]: template('node-pretest.yml') }, { who: bot, from: 'main', message });
	const second = await run(t, {
		server: other,
		github: installed([{ name: 'r' }]),
		merge: shown(other, [[1, fixBranch, restoring]], { ci: failedIn(restoring, [pretest]) }),
		partial: true,
	});
	t.equal(second.errors, 0, 'restoring: nothing failed');
	const restored = other.tip(`refs/heads/${fixBranch}`);
	t.deepEqual(other.log(`main..${restored}`), [`${botLine}|${botLine}|${message}|${otherTip}`], 'restoring: one commit by the bot, on the base’s tip');
	t.equal(`${other.show(restored, pretest)}\n`, tapePretest, 'restoring: the input is back');
	t.equal(other.show(restored, 'big.txt'), 'not needed', 'restoring: and every other file is as it was');
	[server, other].forEach(({ remote }) => {
		t.equal(fixtureGit(remote, ['fsck', '--connectivity-only', '--no-dangling', '--no-progress']), '', 'and the server’s repository is whole: everything pushed came with every object it needs');
	});
	t.end();
});

test('maintain: squashes a PR with several of the bot’s commits into one', async (t) => {
	const server = setup(t);
	server.commit(fixBranch, { [aught]: fixedAught }, { who: bot, from: 'main', message });
	server.commit('main', { 'README.md': 'moved\n' });
	const head = server.merge(fixBranch, 'main', bot);
	const later = server.commit(fixBranch, { [pretest]: template('node-pretest.yml') }, { who: bot, message: 'more' });

	const { stdout } = await run(t, {
		server,
		github: installed([{ name: 'r' }]),
		merge: shown(server, [[1, fixBranch, later]]),
	});
	t.ok(head, 'fixture: the bot merged the base in');
	t.ok(logged(stdout).includes(`${prURL(server)}: rebased onto \`main\`’s tip`), 'rebases it');
	const tip = server.tip(`refs/heads/${fixBranch}`);
	t.deepEqual(server.log(`main..${tip}`).map((line) => line.split('|')[2]), [message], 'into one commit, with its first commit’s message');
	t.equal(server.show(tip, pretest), template('node-pretest.yml').trim(), 'with every change');
	t.equal(server.show(tip, aught), fixedAught.trim(), 'from every commit');
	t.end();
});

test('maintain: a PR that conflicts with its base says so, once for each head and base tip', async (t) => {
	const server = setup(t);
	const head = server.commit(fixBranch, { [aught]: fixedAught }, { who: bot, from: 'main', message });
	const mainTip = server.commit('main', { [aught]: tapeAught.replace('skip-ls-check: true', 'skip-ls-check: false') });
	/** @type {Comment[]} */
	const posted = [];
	const scenario = {
		server,
		github: installed([{ name: 'r' }]),
		merge: shown(server, [[1, fixBranch, head]]),
		posted,
	};

	const first = await run(t, scenario);
	t.equal(first.errors, 0, 'not a failure');
	t.ok(logged(first.stdout).includes(`${prURL(server)}: it conflicts with \`main\`, so it can’t be rebased; said so on it`), 'logs it');
	t.deepEqual(comments(first.requests), [`${marker('conflict', head, mainTip)}\nThis PR conflicts with \`main\`, so the App can’t rebase it onto \`main\`’s tip, which it must be on to be merged: it needs updating (eg, with \`/fix\`), or closing.`], 'comments, marked with its head and its base’s tip');
	t.equal(server.tip(`refs/heads/${fixBranch}`), head, 'leaving it as it is');

	const second = await run(t, { ...scenario, offline: true });
	t.equal(second.errors, 0, 'the next run, for the same head and base tip, clones nothing: it’s decided from what the bot already said on it');
	t.ok(logged(second.stdout).includes(`${prURL(server)}: left as it is: as already said on it, it’s \`conflict\` until its head commit, or its base’s tip, changes`), 'says why');
	t.deepEqual(comments(second.requests), [], 'and doesn’t say it again');

	const moved = server.commit('main', { 'other.md': 'moved\n' });
	const third = await run(t, { ...scenario, merge: shown(server, [[1, fixBranch, head]]) });
	t.equal(third.errors, 0, 'when its base moves, it’s tried again');
	t.ok(logged(third.stdout).includes(`${prURL(server)}: it conflicts with \`main\`, so it can’t be rebased; said so on it`), 'and still conflicts');
	t.deepEqual(comments(third.requests), [`${marker('conflict', head, moved)}\nThis PR conflicts with \`main\`, so the App can’t rebase it onto \`main\`’s tip, which it must be on to be merged: it needs updating (eg, with \`/fix\`), or closing.`], 'which it says again, once, about the new tip');

	const fourth = await run(t, { ...scenario, merge: shown(server, [[1, fixBranch, head]]), offline: true });
	t.equal(fourth.errors, 0, 'after which, with that tip, it clones nothing again');
	t.deepEqual(comments(fourth.requests), [], 'nor says anything');

	server.commit('main', { [aught]: tapeAught });
	const fifth = await run(t, { ...scenario, merge: shown(server, [[1, fixBranch, head]]) });
	t.ok(logged(fifth.stdout).includes(`${prURL(server)}: rebased onto \`main\`’s tip`), 'and once its base no longer conflicts, it’s rebased');
	t.deepEqual(comments(fifth.requests), [], 'saying nothing');
	t.end();
});

test('maintain: only what the bot said about the PR’s current head keeps it from being looked at again', async (t) => {
	const server = setup(t);
	const old = server.commit(fixBranch, { [aught]: fixedAught }, { who: bot, from: 'main', message });
	const head = server.commit(fixBranch, { 'README.md': 'more\n' }, { who: bot });
	const mainTip = server.commit('main', { 'other.md': 'moved\n' });
	const key = '/repos/ljharb/r/issues/1';
	const { errors, stdout } = await run(t, {
		server,
		github: installed([{ name: 'r' }]),
		merge: shown(server, [[1, fixBranch, head]]),
		posted: [
			{ key, user: { login: bot.name }, body: `${marker('conflict', old, mainTip)}\nabout an earlier head` },
			{ key, user: { login: bot.name }, body: `${marker('conflict', head, old)}\nabout an earlier base tip` },
			{ key, user: { login: bot.name }, body: `${marker('empty', head)}\nabout no base tip` },
			{ key, user: { login: mallory.name }, body: `${marker('empty', head, mainTip)}\nnot the bot` },
		],
	});
	t.equal(errors, 0, 'nothing failed');
	t.ok(logged(stdout).includes(`${prURL(server)}: rebased onto \`main\`’s tip`), 'it’s cloned, and rebased, as if nothing had been said');
	t.end();
});

test('maintain: a PR whose base already has its changes is left as it is', async (t) => {
	const server = setup(t);
	const head = server.commit(fixBranch, { [aught]: fixedAught }, { who: bot, from: 'main', message });
	const mainTip = server.commit('main', { [aught]: fixedAught });
	/** @type {Comment[]} */
	const posted = [];
	const scenario = {
		server,
		github: installed([{ name: 'r' }]),
		merge: shown(server, [[1, fixBranch, head]]),
		posted,
	};
	const { stdout, requests } = await run(t, scenario);
	t.ok(logged(stdout).includes(`${prURL(server)}: \`main\` already has everything it changes, so it’s left as it is; said so on it`), 'says so');
	t.equal(server.tip(`refs/heads/${fixBranch}`), head, 'pushes nothing');
	t.deepEqual(comments(requests), [`${marker('empty', head, mainTip)}\n\`main\` already has everything this PR changes, so the App leaves it as it is: it can be closed.`], 'says so on the PR, marked with its head and its base’s tip');

	const second = await run(t, { ...scenario, offline: true });
	t.equal(second.errors, 0, 'the next run, for the same head and base tip, clones nothing');
	t.ok(logged(second.stdout).includes(`${prURL(server)}: left as it is: as already said on it, it’s \`empty\` until its head commit, or its base’s tip, changes`), 'says why');
	t.deepEqual(comments(second.requests), [], 'and doesn’t say it again');

	const moved = server.commit('main', { 'other.md': 'moved\n' });
	const third = await run(t, { ...scenario, merge: shown(server, [[1, fixBranch, head]]) });
	t.deepEqual(comments(third.requests), [`${marker('empty', head, moved)}\n\`main\` already has everything this PR changes, so the App leaves it as it is: it can be closed.`], 'when its base moves, it’s tried again, and says so once more, about the new tip');
	const fourth = await run(t, { ...scenario, merge: shown(server, [[1, fixBranch, head]]), offline: true });
	t.equal(fourth.errors, 0, 'after which it clones nothing again');
	t.deepEqual(comments(fourth.requests), [], 'nor says anything');
	t.end();
});

test('maintain: a PR with someone else’s commits is never touched, and says so once, without cloning anything', async (t) => {
	const server = setup(t);
	server.commit(fixBranch, { [aught]: fixedAught }, { who: bot, from: 'main', message });
	const head = server.commit(fixBranch, { 'README.md': 'theirs\n' }, { who: mallory });
	server.commit('main', { 'README.md': 'moved\n' });
	/** @type {Comment[]} */
	const posted = [];
	const scenario = {
		server,
		github: installed([{ name: 'r' }]),
		merge: shown(server, [[1, fixBranch, head]]),
		posted,
		offline: true,
	};

	const first = await run(t, scenario);
	t.equal(first.errors, 0, 'nothing failed, with nothing cloned');
	t.ok(logged(first.stdout).includes(`${prURL(server)}: it’s left alone (it has commits by someone else; review and merge it yourself); said so on it`), 'logs it');
	t.deepEqual(comments(first.requests), [`${marker('foreign', head)}\nThe App never updates this PR (nor merges it): it has commits by someone else; review and merge it yourself.`], 'comments');
	t.equal(server.tip(`refs/heads/${fixBranch}`), head, 'pushes nothing');
	const second = await run(t, scenario);
	t.deepEqual(comments(second.requests), [], 'once');

	// only the API is read, so where this is doesn't matter
	const linked = server.commit('elsewhere', { 'README.md': 'linked\n' }, { who: bot, from: 'main', message });
	const byLogin = await run(t, {
		server,
		github: installed([{ name: 'r' }]),
		merge: shown(server, [[1, fixBranch, linked]], { commits: { [`${repository}#1`]: [prCommit(linked, { author: mallory.name, parents: [server.tip('main')] })] } }),
		posted,
		offline: true,
	});
	t.deepEqual(comments(byLogin.requests), [`${marker('foreign', linked)}\nThe App never updates this PR (nor merges it): it has commits by someone else; review and merge it yourself.`], 'matched exactly as `/merge` matches them: by the GitHub user GitHub links each to, before its email');

	const many = await run(t, {
		server,
		github: installed([{ name: 'r' }]),
		merge: shown(server, [[2, fixBranch, linked]], { commits: { [`${repository}#2`]: Array.from({ length: 250 }, (_, i) => prCommit(i === 249 ? linked : `c${i}`)) } }),
		posted,
		offline: true,
	});
	t.ok(logged(many.stdout).includes(`${prURL(server, 2)}: it’s left alone (it has at least 250 commits, more than GitHub lists, so they can’t all be checked to be the App’s own; review and merge it yourself); said so on it`), 'as is one with more commits than GitHub lists');
	t.end();
});

test('maintain: a PR whose branch moved while it was being looked at is left for next time', async (t) => {
	const changed = (/** @type {Server} */ server, /** @type {number} */ number = 1) => `${prURL(server, number)}: its branch changed while it was being looked at; it’s looked at again next time`;
	const server = setup(t);
	const head = server.commit(fixBranch, { [aught]: fixedAught }, { who: bot, from: 'main', message });
	const listed = shown(server, [[1, fixBranch, head]]);
	const stale = await run(t, {
		server,
		github: installed([{ name: 'r' }]),
		merge: { ...listed, openPulls: { [repository]: [pr(repository, 1, fixBranch, { sha: 'stale' })] } },
		offline: true,
	});
	t.ok(logged(stale.stdout).includes(changed(server)), 'its commits, from the API, don’t end at the head it was listed with: says so, without cloning anything');
	t.equal(stale.errors, 0, 'nothing failed');
	t.equal(server.tip(`refs/heads/${fixBranch}`), head, 'pushes nothing');

	// what the API showed, before the branch moved
	const pushed = server.commit(fixBranch, { [aught]: tapeAught }, { who: bot, message: 'meanwhile' });
	const moved = await run(t, {
		server,
		github: installed([{ name: 'r' }]),
		merge: { ...listed, ci: failedIn(head, [aught]) },
	});
	t.ok(logged(moved.stdout).includes(changed(server)), 'its branch moved between reading the API and cloning it: says so');
	t.equal(server.tip(`refs/heads/${fixBranch}`), pushed, 'pushing nothing');

	const other = setup(t);
	const otherHead = other.commit(fixBranch, { [aught]: fixedAught }, { who: bot, from: 'main', message });
	const otherListed = shown(other, [[1, fixBranch, otherHead]], { ci: failedIn(otherHead, [aught]) });
	other.commit('main', { 'README.md': 'moved\n' });
	const based = await run(t, { server: other, github: installed([{ name: 'r' }]), merge: otherListed });
	t.ok(logged(based.stdout).includes(changed(other)), 'its base moved between reading the API and cloning it, so the clone’s head isn’t on its tip: says so');
	t.equal(other.tip(`refs/heads/${fixBranch}`), otherHead, 'pushing nothing');
	t.end();
});

test('maintain: an up-to-date PR', async (t) => {
	const server = setup(t);
	const fix = server.commit(fixBranch, { [aught]: fixedAught }, { who: bot, from: 'main', message });
	const relock = server.commit(relockBranch, { '.github/workflows/actions.lock': 'lock\n' }, { who: bot, from: 'main', message: 'relock' });
	const openPulls = { [repository]: [pr(repository, 1, fixBranch, { sha: fix }), pr(repository, 2, relockBranch, { sha: relock })] };

	const pending = await run(t, {
		server,
		github: installed([{ name: 'r', open: [1, 1] }]),
		merge: { ...shown(server, [[1, fixBranch, fix], [2, relockBranch, relock]]), openPulls, ci: { [fix]: { checkRuns: [{ id: 1, name: 'tests', status: 'in_progress', conclusion: null }] } } },
		offline: true,
	});
	t.equal(pending.errors, 0, 'nothing failed, with nothing cloned: everything is decided from the API');
	t.deepEqual(
		logged(pending.stdout).filter((line) => line.startsWith(server.serverURL)),
		[
			`${prURL(server)}: up to date; its CI is still running`,
			`${prURL(server, 2)}: up to date`,
		],
		'a `fleet/workflows` PR whose CI is pending waits; a relock PR’s CI isn’t read',
	);
	t.notOk(pending.requests.some((r) => r.path.includes(`/commits/${relock}/`)), 'never even reading a relock PR’s CI');

	const passed = await run(t, {
		server,
		github: installed([{ name: 'r' }]),
		merge: shown(server, [[1, fixBranch, fix]], { ci: { [fix]: { checkRuns: [{ id: 1, name: 'tests', status: 'completed', conclusion: 'success' }] } } }),
		offline: true,
	});
	t.equal(passed.errors, 0, 'nothing failed, with nothing cloned');
	t.ok(logged(passed.stdout).includes(`${prURL(server)}: up to date; its CI passed`), 'one whose CI passed is left alone');
	t.equal(server.tip(`refs/heads/${fixBranch}`), fix, 'pushing nothing');
	t.deepEqual([...comments(pending.requests), ...comments(passed.requests)], [], 'saying nothing');
	t.end();
});

test('maintain: a `fleet/workflows` PR whose CI failed gets back the inputs it removed, which are kept, without oscillating', async (t) => {
	const server = setup(t, {
		[pretest]: tapePretest,
		[aught]: tapeAught,
		[config]: '{\n\t"relock": false\n}\n',
	});
	// as tape-testing/tape#625 did
	const head = server.commit(fixBranch, { [pretest]: template('node-pretest.yml'), [aught]: fixedAught }, { who: bot, from: 'main', message });
	const mainTip = server.tip('main');
	/** @type {Comment[]} */
	const posted = [];
	const github = installed([{ name: 'r' }]);

	const first = await run(t, {
		server,
		github,
		merge: shown(server, [[1, fixBranch, head]], { ci: failedIn(head, [pretest]) }),
		posted,
	});
	t.equal(first.errors, 0, 'nothing failed');
	t.ok(logged(first.stdout).includes(`${prURL(server)}: its CI failed, so restored \`skip-engines\` in \`node-pretest.yml\`, and kept them in \`.github/ljharb-actions.json\``), 'says what it restored');
	const restored = server.tip(`refs/heads/${fixBranch}`);
	t.notEqual(restored, head, 'updates the PR');
	t.deepEqual(server.log(`main..${restored}`), [`${botLine}|${botLine}|${message}|${mainTip}`], 'as one commit by the bot, on the base’s tip');
	t.equal(`${server.show(restored, pretest)}\n`, tapePretest, 'putting the failed file’s input back, as it was, comment and all');
	t.equal(`${server.show(restored, aught)}\n`, fixedAught, 'leaving the files that didn’t fail as the PR has them');
	t.equal(`${server.show(restored, config)}\n`, '{\n  "relock": false,\n  "keep": {\n    "node-pretest.yml": [\n      "skip-engines"\n    ]\n  }\n}\n', 'and keeping the input, alongside what the config already had');
	t.deepEqual(comments(first.requests), [], 'saying nothing on the PR: the next CI run decides');

	// the restored head failed too
	const scenario = {
		server,
		github,
		merge: shown(server, [[1, fixBranch, restored]], { ci: failedIn(restored, [pretest, '.github/workflows/unchanged.yml']) }),
		posted,
	};
	const second = await run(t, scenario);
	t.ok(logged(second.stdout).includes(`${prURL(server)}: its CI failed, with nothing left to restore; said so on it`), 'with nothing left to restore, it gives up');
	t.deepEqual(comments(second.requests), [`${marker('stuck', restored)}\nCI failed on this PR’s head commit, and the App has nothing left to restore in the workflow files that failed and that this PR changes: it needs a person to look at it. The workflow files that failed: \`.github/workflows/node-pretest.yml\`, \`.github/workflows/unchanged.yml\`.`], 'saying so on the PR');
	t.equal(server.tip(`refs/heads/${fixBranch}`), restored, 'pushing nothing');

	const third = await run(t, { ...scenario, offline: true });
	t.equal(third.errors, 0, 'the next run, for the same head, clones nothing');
	t.ok(logged(third.stdout).includes(`${prURL(server)}: left as it is: as already said on it, it’s \`stuck\` until its head commit changes`), 'says why');
	t.deepEqual(comments(third.requests), [], 'and only says so once for that head');
	t.equal(server.tip(`refs/heads/${fixBranch}`), restored, 'never changing it again');
	t.end();
});

test('maintain: a `fleet/workflows` PR whose CI fails only as its base’s tip’s does is never blamed for it', async (t) => {
	/** @type {Record<string, JobOutcome>} */
	const nonLatest = { 'tests / non-latest - 8.x': 'failed', 'tests / non-latest - 0.9': 'failed', 'tests / latest': 'passed' };
	/** @type {(base: Runs | null, head?: Runs) => Promise<{ server: Server, head: string, mainTip: string, result: Awaited<ReturnType<typeof run>> }>} */
	const scenario = async (base, head = actionsRun(100, aught, nonLatest)) => {
		const server = setup(t);
		// its base's tip has the same failures, in the same jobs
		const sha = server.commit(fixBranch, { [pretest]: template('node-pretest.yml'), [aught]: fixedAught }, { who: bot, from: 'main', message });
		const mainTip = server.tip('main');
		const result = await run(t, {
			server,
			github: installed([{ name: 'r' }]),
			merge: shown(server, [[1, fixBranch, sha]], { ci: { [sha]: head, ...base ? { [mainTip]: base } : {} } }),
		});
		return {
			server,
			head: sha,
			mainTip,
			result,
		};
	};

	const same = await scenario(actionsRun(200, aught, nonLatest));
	t.equal(same.result.errors, 0, 'nothing failed');
	t.ok(logged(same.result.stdout).includes(`${prURL(same.server)}: its CI failed only as \`main\`’s does; said so on it`), 'with the same failures in the same jobs of the same file on the base’s tip, nothing is restored');
	t.deepEqual(comments(same.result.requests), [`${marker('stuck', same.head)}\nEvery workflow file that failed on this PR’s head commit (\`.github/workflows/node-aught.yml\`) fails the same way on \`main\`’s head commit (\`${same.mainTip}\`), so the App has nothing to restore: it needs a person to look at it.`], 'saying so on the PR');
	t.equal(same.server.tip(`refs/heads/${fixBranch}`), same.head, 'pushing nothing');
	t.ok(same.result.requests.some((r) => r.path.includes(`head_sha=${same.mainTip}`)), 'having read the base’s tip’s CI');

	const regular = await scenario(
		{
			checkRuns: [{ id: 210, name: 'tests / 8.x', status: 'completed', conclusion: 'failure', check_suite: { id: 600 } }], // eslint-disable-line camelcase
			runs: [{ id: 211, path: aught, conclusion: 'failure', check_suite_id: 600, jobs: [] }], // eslint-disable-line camelcase
		},
		{
			checkRuns: [
				{ id: 110, name: 'tests / 8.x', status: 'completed', conclusion: 'failure', check_suite: { id: 500 } }, // eslint-disable-line camelcase
				{ id: 112, name: 'elsewhere', status: 'completed', conclusion: 'failure', check_suite: { id: 999 } }, // eslint-disable-line camelcase
			],
			runs: [{ id: 111, path: aught, conclusion: 'failure', check_suite_id: 500, jobs: [] }], // eslint-disable-line camelcase
		},
	);
	t.deepEqual(comments(regular.result.requests).map((c) => c.split('\n')[1]), [`Every workflow file that failed on this PR’s head commit (\`.github/workflows/node-aught.yml\`) fails the same way on \`main\`’s head commit (\`${regular.mainTip}\`), so the App has nothing to restore: it needs a person to look at it.`], 'as with a failed run, and a failed job in its check suite; a failure in no workflow file isn’t compared');
	t.equal(regular.server.tip(`refs/heads/${fixBranch}`), regular.head, 'pushing nothing then either');

	/** @type {[string, Runs | null][]} */
	const blamed = [
		['the base’s tip’s run of it passed', actionsRun(300, aught, { 'tests / non-latest - 8.x': 'passed', 'tests / non-latest - 0.9': 'passed' })],
		['another job of it failed on the base’s tip', actionsRun(300, aught, { 'tests / non-latest - 0.9': 'failed', 'tests / latest': 'failed' })],
		['the same jobs of it failed on the base’s tip, but only as `continue-on-error` hides', actionsRun(300, aught, { 'tests / non-latest - 8.x': 'optional', 'tests / non-latest - 0.9': 'hidden' })],
		['the base’s tip has no run of it', actionsRun(300, '.github/workflows/other.yml', { 'tests / non-latest - 8.x': 'failed', 'tests / non-latest - 0.9': 'failed' })],
		['the base’s tip’s run of it is still running', actionsRun(300, aught, nonLatest, { status: 'in_progress', conclusion: null })],
		['the base’s tip has no CI at all', null],
	];
	await blamed.reduce(
		async (previous, [label, base]) => {
			await previous;
			const { server, result } = await scenario(base);
			t.ok(logged(result.stdout).includes(`${prURL(server)}: its CI failed, so restored \`skip-ls-check\` in \`node-aught.yml\`, and kept them in \`.github/ljharb-actions.json\``), `${label}: the failure is the PR’s, so what it removed is restored`);
			t.equal(`${server.show(server.tip(`refs/heads/${fixBranch}`), aught)}\n`, tapeAught, `${label}: as it was`);
		},
		Promise.resolve(),
	);

	const mixed = await scenario(
		together(
			actionsRun(300, aught, nonLatest),
			actionsRun(310, pretest, { engines: 'passed' }),
		),
		together(
			actionsRun(100, aught, nonLatest),
			actionsRun(110, pretest, { engines: 'failed' }),
		),
	);
	t.ok(logged(mixed.result.stdout).includes(`${prURL(mixed.server)}: its CI failed, so restored \`skip-engines\` in \`node-pretest.yml\`, and kept them in \`.github/ljharb-actions.json\``), 'with failures of its own in one file, and only its base’s in another, only the first’s inputs are restored');
	const tip = mixed.server.tip(`refs/heads/${fixBranch}`);
	t.equal(`${mixed.server.show(tip, pretest)}\n`, tapePretest, 'putting them back');
	t.equal(`${mixed.server.show(tip, aught)}\n`, fixedAught, 'and leaving the other as the PR has it');
	t.deepEqual(comments(mixed.result.requests), [], 'saying nothing');

	// a failure in `node-pretest.yml` that the base's tip has too, in the same job, and in the same way
	/** @type {(id: number, suite: number) => Runs} */
	const broken = (id, suite) => ({
		checkRuns: [{ id, name: 'tests / engines', status: 'completed', conclusion: 'failure', check_suite: { id: suite } }], // eslint-disable-line camelcase
		runs: [{ id: id + 1, path: pretest, conclusion: 'failure', check_suite_id: suite, jobs: [] }], // eslint-disable-line camelcase
	});
	const optional = await scenario(together(broken(400, 600), actionsRun(300, aught, { 'tests / non-latest - 8.x': 'passed' })), together(broken(150, 500), actionsRun(100, aught, { 'tests / non-latest - 8.x': 'hidden', 'tests / non-latest - 0.9': 'optional', 'tests / latest': 'passed' })));
	t.deepEqual(comments(optional.result.requests).map((c) => c.split('\n')[1]), [`Every workflow file that failed on this PR’s head commit (\`.github/workflows/node-pretest.yml\`) fails the same way on \`main\`’s head commit (\`${optional.mainTip}\`), so the App has nothing to restore: it needs a person to look at it.`], 'failures of its own that `continue-on-error` hides, of a step or of a job, are never the PR’s, so with only its base’s real failures besides, it needs a person');
	t.equal(optional.server.tip(`refs/heads/${fixBranch}`), optional.head, 'restoring nothing');

	const running = await scenario(broken(400, 600), together(broken(150, 500), actionsRun(100, aught, nonLatest, { status: 'in_progress', conclusion: null })));
	t.ok(logged(running.result.stdout).includes(`${prURL(running.server)}: up to date; its CI has failed only as \`main\`’s does so far, and is still running`), 'with only its base’s failures so far, and a run still going, it waits');
	t.equal(running.server.tip(`refs/heads/${fixBranch}`), running.head, 'pushing nothing');
	t.deepEqual(comments(running.result.requests), [], 'and saying nothing');

	const unstarted = await scenario(
		{
			checkRuns: [{ id: 210, name: 'tests / 8.x', status: 'completed', conclusion: 'failure', check_suite: { id: 600 } }], // eslint-disable-line camelcase
			runs: [{ id: 211, path: aught, conclusion: 'failure', check_suite_id: 600, jobs: [] }], // eslint-disable-line camelcase
		},
		{ checkRuns: [], runs: [{ id: 111, path: aught, conclusion: 'startup_failure', jobs: [] }] },
	);
	t.ok(logged(unstarted.result.stdout).includes(`${prURL(unstarted.server)}: its CI failed, so restored \`skip-ls-check\` in \`node-aught.yml\`, and kept them in \`.github/ljharb-actions.json\``), 'a run of its that never got to a job (eg, for a missing required input) isn’t the same failure as one of the base’s that failed in a job, so what it removed is restored');
	t.deepEqual(comments(unstarted.result.requests), [], 'saying nothing');

	const passed = await scenario(actionsRun(200, aught, nonLatest), actionsRun(100, aught, { 'tests / latest': 'passed' }));
	t.ok(logged(passed.result.stdout).includes(`${prURL(passed.server)}: up to date; its CI passed`), 'a PR whose CI passed is left alone');
	t.notOk(passed.result.requests.some((r) => r.path.includes(passed.mainTip)), 'without reading the base’s tip’s CI');

	const onlyOptional = await scenario(actionsRun(200, aught, nonLatest), actionsRun(100, aught, { 'tests / non-latest - 8.x': 'hidden', 'tests / non-latest - 0.9': 'optional', 'tests / latest': 'passed' }));
	t.ok(logged(onlyOptional.result.stdout).includes(`${prURL(onlyOptional.server)}: up to date; its CI passed`), 'a PR whose only failures `continue-on-error` hides passed, so it’s left alone');
	t.equal(onlyOptional.server.tip(`refs/heads/${fixBranch}`), onlyOptional.head, 'restoring nothing');
	t.deepEqual(comments(onlyOptional.result.requests), [], 'and saying nothing');
	t.notOk(onlyOptional.result.requests.some((r) => r.path.includes(onlyOptional.mainTip)), 'without reading the base’s tip’s CI');
	t.end();
});

test('maintain: restoring puts back an input’s comments on lines of their own, in each job it was removed from', async (t) => {
	const commented = `${template('node-pretest.yml')}    with:\n    # bin/tape requires node 8+, but the rest of tape supports 0.4+\n      skip-engines: true\n  again:\n    uses: ljharb/actions/.github/workflows/pretest.yml@main\n    with:\n      # not this one\n      skip-pack: true\n`;
	const server = setup(t, { [pretest]: commented });
	const head = server.commit(fixBranch, { [pretest]: `${template('node-pretest.yml')}  again:\n    uses: ljharb/actions/.github/workflows/pretest.yml@main\n` }, { who: bot, from: 'main', message });
	const { stdout } = await run(t, {
		server,
		github: installed([{ name: 'r' }]),
		merge: shown(server, [[1, fixBranch, head]], { ci: failedIn(head, [pretest]) }),
	});
	t.ok(logged(stdout).includes(`${prURL(server)}: its CI failed, so restored \`skip-engines\`, \`skip-pack\` in \`node-pretest.yml\`, and kept them in \`.github/ljharb-actions.json\``), 'says what it restored');
	const tip = server.tip(`refs/heads/${fixBranch}`);
	t.equal(`${server.show(tip, pretest)}\n`, commented, 'each input back in its own job, with the comment above it, as it was');
	t.end();
});

test('maintain: restoring puts back an input removed from a job with another id than the template’s, in the template’s job', async (t) => {
	const server = setup(t, { [pretest]: tapePretest.replace('  tests:', '  pretest:') });
	const head = server.commit(fixBranch, { [pretest]: template('node-pretest.yml') }, { who: bot, from: 'main', message });
	const { stdout } = await run(t, {
		server,
		github: installed([{ name: 'r' }]),
		merge: shown(server, [[1, fixBranch, head]], { ci: failedIn(head, [pretest]) }),
	});
	t.ok(logged(stdout).includes(`${prURL(server)}: its CI failed, so restored \`skip-engines\` in \`node-pretest.yml\`, and kept them in \`.github/ljharb-actions.json\``), 'says what it restored');
	t.equal(`${server.show(server.tip(`refs/heads/${fixBranch}`), pretest)}\n`, tapePretest, 'into the one call of that workflow the PR left');
	t.end();
});

test('maintain: restoring keeps a workflow file’s line endings', async (t) => {
	/** @type {(text: string) => string} */
	const crlf = (text) => text.replace(/\n/g, '\r\n');
	const server = setup(t, { [pretest]: crlf(tapePretest) });
	const head = server.commit(fixBranch, { [pretest]: crlf(template('node-pretest.yml')) }, { who: bot, from: 'main', message });
	const { stdout } = await run(t, {
		server,
		github: installed([{ name: 'r' }]),
		merge: shown(server, [[1, fixBranch, head]], { ci: failedIn(head, [pretest]) }),
	});
	t.ok(logged(stdout).includes(`${prURL(server)}: its CI failed, so restored \`skip-engines\` in \`node-pretest.yml\`, and kept them in \`.github/ljharb-actions.json\``), 'restores an input in a file whose every line ends with `\\r\\n`');
	t.equal(fixtureGit(server.remote, ['cat-file', 'blob', `${server.tip(`refs/heads/${fixBranch}`)}:${pretest}`]), crlf(tapePretest).trimEnd(), 'keeping them');
	t.end();
});

test('maintain: restoring keeps what `keep` already has', async (t) => {
	const server = setup(t, {
		[pretest]: tapePretest,
		[aught]: tapeAught,
		[config]: JSON.stringify({ keep: { 'node-pretest.yml': ['skip-pack'], 'node-aught.yml': 'nope' } }),
	});
	const head = server.commit(fixBranch, { [pretest]: template('node-pretest.yml'), [aught]: fixedAught }, { who: bot, from: 'main', message });
	await run(t, {
		server,
		github: installed([{ name: 'r' }]),
		merge: shown(server, [[1, fixBranch, head]], { ci: failedIn(head, [pretest, aught]) }),
	});
	const tip = server.tip(`refs/heads/${fixBranch}`);
	t.deepEqual(JSON.parse(server.show(tip, config)), { keep: { 'node-pretest.yml': ['skip-pack', 'skip-engines'], 'node-aught.yml': ['skip-ls-check'] } }, 'adding to its inputs, and replacing an entry that isn’t a list');
	t.equal(`${server.show(tip, aught)}\n`, tapeAught, 'restoring every failed file’s inputs');
	t.end();
});

test('maintain: restoring keeps `.github/ljharb-actions.json` out of the published package, when it uses `npmignore`', async (t) => {
	/** @type {(ignore: unknown, extra?: Record<string, unknown>) => string} */
	const pkg = (ignore, extra = { devDependencies: { npmignore: '^0.3.1' } }) => `${JSON.stringify(
		{
			name: 'pkg',
			...extra,
			publishConfig: { ignore },
		},
		null,
		2,
	)}\n`;
	const restoredLine = 'its CI failed, so restored `skip-engines` in `node-pretest.yml`, and kept them in `.github/ljharb-actions.json`';
	/** @type {(files: Record<string, string>, label: string) => Promise<{ tip: string, line: string | undefined }>} */
	const restore = async (files, label) => {
		const server = setup(t, { [pretest]: tapePretest, ...files });
		const head = server.commit(fixBranch, { [pretest]: template('node-pretest.yml') }, { who: bot, from: 'main', message });
		const { errors, stdout } = await run(t, {
			server,
			github: installed([{ name: 'r' }]),
			merge: shown(server, [[1, fixBranch, head]], { ci: failedIn(head, [pretest]) }),
		});
		t.equal(errors, 0, `${label}: nothing failed`);
		const tip = server.tip(`refs/heads/${fixBranch}`);
		t.notEqual(tip, head, `${label}: the PR is restored`);
		t.equal(`${server.show(tip, pretest)}\n`, tapePretest, `${label}: putting the input back`);
		return {
			tip: fixtureGit(server.remote, ['cat-file', '-p', `${tip}:package.json`]),
			line: logged(stdout).find((l) => l.startsWith(prURL(server))),
		};
	};

	const adds = await restore({ 'package.json': pkg(['.github/workflows', 'test']) }, 'with no config file of its own');
	t.equal(`${adds.tip}\n`, pkg(['.github/workflows', '.github/ljharb-actions.json', 'test']), 'adds the config file it writes to `publishConfig.ignore`, right after `.github/workflows`');
	t.ok(String(adds.line).endsWith(`: ${restoredLine}, which it added to \`package.json\`’s \`publishConfig.ignore\``), 'and says so');

	/** @type {[string, Record<string, string>][]} */
	const unchanged = [
		['already ignored', { 'package.json': pkg(['.github']) }],
		['already ignored by its own entry, which isn’t removed, since the config file is there', { 'package.json': pkg(['.github/ljharb-actions.json']) }],
		['its package doesn’t use `npmignore`', { 'package.json': pkg(['test'], {}) }],
		['it has no `publishConfig.ignore`', { 'package.json': pkg(undefined) }],
		['it isn’t JSON', { 'package.json': '{ nope' }],
		// json-file-plus 4.0.1 writes every line ending as `\n`
		['it has `\\r\\n` line endings, which `json-file-plus` would write as `\\n`s', { 'package.json': pkg(['test'], { scripts: { prepack: 'npmignore --auto' } }).replace(/\n/g, '\r\n'), [config]: '{}' }],
		['it has no final newline, which `json-file-plus` would add', { 'package.json': pkg(['test']).trimEnd() }],
	];
	await unchanged.reduce(
		async (previous, [why, files]) => {
			await previous;
			const { tip, line } = await restore(files, why);
			t.equal(tip, files['package.json'].trimEnd(), `${why}: \`package.json\` is unchanged`);
			t.ok(String(line).endsWith(`: ${restoredLine}`), `${why}: and not mentioned`);
		},
		Promise.resolve(),
	);

	const server = setup(t, { [pretest]: tapePretest });
	const head = server.commit(fixBranch, { [pretest]: template('node-pretest.yml') }, { who: bot, from: 'main', message });
	const { errors } = await run(t, {
		server,
		github: installed([{ name: 'r' }]),
		merge: shown(server, [[1, fixBranch, head]], { ci: failedIn(head, [pretest]) }),
	});
	t.equal(errors, 0, 'with no `package.json`, nothing fails');
	t.notEqual(server.tip(`refs/heads/${fixBranch}`), head, 'the PR is still restored');
	t.deepEqual(fixtureGit(server.remote, ['ls-tree', '--name-only', `refs/heads/${fixBranch}`]).split('\n'), ['.github'], 'and no `package.json` is added');
	t.end();
});

test('maintain: a failure it can’t restore anything for needs a person', async (t) => {
	/** @type {[string, Record<string, string>, Record<string, string | null>, string[], string][]} */
	const cases = [
		['the failure is in a file the PR didn’t change', {}, { [aught]: fixedAught }, [pretest], 'the App has nothing left to restore in the workflow files that failed and that this PR changes: it needs a person to look at it. The workflow files that failed: `.github/workflows/node-pretest.yml`.'],
		['the failure is in a file the PR added', {}, { '.github/workflows/new.yml': 'on: push\n' }, ['.github/workflows/new.yml'], 'the App has nothing left to restore in the workflow files that failed and that this PR changes: it needs a person to look at it. The workflow files that failed: `.github/workflows/new.yml`.'],
		['what it removed isn’t an input the workflow declares', { [pretest]: `${template('node-pretest.yml')}    with:\n      not-an-input: 1\n` }, { [pretest]: template('node-pretest.yml') }, [pretest], 'the App has nothing left to restore in the workflow files that failed and that this PR changes: it needs a person to look at it. The workflow files that failed: `.github/workflows/node-pretest.yml`.'],
		['the failure isn’t in any workflow file', {}, { [aught]: fixedAught }, [], 'the App has nothing left to restore in the workflow files that failed and that this PR changes: it needs a person to look at it.'],
		['the config isn’t JSON', { [config]: '{ nope' }, { [pretest]: template('node-pretest.yml') }, [pretest], 'the App would restore inputs this PR removed, but `.github/ljharb-actions.json` isn’t a JSON object (with an object `keep`, if it has one), so it can’t keep them there: it needs a person to look at it. The workflow files that failed: `.github/workflows/node-pretest.yml`.'],
		['the config isn’t an object', { [config]: '[]' }, { [pretest]: template('node-pretest.yml') }, [pretest], 'the App would restore inputs this PR removed, but `.github/ljharb-actions.json` isn’t a JSON object (with an object `keep`, if it has one), so it can’t keep them there: it needs a person to look at it. The workflow files that failed: `.github/workflows/node-pretest.yml`.'],
		['which call to restore inputs to is ambiguous', { [pretest]: 'jobs:\n  a:\n    uses: ljharb/actions/.github/workflows/pretest.yml@main\n    with:\n      skip-engines: true\n  b:\n    uses: ljharb/actions/.github/workflows/pretest.yml@main\n    with:\n      skip-pack: true\n' }, { [pretest]: template('node-pretest.yml') }, [pretest], 'the App can’t tell where to restore inputs this PR removed: in `.github/workflows/node-pretest.yml`, `job “a” passes skip-engines to pretest.yml, but no job with that id calls it now, and which other call of it should get them is ambiguous; job “b” passes skip-pack to pretest.yml, but no job with that id calls it now, and which other call of it should get them is ambiguous`. It needs a person to look at it.'],
		['the inputs it would restore can’t be added back', {}, { [pretest]: `${template('node-pretest.yml')}    with: {}\n` }, [pretest], 'the App can’t restore inputs this PR removed: in `.github/workflows/node-pretest.yml`, `job “tests” should pass skip-engines to pretest.yml, but they can’t be added to it: it doesn’t call it, or its “with:”, or the file, isn’t YAML the App understands`. It needs a person to look at it.'],
		['restoring an input would change anything else in the file', { [pretest]: `${template('node-pretest.yml')}    with:\n      skip-engines: &a true\n` }, { [pretest]: `env:\n  A: &a x\n${template('node-pretest.yml')}  other:\n    runs-on: *a\n` }, [pretest], 'the App can’t restore inputs this PR removed: in `.github/workflows/node-pretest.yml`, `adding them would change more of the file than those inputs`. It needs a person to look at it.'],
		['its `keep` isn’t an object', { [config]: '{ "keep": [] }' }, { [pretest]: template('node-pretest.yml') }, [pretest], 'the App would restore inputs this PR removed, but `.github/ljharb-actions.json` isn’t a JSON object (with an object `keep`, if it has one), so it can’t keep them there: it needs a person to look at it. The workflow files that failed: `.github/workflows/node-pretest.yml`.'],
	];
	await cases.reduce(
		async (previous, [label, base, change, failed, why]) => {
			await previous;
			const server = setup(t, {
				[pretest]: tapePretest,
				[aught]: tapeAught,
				...base,
			});
			const head = server.commit(fixBranch, change, { who: bot, from: 'main', message });
			const { requests } = await run(t, {
				server,
				github: installed([{ name: 'r' }]),
				merge: shown(server, [[1, fixBranch, head]], {
					ci: failed.length > 0 ? failedIn(head, failed) : { [head]: { checkRuns: [{ id: 1, name: 'x', status: 'completed', conclusion: 'failure' }] } },
				}),
			});
			t.deepEqual(comments(requests), [`${marker('stuck', head)}\nCI failed on this PR’s head commit, and ${why}`], `${label}: says so`);
			t.equal(server.tip(`refs/heads/${fixBranch}`), head, `${label}: pushes nothing`);
		},
		Promise.resolve(),
	);
	t.end();
});

test('maintain: failures', async (t) => {
	const server = setup(t);
	const head = server.commit(fixBranch, { [aught]: fixedAught }, { who: bot, from: 'main', message });
	server.commit('main', { 'README.md': 'moved\n' });

	const denied = await run(t, {
		server,
		github: installed([{ name: 'r' }], { deniedPermissions: ['checks'] }),
		merge: shown(server, [[1, fixBranch, head]]),
	});
	t.equal(denied.errors, 1, 'a public repository that fails counts');
	t.ok(denied.stdout.includes('::warning::ljharb/r: '), 'and is warned about');
	t.equal(server.tip(`refs/heads/${fixBranch}`), head, 'pushing nothing');

	// someone pushes to the branch after it's cloned, but before it's rebuilt: its push's lease then fails
	const work = tempDir(t, 'fleet-maintain-race');
	fixtureGit(work, ['clone', '--quiet', '--branch', fixBranch, server.remote, '.']);
	fixtureGit(work, ['commit', '--quiet', '--allow-empty', '--message', 'meanwhile'], bot);
	const templates = tempDir(t, 'fleet-maintain-templates');
	mkdirSync(path.join(templates, 'hooks'));
	writeFileSync(path.join(templates, 'hooks', 'pre-push'), `#!/bin/sh\nunset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE\ngit -C '${work}' push --quiet origin 'HEAD:refs/heads/${fixBranch}'\n`);
	chmodSync(path.join(templates, 'hooks', 'pre-push'), 0o755);
	process.env.GIT_TEMPLATE_DIR = templates;
	/** @type {Awaited<ReturnType<typeof run>>} */
	let raced;
	try {
		raced = await run(t, { server, github: installed([{ name: 'r' }]), merge: shown(server, [[1, fixBranch, head]]) });
	} finally {
		delete process.env.GIT_TEMPLATE_DIR;
	}
	t.ok(raced.stdout.includes('::warning::ljharb/r: `fleet/workflows` changed after it was read, so it was not overwritten (its push was rejected); the next run rebuilds it from what it is now'), 'a rejected lease is reported');
	t.equal(raced.errors, 1, 'a rejected lease is a failure');
	t.equal(server.tip(`refs/heads/${fixBranch}`), fixtureGit(work, ['rev-parse', 'HEAD']), 'and what was pushed meanwhile survives');
	t.end();
});

// GitHub's runners always set `RUNNER_TEMP`, so each of its cases is set here, rather than left to where the tests run
test('maintain: clones into `RUNNER_TEMP`, or, without it, the system’s temp directory', async (t) => {
	const had = Object.hasOwn(process.env, 'RUNNER_TEMP');
	const before = process.env.RUNNER_TEMP;
	t.teardown(() => {
		if (had) {
			process.env.RUNNER_TEMP = before;
		} else {
			delete process.env.RUNNER_TEMP;
		}
	});
	const server = setup(t);
	const head = server.commit(fixBranch, { [aught]: fixedAught }, { who: bot, from: 'main', message });
	server.commit('main', { 'README.md': 'moved\n' });

	process.env.RUNNER_TEMP = path.join(tempDir(t, 'fleet-maintain-runner-temp'), 'missing');
	const missing = await run(t, {
		server,
		github: installed([{ name: 'r' }]),
		merge: shown(server, [[1, fixBranch, head]]),
	});
	t.equal(missing.errors, 1, 'a `RUNNER_TEMP` that doesn’t exist can’t be cloned into, so it’s what’s used');
	t.equal(server.tip(`refs/heads/${fixBranch}`), head, 'pushing nothing');

	process.env.RUNNER_TEMP = '';
	const unset = await run(t, {
		server,
		github: installed([{ name: 'r' }]),
		merge: shown(server, [[1, fixBranch, head]]),
	});
	t.equal(unset.errors, 0, 'without it, nothing fails');
	t.ok(logged(unset.stdout).includes(`${prURL(server)}: rebased onto \`main\`’s tip`), 'since the system’s temp directory is used instead');
	t.end();
});

test('maintain: a private repository’s PRs are kept up to date, but nothing about them is shown', async (t) => {
	const server = setup(t);
	const head = server.commit(fixBranch, { [aught]: fixedAught }, { who: bot, from: 'main', message });
	const mainTip = server.commit('main', { 'README.md': 'moved\n' });
	const ok = await run(t, {
		server,
		github: installed([{ name: 'r', private: true }]),
		merge: shown(server, [[1, fixBranch, head]]),
	});
	t.equal(ok.errors, 0, 'nothing failed');
	t.equal(server.tip(`refs/heads/${fixBranch}^`), mainTip, 'it’s rebased');
	t.deepEqual(logged(ok.stdout), ['Open PRs in private repositories, if any, were also kept up to date; nothing about them is shown here.'], 'with nothing logged about it');

	const failed = await run(t, {
		server,
		github: installed([{ name: 'r', private: true }], { deniedPermissions: ['checks'] }),
		merge: shown(server, [[1, fixBranch, head]]),
	});
	t.equal(failed.errors, 0, 'its failure doesn’t count');
	t.notOk(failed.stdout.includes('ljharb/r'), 'nor is it shown');
	t.end();
});

/** @type {(requests: Recorded[]) => [string, string][]} */
function hiddenComments(requests) {
	return requests.filter((r) => r.path === '/graphql' && r.body.variables.classifier).map((r) => [r.body.variables.id, r.body.variables.classifier]);
}

test('maintain: once it rebases a PR, hides what it said on it that no longer applies', async (t) => {
	const server = setup(t);
	const oldTip = server.tip('main');
	const head = server.commit(fixBranch, { [aught]: fixedAught }, { who: bot, from: 'main', message });
	const mainTip = server.commit('main', { 'README.md': 'moved\n' });
	const old = 'e'.repeat(40);
	const key = '/repos/ljharb/r/issues/1';
	/** @type {(github?: Partial<Scenario>, isPrivate?: boolean) => ReturnType<typeof run>} */
	const once = (github = {}, isPrivate = false) => run(t, {
		server,
		github: installed([{ name: 'r', private: isPrivate }], github),
		merge: shown(server, [[1, fixBranch, server.tip(`refs/heads/${fixBranch}`)]]),
		posted: [
			{ key, node_id: 'C_conflict', user: { login: bot.name }, body: `${marker('conflict', head, oldTip)}\nconflicted, with an earlier base tip` }, // eslint-disable-line camelcase
			{ key, node_id: 'C_empty', user: { login: bot.name }, body: `${marker('empty', old, mainTip)}\nwas empty, at an earlier head` }, // eslint-disable-line camelcase
			{ key, node_id: 'C_stuck', user: { login: bot.name }, body: `${marker('stuck', head)}\nwas stuck` }, // eslint-disable-line camelcase
			{ key, node_id: 'C_minimized', user: { login: bot.name }, body: `${marker('foreign', old)}\nalready hidden` }, // eslint-disable-line camelcase
			{ key, node_id: 'C_theirs', user: { login: mallory.name }, body: `${marker('stuck', head)}\nnot the bot` }, // eslint-disable-line camelcase
			{ key, node_id: 'C_plain', user: { login: bot.name }, body: 'no marker' }, // eslint-disable-line camelcase
		],
	});

	const { errors, stdout, requests } = await once({ minimized: ['C_minimized'] });
	t.equal(errors, 0, 'nothing failed');
	t.ok(logged(stdout).includes(`${prURL(server)}: rebased onto \`main\`’s tip; hid 3 of its earlier comments that no longer apply`), 'rebases it, and says what it hid');
	t.deepEqual(
		hiddenComments(requests),
		[
			['C_conflict', 'RESOLVED'],
			['C_empty', 'OUTDATED'],
			['C_stuck', 'OUTDATED'],
		],
		'a conflict about the head a clean rebase replaced is resolved; its having been empty at an even earlier head, or stuck, is only outdated; anyone else’s, one without a marker, and one already hidden are left alone',
	);
	t.deepEqual(requests.filter((r) => r.path === '/graphql' && r.body.variables.ids).map((r) => r.authorization), ['token ghs_installation_1'], 'looking them up with the PR’s repository’s token');

	server.commit('main', { 'other.md': 'moved again\n' });
	const failed = await once({ minimized: ['C_minimized'], minimizeFails: ['C_conflict', 'C_empty', 'C_stuck'] }, true);
	t.equal(failed.errors, 0, 'a failure to hide them never fails the run');
	t.equal(server.tip(`refs/heads/${fixBranch}^`), server.tip('main'), 'nor the update');
	t.deepEqual(
		hiddenComments(failed.requests),
		[
			['C_conflict', 'OUTDATED'],
			['C_empty', 'OUTDATED'],
			['C_stuck', 'OUTDATED'],
		],
		'it tries to hide them',
	);
	t.deepEqual(logged(failed.stdout), ['Open PRs in private repositories, if any, were also kept up to date; nothing about them is shown here.'], 'and, for a private repository, its failing to isn’t logged at all');
	t.end();
});

test('maintain: once it restores what a PR removed, hides what it said on it that no longer applies', async (t) => {
	const server = setup(t);
	const head = server.commit(fixBranch, { [pretest]: template('node-pretest.yml'), [aught]: fixedAught }, { who: bot, from: 'main', message });
	const old = 'e'.repeat(40);
	const key = '/repos/ljharb/r/issues/1';
	const { errors, stdout, requests } = await run(t, {
		server,
		github: installed([{ name: 'r' }]),
		merge: shown(server, [[1, fixBranch, head]], { ci: failedIn(head, [pretest]) }),
		posted: [
			{ key, node_id: 'C_stuck', user: { login: bot.name }, body: `${marker('stuck', old)}\nwas stuck, at an earlier head` }, // eslint-disable-line camelcase
			{ key, node_id: 'C_foreign', user: { login: bot.name }, body: `${marker('foreign', head)}\nhad someone else’s commits` }, // eslint-disable-line camelcase
		],
	});
	t.equal(errors, 0, 'nothing failed');
	t.ok(logged(stdout).includes(`${prURL(server)}: its CI failed, so restored \`skip-engines\` in \`node-pretest.yml\`, and kept them in \`.github/ljharb-actions.json\`; hid 2 of its earlier comments that no longer apply`), 'restores what it removed, and says what it hid');
	t.deepEqual(
		hiddenComments(requests),
		[
			['C_stuck', 'OUTDATED'],
			['C_foreign', 'RESOLVED'],
		],
		'its having had someone else’s commits, at the head it replaced, is resolved; its having been stuck, at an earlier head, is only outdated',
	);
	t.end();
});
