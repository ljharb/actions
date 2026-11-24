import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';

import test from 'tape';

import { legend } from '../../../fleet/commands/syntax.mjs';
import { marker as workflowMarker } from '../../../fleet/drift/marker.mjs';
import { fixBranch, readmeBranch, relockBranch } from '../../../fleet/lib/branches.mjs';
import { marker as saidMarker } from '../../../fleet/lib/said.mjs';
import { marker } from '../../../fleet/readme/marker.mjs';
import { standardWorkflows } from '../drift/helpers/states.mjs';
import {
	bot,
	git,
	mallory,
	tempDir,
} from '../lib/helpers/git.mjs';
import { installedRepo } from '../lib/helpers/github.mjs';
import {
	comment,
	entry,
	issueToken,
	matching,
	passing,
	pending,
	pr,
	reactions,
	replies,
	runScript,
	writtenQueue,
} from './helpers/merge-run.mjs';
import { makeRemotes } from './helpers/remotes.mjs';

/** @import { Scenario as GitHubScenario, RepoSpec, Recorded } from '../lib/helpers/github.mjs' */
/** @import { CommandsScenario } from './helpers/preload.mjs' */
/** @import { MergeScenario } from './helpers/merge.mjs' */
/** @import { ChildResult } from '../drift/helpers/child.mjs' */
/** @import { Remotes } from './helpers/remotes.mjs' */
/** @import { Test } from 'tape' */

const script = path.join('fleet', 'commands', 'index.mjs');
const commentURL = 'https://github.com/ljharb/actions/issues/9#issuecomment-77';
const title = '[readme] update the heading and badges to match the fleet’s';
const notReport = /^not a comment on a fleet report; nothing to do$/m;

// the README drift report's issue, as the report opened it before the App wrote it (which the App adopted)
const report = {
	number: 9,
	body: `${marker}\nthe report`,
	user: { login: 'github-actions[bot]' },
};

// the workflow drift report's issue, which is a different report, with its own commands
const workflowReport = { ...report, body: `${workflowMarker}\nthe report` };

/**
 * A README that already matches the fleet's, for the package `name` in `repository`, whose default branch is `main`: written out in full here, rather than from the code under test, so that what it should be is said only once, independently.
 * @type {(name: string, repository: string) => string}
 */
function canonical(name, repository) {
	return [
		`# ${name} <sup>[![Version Badge][npm-version-svg]][package-url]</sup>`,
		'',
		'[![github actions][actions-image]][actions-url]',
		'[![coverage][codecov-image]][codecov-url]',
		'[![License][license-image]][license-url]',
		'[![Downloads][downloads-image]][downloads-url]',
		'',
		'[![npm badge][npm-badge-png]][package-url]',
		'',
		'A package.',
		'',
		'## Example',
		'',
		'Some prose.',
		'',
		`[package-url]: https://npmjs.org/package/${name}`,
		`[npm-version-svg]: https://versionbadg.es/${repository}.svg`,
		`[npm-badge-png]: https://nodei.co/npm/${name}.png?downloads=true&stars=true`,
		`[license-image]: https://img.shields.io/npm/l/${name}.svg`,
		'[license-url]: LICENSE',
		`[downloads-image]: https://img.shields.io/npm/dm/${name}.svg`,
		`[downloads-url]: https://npm-stat.com/charts.html?package=${name}`,
		`[codecov-image]: https://codecov.io/gh/${repository}/branch/main/graphs/badge.svg`,
		`[codecov-url]: https://app.codecov.io/gh/${repository}/`,
		`[actions-image]: https://img.shields.io/github/check-suites/${repository}/main`,
		`[actions-url]: https://github.com/${repository}/actions`,
		'',
	].join('\n');
}

/**
 * The ways a README in these tests drifts from the fleet's, each from `canonical`:
 * - `heading`: only the heading, which has no version badge
 * - `links`: only a link definition, which points somewhere else
 * - `travis`: an obsolete Travis CI badge under the heading, with the definitions only it uses: so its badges, and its links
 * - `both`: the heading, and a link definition
 * - `headless`: no heading at all, so nothing for its badges to be under, and a link definition
 * @type {Record<string, (name: string, repository: string) => string>}
 */
