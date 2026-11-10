import nock from 'nock';
import test from 'tape';

import { runMerge } from '../../../fleet/commands/merge.mjs';
import { appAuth } from '../../../fleet/lib/app.mjs';
import { fixBranch } from '../../../fleet/lib/branches.mjs';
import { repoState } from '../drift/helpers/states.mjs';
import { mockGitHub, privateKey } from '../lib/helpers/github.mjs';
import { mockMerge } from './helpers/merge.mjs';
import {
	expectedDetails,
	failing,
	passing,
	pr,
} from './helpers/merge-run.mjs';

/** @import { Recorded } from '../lib/helpers/github.mjs' */

test('runMerge: never a repository the App isn’t installed on, nor an archived one', async (t) => {
	nock.disableNetConnect();
	/** @type {Recorded[]} */
	const requests = [];
	const teardowns = [
		mockGitHub({}, (r) => requests.push(r)),
		mockMerge(
			{
				openPulls: Object.fromEntries(['ljharb/a', 'ljharb/source', 'ljharb/archived'].map((repository) => [repository, [pr(repository, 1, fixBranch)]])),
				ci: { 'a-1': passing, 'source-1': passing, 'archived-1': passing },
			},
			(r) => requests.push(r),
		),
	];
	t.teardown(() => {
		teardowns.forEach((teardown) => teardown());
		nock.enableNetConnect();
	});

	const result = await runMerge(
		{
			auth: appAuth('1', privateKey()),
			dryRun: true,
			commentId: 77,
			issueNumber: 9,
			async finishOther() { t.fail('finishes no other command'); },
			progress: { queued: false },
		},
		[
			repoState({ name: 'a', repository: 'ljharb/a' }),
			repoState({ name: 'source', repository: 'ljharb/source', external: true }),
			repoState({ name: 'archived', repository: 'ljharb/archived', archived: true }),
		],
		{ repositories: new Set(), accounts: new Set(['ljharb']) },
	);

	t.deepEqual(
		result,
		{
			rows: ['| `ljharb/a` | would merge https://github.com/ljharb/a/pull/1 |'],
			details: [],
			ok: true,
		},
		'only the installed, unarchived repository',
	);
	t.deepEqual(requests.filter((r) => (/^\/repos\/ljharb\/(?:source|archived)\//).test(r.path)), [], 'the others are never even read');

	const none = await runMerge(
		{
			auth: appAuth('1', privateKey()),
			dryRun: true,
			commentId: 77,
			issueNumber: 9,
			async finishOther() { t.fail('finishes no other command'); },
			progress: { queued: false },
		},
		[repoState({ name: 'a', repository: 'ljharb/a' })],
		{ repositories: new Set(['ljharb/b']), accounts: new Set() },
	);
	t.deepEqual(
		none,
		{
			rows: [],
			details: [],
			ok: true,
		},
		'nothing matching',
	);
	t.equal(requests.filter((r) => r.path === '/app').length, 1, 'never looking up the bot when nothing matches');
});

test('runMerge: what failed is listed below the table only for a public repository', async (t) => {
	nock.disableNetConnect();
	/** @type {Recorded[]} */
	const requests = [];
	const teardowns = [
		mockGitHub({}, (r) => requests.push(r)),
		mockMerge(
			{
				openPulls: Object.fromEntries(['ljharb/a', 'ljharb/secret'].map((repository) => [repository, [pr(repository, 1, fixBranch)]])),
				ci: { 'a-1': failing, 'secret-1': failing },
			},
			(r) => requests.push(r),
		),
	];
	t.teardown(() => {
		teardowns.forEach((teardown) => teardown());
		nock.enableNetConnect();
	});

	const result = await runMerge(
		{
			auth: appAuth('1', privateKey()),
			dryRun: true,
			commentId: 77,
			issueNumber: 9,
			async finishOther() { t.fail('finishes no other command'); },
			progress: { queued: false },
		},
		[
			repoState({ name: 'a', repository: 'ljharb/a' }),
			repoState({
				name: 'secret',
				repository: 'ljharb/secret',
				private: true,
			}),
		],
		{ repositories: new Set(), accounts: new Set(['ljharb']) },
	);

	t.deepEqual(
		result,
		{
			rows: ['| `ljharb/a` | would not merge https://github.com/ljharb/a/pull/1: its checks failed (see below) |'],
			details: [expectedDetails('ljharb/a', 1, 'failed', [['tests', 'failure']])],
			ok: true,
		},
		'the public one’s row says its checks failed, and what failed is listed below it',
	);
	t.ok(requests.some((r) => r.path.startsWith('/repos/ljharb/secret/commits/secret-1/check-runs')), 'the private one’s CI is read');
	t.notOk(JSON.stringify(result).includes('secret'), 'but the private one, whose checks failed too, is never mentioned, nor what failed on it');
});