const drifted = {
	heading: (name, repository) => canonical(name, repository).replace(/^# .*$/m, `# ${name}`),
	links: (name, repository) => canonical(name, repository).replace('[license-url]: LICENSE\n', '[license-url]: LICENSE.md\n'),
	travis: (name, repository) => canonical(name, repository).replace(
		'[![Downloads][downloads-image]][downloads-url]\n',
		'[![Downloads][downloads-image]][downloads-url]\n[![Build Status][travis-svg]][travis-url]\n',
	).concat(`[travis-svg]: https://travis-ci.org/${repository}.svg\n[travis-url]: https://travis-ci.org/${repository}\n`),
	both: (name, repository) => drifted.links(name, repository).replace(/^# .*$/m, `# ${name}`),
	headless: (name, repository) => drifted.links(name, repository).replace(/^# .*\n\n/, ''),
};

/** @type {(name: string, extra?: Record<string, unknown>) => string} */
function packageJson(name, extra = {}) {
	return `${JSON.stringify({ name, version: '1.0.0', ...extra }, null, '\t')}\n`;
}

/**
 * The repository's state, as GitHub's GraphQL API gives it: a package (by default, named as the repository is) with `readme` as its `README.md`, a regular file (or, with `readmeMode`, another kind of entry; `null`, none at all).
 * @type {(options: {
 *   readme: string,
 *   pkg: string,
 *   config?: string,
 *   isPrivate?: boolean,
 *   archived?: boolean,
 *   readmeMode?: number | null,
 * }) => RepoSpec}
 */
function repo({
	readme,
	pkg,
	config,
	isPrivate = false,
	archived = false,
	readmeMode = 0o100644,
}) {
	const data = {
		isArchived: archived,
		isPrivate,
		defaultBranchRef: { name: 'main' },
		config: typeof config === 'string' ? { text: config } : null,
		packageJson: { text: pkg },
		root: {
			entries: [
				{ name: '.github', mode: 0o40000 },
				{ name: 'package.json', mode: 0o100644 },
				...readmeMode === null ? [] : [{ name: 'README.md', mode: readmeMode }],
			],
		},
		workflows: { entries: standardWorkflows().map(({ name, text }) => ({ name, type: 'blob', object: { text } })) },
	};
	// as the query reads it, which the helper's `RepositoryData` doesn't list, since only these tests need it
	return { data: Object.assign(data, { readme: readmeMode === null ? null : { text: readme, isTruncated: false } }) };
}

/**
 * Each repository in these tests, by name (in `ljharb`), as its `README.md`, `package.json`, and config are, and whether it's private.
 * @typedef {{ readme: string, pkg: string, config?: string, isPrivate?: boolean, archived?: boolean, readmeMode?: number | null }} Spec
 */

/** @type {(names: string[], kind: keyof typeof drifted | 'clean', extra?: Partial<Spec>) => Record<string, Spec>} */
function specs(names, kind, extra = {}) {
	return Object.fromEntries(names.map((n) => [
		n,
		{
			readme: kind === 'clean' ? canonical(n, `ljharb/${n}`) : drifted[kind](n, `ljharb/${n}`),
			pkg: packageJson(n),
			isPrivate: n.includes('secret'),
			...extra,
		},
	]));
}

/** @type {(all: Record<string, Spec>) => GitHubScenario} */
function githubFor(all) {
	const names = Object.keys(all).sort();
	return {
		installations: [{ id: 1, account: { login: 'ljharb' } }],
		installationRepos: { 1: names.map((n) => installedRepo('ljharb', n, { private: !!all[n].isPrivate })) },
		repos: Object.fromEntries(names.map((n) => [`ljharb/${n}`, repo(all[n])])),
	};
}

/**
 * A git server with each repository whose `main` has its `README.md` (unless it has none) and `package.json`, as the API says it does.
 * @type {(t: Test, all: Record<string, Spec>) => Remotes}
 */
function remotesFor(t, all) {
	return makeRemotes(t, Object.fromEntries(Object.entries(all).map(([n, {
		readme,
		pkg,
		config,
		readmeMode,
	}]) => [
		`ljharb/${n}`,
		{
			...readmeMode === null ? {} : { 'README.md': readme },
			'package.json': pkg,
			...typeof config === 'string' ? { '.github/ljharb-actions.json': config } : {},
		},
	])));
}

/**
 * Runs `line` as a comment on the README drift report's issue (or `issue`), against the mocked API, with `env` added to its environment.
 * @type {(t: Test, line: string, options?: {
 *   github?: GitHubScenario,
 *   commands?: CommandsScenario,
 *   merge?: MergeScenario,
 *   remotes?: Remotes,
 *   issue?: Record<string, unknown>,
 *   env?: Record<string, string>,
 * }) => ChildResult}
 */
function command(t, line, {
	github = {},
	commands = {},
	merge = {},
	remotes,
	issue = report,
	env = {},
} = {}) {
	return runScript(t, script, {
		event: { issue, comment: comment(line) },
		github,
		commands: {
			permissions: { maintainer: 'write' },
			...remotes ? { serverURL: remotes.serverURL } : {},
			...commands,
		},
		merge,
		env: {
			...remotes ? { GITHUB_SERVER_URL: remotes.serverURL } : {},
			...env,
		},
	});
}

/** @type {(requests: Recorded[]) => string[]} */
function changes(requests) {
	return requests.filter((r) => r.method !== 'GET' && (/\/(?:pulls|issues)\b/).test(r.path) && !(/\/ljharb\/actions\//).test(r.path)).map((r) => `${r.method} ${r.path}`);
}

// the table rows of the one reply
/** @type {(requests: Recorded[]) => string[]} */
function outcomeRows(requests) {
	return replies(requests)[0].split('\n').filter((l) => l.startsWith('| `'));
}

/** @type {(requests: Recorded[]) => Recorded[]} */
function repoTokens(requests) {
	return matching(requests, 'POST', /^\/app\/installations\/1\/access_tokens$/).filter((r) => r.body?.repositories);
}

/** @type {(dryRun: boolean) => string} */
function privateNote(dryRun) {
	return `Private repositories matching these filters, if any, ${dryRun ? 'would also be' : 'were also'} processed; nothing about them is shown here.`;
}

/** @type {(line: string, rows: string[], options?: { dryRun?: boolean, what?: string, serverURL?: string }) => string} */
function expectedReply(line, rows, { dryRun = false, what = 'from each repository’s `fleet/readme` branch', serverURL = 'https://github.com' } = {}) {
	return [
		`\`${line}\` (${dryRun ? 'a dry run, so nothing was changed' : what}; see [the run](${serverURL}/ljharb/actions/actions/runs/42)):`,
		'',
		...rows.length > 0 ? ['| Repository | Outcome |', '| --- | --- |', ...rows] : ['No repository matches those filters.'],
		'',
		privateNote(dryRun),
	].join('\n');
}

/** @type {(remotes: Remotes, repository: string, range: string) => string[]} */
function changedFiles(remotes, repository, range) {
	return git(path.join(remotes.serverURL, `${repository}.git`), ['diff', '--name-only', range]).split('\n').filter(Boolean);
}

/** @type {(requests: Recorded[]) => string[]} */
function refUpdates(requests) {
	return matching(requests, 'PATCH', /\/git\/refs\//).map((r) => `${r.path} ${r.body.sha}`);
}

test('fleet/commands: a comment on the README drift report’s issue is a command on that report', (t) => {
	const legacy = command(t, '/frob');
	t.equal(legacy.status, 0, 'opened by GitHub Actions’ bot: exits successfully');
	t.doesNotMatch(legacy.stdout, notReport, 'opened by GitHub Actions’ bot: it’s a report');
	t.deepEqual(matching(legacy.requests, 'GET', /^\/app$/), [], 'opened by GitHub Actions’ bot: without looking up the App’s bot');
	t.equal(replies(legacy.requests).length, 1, 'opened by GitHub Actions’ bot: so a command on it gets a reply');

	const author = command(t, '/frob', { issue: { ...report, user: { login: 'Fleet-Bot[bot]' } }, github: { appSlug: 'fleet-bot' } });
	t.equal(author.status, 0, 'opened by the App’s bot: exits successfully');
	t.doesNotMatch(author.stdout, notReport, 'opened by the App’s bot, whatever the case of its login: it’s a report');
	t.equal(author.requests[0] && `${author.requests[0].method} ${author.requests[0].path}`, 'GET /app', 'found by reading the App’s slug');
	t.equal(replies(author.requests).length, 1, 'opened by the App’s bot: so a command on it gets a reply');
	t.ok(matching(author.requests, 'POST', /^\/repos\/ljharb\/actions\/issues\/9\/comments$/).every((r) => r.authorization === issueToken), 'as the App’s bot');

	['mallory', 'other-app[bot]'].forEach((login) => {
		const { status, stdout, requests } = command(t, '/fix ljharb', { issue: { ...report, user: { login } } });
		t.equal(status, 0, `opened by ${login}: exits successfully`);
		t.match(stdout, notReport, `opened by ${login}: says it isn’t a report`);
		t.deepEqual(requests.map((r) => `${r.method} ${r.path}`), ['GET /app'], `opened by ${login}: only reads the App, to compare its bot’s login`);
	});

	[
		['without either report’s marker', { ...report, body: 'some other issue' }],
		['a PR with the marker', { ...report, pull_request: {} }], // eslint-disable-line camelcase
	].forEach(([label, issue]) => {
		const { status, stdout, requests } = command(t, '/fix ljharb', { issue: Object(issue) });
		t.equal(status, 0, `${label}: exits successfully`);
		t.match(stdout, notReport, `${label}: says it isn’t a report`);
		t.deepEqual(requests, [], `${label}: makes no request`);
	});

	t.end();
});

test('fleet/commands: replies on the README drift report with its own legend to anything it can’t run', (t) => {
	t.notEqual(legend({ report: 'readme' }), legend(), 'the README report’s legend is not the workflow report’s');
	[
		['/frob', 'Unknown command: `/frob`.'],
		['/fix', '`/fix` needs at least one filter: every repository at once is too broad.'],
		['/dry-run fix', '`/dry-run fix` needs at least one filter: every repository at once is too broad.'],
		// a workflow file name, or a workflow kind of discrepancy, is only a filter on the workflow drift report
		['/fix ljharb rebase.yml', '`rebase.yml` is a filter only on the other fleet report’s issue, not this one.'],
		['/dry-run fix ljharb missing drifted', '`missing`, `drifted` are filters only on the other fleet report’s issue, not this one.'],
		['/merge ljharb links', '`/merge` takes only repository (`owner/name`) and account (`owner`) filters, not `links`.'],
		['/dry-run merge heading', '`/dry-run merge` takes only repository (`owner/name`) and account (`owner`) filters, not `heading`.'],
	].forEach(([line, message]) => {
		const { status, stdout, requests } = command(t, line);
		t.equal(status, 0, `${line}: exits successfully`);
		t.deepEqual(replies(requests), [`${message} Nothing was done.\n\n${legend({ report: 'readme' })}`], `${line}: explains, then shows the README report’s legend`);
		t.deepEqual(reactions(requests), ['+eyes', '+confused', '-501'], `${line}: and swaps its 👀 for 😕`);
		t.deepEqual(matching(requests, 'GET', /^\/app\/installations/), [], `${line}: without discovering anything`);
		t.match(stdout, /^not a valid command; replied with how to use them$/m, `${line}: logs it`);
	});

	const workflows = command(t, '/frob', { issue: workflowReport });
	t.deepEqual(replies(workflows.requests), [`Unknown command: \`/frob\`. Nothing was done.\n\n${legend()}`], 'while the workflow report’s issue still gets its own');
	const elsewhere = command(t, '/fix ljharb links', { issue: workflowReport });
	t.equal(elsewhere.status, 0, 'a README drift report filter on the workflow report’s issue: exits successfully');
	t.deepEqual(
		replies(elsewhere.requests),
		[`\`links\` is a filter only on the other fleet report’s issue, not this one. Nothing was done.\n\n${legend()}`],
		'a README drift report filter on the workflow report’s issue: is the other report’s, with that issue’s legend',
	);
	t.deepEqual(matching(elsewhere.requests, 'GET', /^\/app\/installations/), [], 'a README drift report filter on the workflow report’s issue: without discovering anything');

	t.end();
});

test('fleet/commands: `/dry-run fix` on the README drift report says what it would do in each drifted public repository it covers', (t) => {
	const all = {
		...specs(['clean'], 'clean'),
		...specs(['heading'], 'heading'),
		...specs(['existing'], 'links'),
		...specs(['travis'], 'travis'),
		...specs(['secret'], 'heading'),
		...specs(['unpublished'], 'heading', { pkg: packageJson('unpublished', { private: true }) }),
		...specs(['optedout'], 'heading', { config: '{ "readme": false }' }),
		...specs(['archived'], 'heading', { archived: true }),
	};
	const {
		status,
		stdout,
		requests,
		summary,
	} = command(t, '/dry-run fix ljharb', {
		github: githubFor(all),
		commands: {
			pulls: {
				'ljharb/existing': [{
					number: 4,
					state: 'open',
					merged_at: null, // eslint-disable-line camelcase
					head: { sha: 'abc' },
				}],
			},
		},
	});

	t.equal(status, 0, 'exits successfully');
	const body = expectedReply(
		'/dry-run fix ljharb',
		[
			'| `ljharb/existing` | would update https://github.com/ljharb/existing/pull/4: the link definitions they use |',
			'| `ljharb/heading` | would create a PR: the heading |',
			'| `ljharb/travis` | would create a PR: the badges under it, the link definitions they use |',
		],
		{ dryRun: true },
	);
	t.deepEqual(replies(requests), [body], 'a row for each drifted public repository, with which kinds of discrepancy it would fix; a clean one, one that doesn’t publish a package, one that opted out, an archived one, and a private one aren’t listed');
	t.equal(summary, body, 'the run summary has the same');
	t.notOk(stdout.includes('secret') || summary.includes('secret'), 'never naming the private repository');

	t.deepEqual(
		repoTokens(requests).map((r) => r.body),
		['existing', 'heading', 'travis', 'secret'].map((name) => ({ repositories: [name], permissions: { pull_requests: 'read' } })), // eslint-disable-line camelcase
		'reads only each drifted repository it covers’ PRs, with a token for only that repository, that can only read PRs, a private one’s last',
	);
	const pulls = matching(requests, 'GET', /^\/repos\/ljharb\/[^/]+\/pulls\?/);
	t.ok(pulls.length > 0 && pulls.every((r) => new URLSearchParams(r.path.split('?')[1]).get('head') === `ljharb:${readmeBranch}`), 'looking for its PRs from the `fleet/readme` branch');
	t.deepEqual(changes(requests), [], 'changes nothing');
	t.deepEqual(reactions(requests), ['+eyes', '+rocket', '-501'], 'and swaps its 👀 for 🚀');

	t.end();
});

test('fleet/commands: `/fix` on the README drift report fixes each repository in a one-commit PR from its `fleet/readme` branch, changing only `README.md`', (t) => {
	const all = {
		...specs(['clean'], 'clean'),
		...specs(['heading'], 'heading'),
		...specs(['existing'], 'links'),
		...specs(['travis'], 'travis'),
		...specs(['secret'], 'heading'),
		...specs(['unpublished'], 'heading', { pkg: packageJson('unpublished', { private: true }) }),
		...specs(['optedout'], 'heading', { config: '{ "readme": false }' }),
	};
	const remotes = remotesFor(t, all);
	// an earlier `/fix` left something else on its branch
	const earlier = remotes.commit('ljharb/existing', readmeBranch, { 'README.md': 'an earlier fix\n' }, { who: bot, from: 'main' });
	const names = ['clean', 'existing', 'heading', 'optedout', 'secret', 'travis', 'unpublished'];
	const line = `/fix ${names.map((n) => `ljharb/${n}`).join(' ')}`;

	const {
		status,
		stdout,
		requests,
		summary,
	} = command(t, line, {
		github: githubFor(all),
		commands: {
			pulls: {
				'ljharb/existing': [{
					number: 4,
					state: 'open',
					merged_at: null, // eslint-disable-line camelcase
					head: { sha: earlier },
				}],
			},
		},
		remotes,
	});

	t.equal(status, 0, 'exits successfully');
	t.notOk((/^::(?:warning|error)::/m).test(stdout), 'without warning');

	const { serverURL } = remotes;
	const body = expectedReply(
		line,
		[
			'| `ljharb/clean` | nothing to fix |',
			`| \`ljharb/existing\` | updated ${serverURL}/ljharb/existing/pull/4 |`,
			`| \`ljharb/heading\` | created ${serverURL}/ljharb/heading/pull/1 |`,
			`| \`ljharb/travis\` | created ${serverURL}/ljharb/travis/pull/1 |`,
		],
		{ serverURL },
	);
	t.deepEqual(replies(requests), [body], 'a row for each named public repository it covers, saying what happened; none for one that doesn’t publish a package, one that opted out, or a private one');
	t.equal(summary, body, 'the run summary has the same');
	t.notOk(stdout.includes('secret'), 'never naming the private repository');

	t.deepEqual(
		changes(requests),
		[
			'PATCH /repos/ljharb/existing/pulls/4',
			'POST /repos/ljharb/heading/pulls',
			'POST /repos/ljharb/travis/pulls',
			'POST /repos/ljharb/secret/pulls',
		],
		'updates the existing PR, and creates the others, a private one’s last; nothing else',
	);
	t.deepEqual(
		repoTokens(requests).map((r) => r.body),
		['existing', 'heading', 'travis', 'secret'].map((name) => ({
			repositories: [name],
			permissions: {
				contents: 'write',
				pull_requests: 'write', // eslint-disable-line camelcase
				workflows: 'write',
			},
		})),
		'each with its own token, for only that repository, that can push and open PRs, and push a branch onto a base whose commits change workflow files, which GitHub refuses without `workflows: write`',
	);

	const [created] = matching(requests, 'POST', /^\/repos\/ljharb\/heading\/pulls$/);
	t.equal(created.authorization, 'token ghs_installation_1', 'with the installation’s token');
	t.deepEqual(
		{ ...created.body, body: undefined },
		{
			base: 'main',
			head: readmeBranch,
			title,
			body: undefined,
		},
		'from `fleet/readme`, into the default branch, titled',
	);
	t.equal(
		created.body.body,
		[
			`This makes \`README.md\`’s heading, the badges under it, and the link definitions they use match the fleet’s (see [\`ljharb/actions\`’s README drift report](${serverURL}/ljharb/actions/tree/HEAD/fleet/readme)), as asked in [this comment](${commentURL}):`,
			'',
			'- the heading',
		].join('\n'),
		'with a body saying what it fixes, linking the comment',
	);

	['heading', 'existing', 'travis', 'secret'].forEach((n) => {
		const repository = `ljharb/${n}`;
		t.deepEqual(remotes.log(repository, `main..${readmeBranch}`), [`${bot.name} <${bot.email}>|${bot.name} <${bot.email}>|${title}`], `${repository}: one commit, by the bot, on \`main\``);
		t.deepEqual(changedFiles(remotes, repository, `main..${readmeBranch}`), ['README.md'], `${repository}: changing only \`README.md\``);
		t.equal(remotes.show(repository, readmeBranch, 'README.md'), canonical(n, repository), `${repository}: to match the fleet’s`);
	});
	const [updated] = matching(requests, 'PATCH', /^\/repos\/ljharb\/existing\/pulls\/4$/);
	t.equal(updated.body.title, title, 'the existing PR is retitled');
	t.ok(updated.body.body.endsWith('\n\n- the link definitions they use'), 'and its body says what it fixes');
	const [travis] = matching(requests, 'POST', /^\/repos\/ljharb\/travis\/pulls$/);
	t.ok(travis.body.body.endsWith('\n\n- the badges under it\n- the link definitions they use'), 'an obsolete badge’s PR says it fixes the badges, and the definitions they use');

	['clean', 'unpublished', 'optedout'].forEach((n) => {
		t.equal(remotes.tip(`ljharb/${n}`, `refs/heads/${readmeBranch}`), '', `ljharb/${n}: nothing is pushed`);
	});
	t.notOk(repoTokens(requests).some((r) => ['unpublished', 'optedout'].includes(r.body.repositories[0])), 'and a repository that doesn’t publish a package, or opted out, is never even touched');
	t.deepEqual(reactions(requests), ['+eyes', '+rocket', '-501'], 'and swaps its 👀 for 🚀');

	t.end();
});

test('fleet/commands: a kind of discrepancy filters what `/fix` fixes on the README drift report', (t) => {
	const all = {
		...specs(['both'], 'both'),
		...specs(['heading'], 'heading'),
	};
	const remotes = remotesFor(t, all);

	const dry = command(t, '/dry-run fix ljharb links', { github: githubFor(all) });
	t.equal(dry.status, 0, 'a dry run exits successfully');
	t.deepEqual(
		replies(dry.requests),
		[expectedReply('/dry-run fix ljharb links', ['| `ljharb/both` | would create a PR: the link definitions they use |'], { dryRun: true })],
		'saying it would fix only the links, only where they’ve drifted',
	);

	const {
		status,
		requests,
	} = command(t, '/fix ljharb LINKS', { github: githubFor(all), remotes });
	t.equal(status, 0, 'exits successfully');
	t.deepEqual(
		replies(requests),
		[expectedReply('/fix ljharb LINKS', [`| \`ljharb/both\` | created ${remotes.serverURL}/ljharb/both/pull/1 |`], { serverURL: remotes.serverURL })],
		'fixing only the repository whose links have drifted, case-insensitively',
	);
	t.deepEqual(changes(requests), ['POST /repos/ljharb/both/pulls'], 'in one PR');
	t.equal(remotes.show('ljharb/both', readmeBranch, 'README.md'), drifted.heading('both', 'ljharb/both'), 'whose README’s links are fixed, but not its heading');
	t.deepEqual(changedFiles(remotes, 'ljharb/both', `main..${readmeBranch}`), ['README.md'], 'changing only `README.md`');
	const [created] = matching(requests, 'POST', /^\/repos\/ljharb\/both\/pulls$/);
	t.ok(created.body.body.endsWith(':\n\n- the link definitions they use'), 'and its body says it fixes only the links');
	t.equal(remotes.tip('ljharb/heading', `refs/heads/${readmeBranch}`), '', 'a repository whose links match isn’t touched');

	t.end();
});

test('fleet/commands: on the README drift report, a kind of discrepancy without a named repository leaves out one whose README matches', (t) => {
	const all = {
		...specs(['clean'], 'clean'),
		...specs(['both'], 'both'),
	};

	const {
		status,
		requests,
	} = command(t, '/dry-run fix ljharb links', { github: githubFor(all) });
	t.equal(status, 0, 'exits successfully');
	t.deepEqual(
		replies(requests),
		[expectedReply('/dry-run fix ljharb links', ['| `ljharb/both` | would create a PR: the link definitions they use |'], { dryRun: true })],
		'listing only the repository whose links have drifted',
	);
	t.deepEqual(
		repoTokens(requests).map((r) => r.body),
		[{ repositories: ['both'], permissions: { pull_requests: 'read' } }], // eslint-disable-line camelcase
		'with no token for the one whose README matches',
	);
	t.deepEqual(changes(requests), [], 'changes nothing');

	t.end();
});

test('fleet/commands: on the README drift report, a repository that doesn’t publish a package, or opted out, is never touched, even when named', (t) => {
	const all = {
		...specs(['unpublished'], 'heading', { pkg: packageJson('unpublished', { private: true }) }),
		...specs(['optedout'], 'heading', { config: '{ "readme": false }' }),
		...specs(['nameless'], 'heading', { pkg: '{ "version": "1.0.0", "private": true }\n' }),
	};
	const remotes = remotesFor(t, all);
	const line = '/fix ljharb/unpublished ljharb/optedout ljharb/nameless';
	const { status, requests } = command(t, line, { github: githubFor(all), remotes });
	t.equal(status, 0, 'exits successfully');
	t.deepEqual(replies(requests), [expectedReply(line, [], { serverURL: remotes.serverURL })], 'saying that no repository matches');
	t.deepEqual(repoTokens(requests), [], 'without even a token for any of them');
	Object.keys(all).forEach((n) => {
		t.equal(remotes.tip(`ljharb/${n}`, `refs/heads/${readmeBranch}`), '', `ljharb/${n}: nothing is pushed`);
	});

	// an account's default opts its repositories out, unless one opts back in
	const accountAll = {
		...specs(['defaulted'], 'heading'),
		...specs(['optedin'], 'heading', { config: '{ "readme": true }' }),
	};
	const account = command(t, '/dry-run fix ljharb', { github: { ...githubFor(accountAll), accounts: { ljharb: { text: '{ "readme": false }' } } } });
	t.equal(account.status, 0, 'exits successfully');
	t.deepEqual(
		replies(account.requests),
		[expectedReply('/dry-run fix ljharb', ['| `ljharb/optedin` | would create a PR: the heading |'], { dryRun: true })],
		'an account’s `.github` repository’s `"readme": false` opts out each of its repositories that doesn’t opt back in',
	);

	t.end();
});

test('fleet/commands: on the README drift report, a private repository’s outcome is never output', (t) => {
	const all = {
		...specs(['alpha'], 'heading'),
		...specs(['zulu'], 'travis'),
		...specs(['gamma-secret'], 'heading'),
		...specs(['mid-secret'], 'links'),
	};
	const remotes = remotesFor(t, all);
	// someone else's commit on its `fleet/readme` branch, whose files a refusal would list
	remotes.commit('ljharb/mid-secret', readmeBranch, { 'docs/acquisition-plan.md': 'shh\n' }, { who: mallory, from: 'main' });
	// not on the git server at all, so cloning it fails
	const withBroken = { ...all, ...specs(['beta-secret'], 'heading') };

	const {
		status,
		stdout,
		stderr,
		requests,
		summary,
	} = command(t, '/fix ljharb', { github: githubFor(withBroken), remotes });

	t.equal(status, 0, 'exits successfully, though private repositories failed');
	t.deepEqual(stdout.split('\n').filter((l) => (/^::(?:warning|error|notice)/).test(l)), [], 'warning about none of them');
	t.deepEqual(reactions(requests), ['+eyes', '+rocket', '-501'], 'and swaps its 👀 for 🚀');
	t.deepEqual(
		repoTokens(requests).map((r) => r.body.repositories[0]),
		['alpha', 'zulu', 'beta-secret', 'gamma-secret', 'mid-secret'],
		'every public repository is fixed before any private one',
	);
	t.deepEqual(changes(requests), ['POST /repos/ljharb/alpha/pulls', 'POST /repos/ljharb/zulu/pulls', 'POST /repos/ljharb/gamma-secret/pulls'], 'a private repository is still fixed');
	t.equal(remotes.show('ljharb/gamma-secret', readmeBranch, 'README.md'), canonical('gamma-secret', 'ljharb/gamma-secret'), 'to match the fleet’s');

	const [reply] = replies(requests);
	const secrets = ['secret', 'acquisition', 'git clone', 'does not exist', 'someone else', 'private repositor', 'Mallory'];
	[['the log', stdout], ['stderr', stderr], ['the summary', summary], ['the reply', reply.replace(privateNote(false), '')]].forEach(([where, text]) => {
		t.deepEqual(secrets.filter((secret) => text.includes(secret)), [], `${where} reveals nothing about a private repository`);
	});
	t.deepEqual(
		reply.split('\n').filter((l) => l.startsWith('| `')),
		[
			`| \`ljharb/alpha\` | created ${remotes.serverURL}/ljharb/alpha/pull/1 |`,
			`| \`ljharb/zulu\` | created ${remotes.serverURL}/ljharb/zulu/pull/1 |`,
		],
		'the reply lists only the public repositories',
	);
	t.ok(reply.endsWith(`\n\n${privateNote(false)}`), 'and ends by saying only that any private repositories matching were processed too');

	t.end();
});

test('fleet/commands: on the README drift report, `/fix` leaves a README it can’t check as it is, saying why, without failing', (t) => {
	const all = {
		...specs(['heading'], 'heading'),
		...specs(['missing'], 'clean', { readmeMode: null }),
		...specs(['symlinked'], 'heading', { readmeMode: 0o120000 }),
	};
	const remotes = remotesFor(t, all);
	const line = '/fix ljharb';
	const {
		status,
		stdout,
		requests,
		summary,
	} = command(t, line, { github: githubFor(all), remotes });

	t.equal(status, 0, 'exits successfully');
	t.notOk((/^::error::/m).test(stdout), 'without an error');
	const body = expectedReply(
		line,
		[
			`| \`ljharb/heading\` | created ${remotes.serverURL}/ljharb/heading/pull/1 |`,
			'| `ljharb/missing` | nothing to fix<br>left as it is: there is no `README.md` |',
			'| `ljharb/symlinked` | nothing to fix<br>left as it is: `README.md` is not a regular file |',
		],
		{ serverURL: remotes.serverURL },
	);
	t.deepEqual(replies(requests), [body], 'a repository with no `README.md`, or one that isn’t a regular file, has nothing to fix, and says why it was left as it is');
	t.equal(summary, body, 'the run summary has the same');
	t.deepEqual(changes(requests), ['POST /repos/ljharb/heading/pulls'], 'opening a PR only where it can fix the README');
	['missing', 'symlinked'].forEach((n) => {
		t.equal(remotes.tip(`ljharb/${n}`, `refs/heads/${readmeBranch}`), '', `ljharb/${n}: nothing is pushed`);
	});
	t.deepEqual(reactions(requests), ['+eyes', '+rocket', '-501'], 'and swaps its 👀 for 🚀');

	const dry = command(t, '/dry-run fix ljharb/missing ljharb/symlinked', { github: githubFor(all) });
	t.equal(dry.status, 0, 'a dry run exits successfully');
	t.deepEqual(
		replies(dry.requests),
		[expectedReply('/dry-run fix ljharb/missing ljharb/symlinked', [
			'| `ljharb/missing` | nothing to fix<br>left as it is: there is no `README.md` |',
			'| `ljharb/symlinked` | nothing to fix<br>left as it is: `README.md` is not a regular file |',
		], { dryRun: true })],
		'saying the same',
	);
	t.deepEqual(reactions(dry.requests), ['+eyes', '+rocket', '-501'], 'and a dry run swaps its 👀 for 🚀 too');

	t.end();
});

test('fleet/commands: on the README drift report, `/fix` leaves an open PR as it is when the default branch’s README became one it can’t check since it was read', (t) => {
	[
		{
			n: 'symlinked',
			// the default branch's `README.md` is now a symbolic link, though the API read it as a regular, drifted file
			change: (/** @type {Remotes} */ remotes) => remotes.commit('ljharb/symlinked', 'main', { 'docs/README.md': 'elsewhere\n' }, { links: { 'README.md': 'docs/README.md' } }),
			why: '`README.md` is not a regular file',
		},
		{
			n: 'missing',
			// the default branch's `README.md` is now gone, though the API read it as a regular, drifted file
			change: (/** @type {Remotes} */ remotes) => remotes.commit('ljharb/missing', 'main', { 'README.md': null }),
			why: 'there is no `README.md`',
		},
	].forEach(({ n, change, why }) => {
		const repository = `ljharb/${n}`;
		const all = specs([n], 'heading');
		const remotes = remotesFor(t, all);
		change(remotes);
		// an earlier `/fix` opened a PR from its branch, before the README changed
		const earlier = remotes.commit(repository, readmeBranch, { 'README.md': canonical(n, repository) }, { who: bot, from: 'main~1' });
		const line = `/fix ${repository}`;

		const {
			status,
			stdout,
			requests,
			summary,
		} = command(t, line, {
			github: githubFor(all),
			commands: {
				pulls: {
					[repository]: [{
						number: 4,
						state: 'open',
						merged_at: null, // eslint-disable-line camelcase
						head: { sha: earlier },
					}],
				},
			},
			remotes,
		});

		t.equal(status, 0, `${n}: exits successfully`);
		t.notOk((/^::error::/m).test(stdout), `${n}: without an error`);
		const body = expectedReply(line, [`| \`${repository}\` | nothing to fix<br>left as it is: ${why} |`], { serverURL: remotes.serverURL });
		t.deepEqual(replies(requests), [body], `${n}: has nothing to fix, saying why it was left as it is`);
		t.equal(summary, body, `${n}: the run summary has the same`);
		t.deepEqual(changes(requests), [], `${n}: neither comments on, updates, nor closes the open PR`);
		t.deepEqual(matching(requests, 'PATCH', /\/pulls\/4$/), [], `${n}: with no request to update or close it`);
		t.equal(remotes.tip(repository, `refs/heads/${readmeBranch}`), earlier, `${n}: and pushes nothing`);
		t.deepEqual(reactions(requests), ['+eyes', '+rocket', '-501'], `${n}: and swaps its 👀 for 🚀`);
	});

	t.end();
});

test('fleet/commands: on the README drift report, `/fix` says what it can’t fix in a README, both in its PR and in its row', (t) => {
	const all = specs(['headless'], 'headless');
	const repository = 'ljharb/headless';

	const badges = command(t, `/fix ${repository} badges`, { github: githubFor(all), remotes: remotesFor(t, all) });
	t.equal(badges.status, 0, 'only what it can’t fix: exits successfully');
	t.deepEqual(
		outcomeRows(badges.requests),
		['| `ljharb/headless` | nothing to fix<br>left as it is: there’s no heading to put the badges under |'],
		'only what it can’t fix: has nothing to fix, saying why it was left as it is',
	);
	t.deepEqual(changes(badges.requests), [], 'only what it can’t fix: opens no PR');

	const remotes = remotesFor(t, all);
	const line = `/fix ${repository} badges links`;
	const { status, requests } = command(t, line, { github: githubFor(all), remotes });
	t.equal(status, 0, 'exits successfully');
	t.deepEqual(
		replies(requests),
		[expectedReply(line, [`| \`${repository}\` | created ${remotes.serverURL}/${repository}/pull/1<br>left as it is: there’s no heading to put the badges under |`], { serverURL: remotes.serverURL })],
		'saying it created a PR, and what it left as it is',
	);
	const [created] = matching(requests, 'POST', /^\/repos\/ljharb\/headless\/pulls$/);
	t.equal(
		created.body.body,
		[
			`This makes \`README.md\`’s heading, the badges under it, and the link definitions they use match the fleet’s (see [\`ljharb/actions\`’s README drift report](${remotes.serverURL}/ljharb/actions/tree/HEAD/fleet/readme)), as asked in [this comment](${commentURL}):`,
			'',
			'- the badges under it',
			'- the link definitions they use',
			'',
			'These are left as they are:',
			'',
			'- there’s no heading to put the badges under',
		].join('\n'),
		'whose body lists what it fixes, then what it left as it is',
	);
	t.equal(
		remotes.show(repository, readmeBranch, 'README.md'),
		canonical('headless', repository).replace(/^# .*\n\n/, ''),
		'fixing its links, but adding neither a heading nor badges',
	);

	t.end();
});

test('fleet/commands: on the README drift report, `/fix` closes the App’s PR when the default branch’s README already matches, unless filters limited what it planned', (t) => {
	const names = [
		'filtered',
		'foreign',
		'none',
		'open',
	];
	const all = specs(names, 'heading');
	const remotes = remotesFor(t, all);
	/** @type {Record<string, string>} */
	const heads = {};
	names.forEach((n) => {
		const repository = `ljharb/${n}`;
		// since it was read, the default branch was fixed by hand
		remotes.commit(repository, 'main', { 'README.md': canonical(n, repository) });
		if (n !== 'none') {
			// an earlier `/fix` opened a PR from its branch, before then
			heads[n] = remotes.commit(repository, readmeBranch, { 'README.md': canonical(n, repository) }, { who: bot, from: 'main~1' });
		}
	});
	heads.foreign = remotes.commit('ljharb/foreign', readmeBranch, { 'notes.md': 'theirs\n' }, { who: mallory });
	const why = '`main`’s `README.md` already matches';
	const pulls = Object.fromEntries(Object.entries(heads).map(([n, sha]) => [
		`ljharb/${n}`,
		[{
			number: 4,
			state: 'open',
			merged_at: null, // eslint-disable-line camelcase
			head: { sha },
		}],
	]));
	const filtered = command(t, '/fix ljharb/filtered heading', { github: githubFor(all), commands: { pulls }, remotes });
	t.equal(filtered.status, 0, 'filtered: exits successfully');
	t.deepEqual(outcomeRows(filtered.requests), [`| \`ljharb/filtered\` | nothing to fix: ${why} |`], 'filtered: has nothing to fix, since its base matches');
	t.deepEqual(changes(filtered.requests), [], 'filtered: but never closes the PR, since what it didn’t plan may not match');
	t.equal(remotes.tip('ljharb/filtered', `refs/heads/${readmeBranch}`), heads.filtered, 'filtered: pushing nothing');

	const line = '/fix ljharb/foreign ljharb/none ljharb/open';
	const {
		status,
		stdout,
		requests,
	} = command(t, line, { github: githubFor(all), commands: { pulls }, remotes });
	t.equal(status, 1, 'fails, since one PR has someone else’s commits');
	t.match(stdout, /^::warning::ljharb\/foreign: `fleet\/readme` has 1 commit\(s\) by someone else, so it is never overwritten/m, 'which is never closed');
	const outcomes = outcomeRows(requests);
	t.match(outcomes[0], /^\| `ljharb\/foreign` \| failed: `.*has 1 commit\(s\) by someone else, so it is never overwritten.*` \|$/, 'saying why it failed');
	t.deepEqual(
		outcomes.slice(1),
		[
			`| \`ljharb/none\` | nothing to fix: ${why} |`,
			`| \`ljharb/open\` | closed ${remotes.serverURL}/ljharb/open/pull/4: ${why} |`,
		],
		'with no PR, makes none; with the App’s own, closes it',
	);
	t.deepEqual(changes(requests), ['POST /repos/ljharb/open/issues/4/comments', 'PATCH /repos/ljharb/open/pulls/4'], 'saying why, then closing it; nothing else');
	t.deepEqual(
		matching(requests, 'POST', /^\/repos\/ljharb\/open\/issues\/4\/comments$/).map((r) => r.body.body),
		[`${saidMarker('matches', heads.open)}\n${why} what this PR would make it, so the App closes it.`],
		'once for its head commit',
	);
	t.deepEqual(matching(requests, 'PATCH', /^\/repos\/ljharb\/open\/pulls\/4$/).map((r) => r.body), [{ state: 'closed' }], 'closing it');
	names.forEach((n) => {
		t.equal(remotes.tip(`ljharb/${n}`, `refs/heads/${readmeBranch}`), heads[n] ?? '', `nothing is pushed to \`ljharb/${n}\``);
	});

	t.end();
});

test('fleet/commands: on the README drift report, `/fix` fails a repository whose state it couldn’t read, and carries on, cloning into the system’s temp directory without `RUNNER_TEMP`', (t) => {
	const all = {
		...specs(['heading'], 'heading'),
		...specs(['invalid'], 'heading', { pkg: '{\n' }),
	};
	const remotes = remotesFor(t, all);
	const github = {
		...githubFor(all),
		// `ljharb/gone` is installed, but its state can't be read
		installationRepos: { 1: ['gone'].concat(Object.keys(all).sort()).map((n) => installedRepo('ljharb', n)) },
	};
	const line = '/fix ljharb';

	const {
		status,
		stdout,
		requests,
	} = command(t, line, {
		github,
		remotes,
		env: { RUNNER_TEMP: '' },
	});
	t.equal(status, 1, 'fails');
	t.match(stdout, /^::error::1 repository could not be fixed$/m, 'saying how many');
	t.deepEqual(
		replies(requests),
		[expectedReply(
			line,
			[
				'| `ljharb/gone` | failed: `could not read the repository’s state` |',
				`| \`ljharb/heading\` | created ${remotes.serverURL}/ljharb/heading/pull/1 |`,
				'| `ljharb/invalid` | nothing to fix<br>left as it is: `package.json` is not valid JSON |',
			],
			{ serverURL: remotes.serverURL },
		)],
		'saying why one failed, fixing the next, and leaving one whose `package.json` isn’t valid JSON as it is, saying why',
	);
	t.equal(remotes.show('ljharb/heading', readmeBranch, 'README.md'), canonical('heading', 'ljharb/heading'), 'and pushed');
	t.equal(remotes.tip('ljharb/invalid', `refs/heads/${readmeBranch}`), '', 'pushing nothing for the one it left as it is');

	t.end();
});

test('fleet/commands: on the README drift report, `/fix` never writes through a `README.md` that is a symbolic link in its clone', (t) => {
	const all = specs(['heading'], 'heading');
	const remotes = remotesFor(t, all);
	// git, configured to run a hook that, as soon as the clone is checked out, makes its `README.md` a symbolic link, though the commit still has it as a regular file
	const dir = tempDir(t, 'fleet-commands-hooks');
	const hooks = path.join(dir, 'hooks');
	mkdirSync(hooks);
	writeFileSync(path.join(hooks, 'post-checkout'), '#!/bin/sh\nrm -f README.md\nln -s package.json README.md\n', { mode: 0o755 });
	const config = path.join(dir, 'gitconfig');
	writeFileSync(config, `[core]\n\thooksPath = ${hooks}\n`);

	const {
		status,
		stdout,
		requests,
	} = command(t, '/fix ljharb/heading', {
		github: githubFor(all),
		remotes,
		env: { GIT_CONFIG_GLOBAL: config },
	});
	t.equal(status, 1, 'fails');
	t.match(stdout, /^::warning::ljharb\/heading: `README\.md` is a symbolic link, so nothing is written through it$/m, 'refusing to write through it');
	t.ok(replies(requests)[0].includes('| `ljharb/heading` | failed: `` `README.md` is a symbolic link, so nothing is written through it `` |'), 'saying why it failed');
	t.deepEqual(changes(requests), [], 'opening no PR');
	t.equal(remotes.tip('ljharb/heading', `refs/heads/${readmeBranch}`), '', 'and pushing nothing');

	t.end();
});

test('fleet/commands: `/merge` on each report merges only the PRs from that report’s own branches', (t) => {
	const all = {
		...specs(['a', 'b'], 'clean'),
		...specs(['unpublished'], 'clean', { pkg: packageJson('unpublished', { private: true }) }),
	};
	/** @type {MergeScenario} */
	const merge = {
		openPulls: {
			'ljharb/a': [pr('ljharb/a', 1, readmeBranch), pr('ljharb/a', 2, fixBranch), pr('ljharb/a', 3, relockBranch)],
			'ljharb/b': [pr('ljharb/b', 1, readmeBranch), pr('ljharb/b', 2, fixBranch)],
			'ljharb/unpublished': [pr('ljharb/unpublished', 1, readmeBranch)],
		},
		ci: {
			'a-1': passing,
			'a-2': passing,
			'a-3': passing,
			'b-1': pending,
			'b-2': pending,
			'unpublished-1': passing,
		},
	};
	const what = 'from each repository’s `fleet/readme` PRs by the App’s bot';

	const dry = command(t, '/dry-run merge ljharb', { github: githubFor(all), merge });
	t.equal(dry.status, 0, 'a dry run exits successfully');
	t.deepEqual(
		replies(dry.requests),
		[[
			'`/dry-run merge ljharb` (a dry run, so nothing was changed or queued; see [the run](https://github.com/ljharb/actions/actions/runs/42)):',
			'',
			'| Repository | Outcome |',
			'| --- | --- |',
			'| `ljharb/a` | would merge https://github.com/ljharb/a/pull/1 |',
			'| `ljharb/b` | would queue https://github.com/ljharb/b/pull/1: its checks haven’t all finished, so it would be merged once they pass |',
			'| `ljharb/unpublished` | would merge https://github.com/ljharb/unpublished/pull/1 |',
			'',
			privateNote(true),
		].join('\n')],
		'says it would merge, or queue, only each `fleet/readme` PR, in every installed repository, even one the report doesn’t cover',
	);
	t.deepEqual(refUpdates(dry.requests), [], 'merging nothing');
	t.equal(writtenQueue(dry.requests), undefined, 'and queueing nothing');

	const {
		status,
		requests,
	} = command(t, '/merge ljharb', { github: githubFor(all), merge });
	t.equal(status, 0, 'exits successfully');
	t.deepEqual(
		refUpdates(requests),
		['/repos/ljharb/a/git/refs/heads%2Fmain a-1', '/repos/ljharb/unpublished/git/refs/heads%2Fmain unpublished-1'],
		'fast-forwards only to the passing `fleet/readme` PRs, not the passing `fleet/workflows` and `actions-lock/relock` ones beside one, including in a repository the report doesn’t cover',
	);
	t.deepEqual(writtenQueue(requests), [entry('ljharb/b', 1)], 'and queues only the pending `fleet/readme` PR, not the pending `fleet/workflows` one beside it');
	const heads = matching(requests, 'GET', /^\/repos\/ljharb\/[^/]+\/pulls\?/).map((r) => new URLSearchParams(r.path.split('?')[1]).get('head'));
	t.ok(heads.length > 0 && heads.every((head) => head === `ljharb:${readmeBranch}`), 'only ever listing PRs from `fleet/readme`');
	t.ok(matching(requests, 'GET', /^\/repos\/ljharb\/unpublished\/pulls\?/).length > 0, 'considering a repository the report doesn’t cover, as the workflow drift report’s `/merge` does');
	t.deepEqual(
		replies(requests),
		[[
			`\`/merge ljharb\` (${what}; see [the run](https://github.com/ljharb/actions/actions/runs/42)):`,
			'',
			'| Repository | Outcome |',
			'| --- | --- |',
			'| `ljharb/a` | merged https://github.com/ljharb/a/pull/1 |',
			'| `ljharb/b` | queued https://github.com/ljharb/b/pull/1: its checks haven’t all finished, so it’ll be merged once they pass |',
			'| `ljharb/unpublished` | merged https://github.com/ljharb/unpublished/pull/1 |',
			'',
			privateNote(false),
		].join('\n')],
		'saying what happened to each',
	);
	t.deepEqual(reactions(requests), ['+eyes'], 'and, since it queued a public PR, keeps its 👀 until the queue resolves it');

	const workflows = command(t, '/merge ljharb/a', { github: githubFor(all), merge, issue: workflowReport });
	t.equal(workflows.status, 0, 'on the workflow report: exits successfully');
	t.deepEqual(
		refUpdates(workflows.requests),
		['/repos/ljharb/a/git/refs/heads%2Fmain a-2', '/repos/ljharb/a/git/refs/heads%2Fmain a-3'],
		'on the workflow report: merges only its own branches’ PRs, `fleet/workflows` and `actions-lock/relock`, never the `fleet/readme` one',
	);
	const workflowHeads = matching(workflows.requests, 'GET', /^\/repos\/ljharb\/a\/pulls\?/).map((r) => new URLSearchParams(r.path.split('?')[1]).get('head'));
	t.notOk(workflowHeads.includes(`ljharb:${readmeBranch}`), 'on the workflow report: never even listing `fleet/readme` PRs');

	t.end();
});
