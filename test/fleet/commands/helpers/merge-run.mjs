import { writeFileSync } from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

import { unmarked } from '../../../../fleet/commands/replies.mjs';
import { marker } from '../../../../fleet/drift/marker.mjs';
import { runChild } from '../../drift/helpers/child.mjs';
import { standardWorkflows } from '../../drift/helpers/states.mjs';
import { gitIsolation, tempDir } from '../../lib/helpers/git.mjs';
import { privateKey } from '../../lib/helpers/github.mjs';

/** @import { Scenario as GitHubScenario, RepoSpec, Recorded } from '../../lib/helpers/github.mjs' */
/** @import { Scenario, CommandsScenario } from './preload.mjs' */
/** @import { MergeScenario } from './merge.mjs' */
/** @import { ChildResult } from '../../drift/helpers/child.mjs' */
/** @import { Test } from 'tape' */

const preload = pathToFileURL(path.join(import.meta.dirname, 'preload.mjs')).href;

export const bot = 'fleet-bot[bot]';
export const runURL = 'https://github.com/ljharb/actions/actions/runs/42';
// the token the App's bot reacts and replies with, from its installation on the repository the comment is in, which also holds the queue
export const issueToken = 'token ghs_installation_99';

export const report = {
	number: 9,
	body: `${marker}\nthe report`,
	user: { login: 'github-actions[bot]' },
};

/** @type {(body: string, id?: number) => Record<string, unknown>} */
export function comment(body, id = 77) {
	return {
		id,
		body,
		user: { login: 'maintainer' },
		html_url: `https://github.com/ljharb/actions/issues/9#issuecomment-${id}`, // eslint-disable-line camelcase
	};
}

/** @type {(options?: { isPrivate?: boolean, archived?: boolean }) => RepoSpec} */
export function repo({ isPrivate = false, archived = false } = {}) {
	return {
		data: {
			isArchived: archived,
			isPrivate,
			defaultBranchRef: { name: 'main' },
			workflows: { entries: standardWorkflows().map(({ name, text }) => ({ name, type: 'blob', object: { text } })) },
		},
	};
}

/**
 * An open PR in `repository`, by the App's bot (unless `user` says otherwise), from `branch` in the repository itself (unless `headRepo` says otherwise), into `main`.
 * @type {(repository: string, number: number, branch: string, options?: { sha?: string, user?: string, headRepo?: string }) => Record<string, any>}
 */
export function pr(repository, number, branch, { sha = `${repository.split('/')[1]}-${number}`, user = bot, headRepo = repository } = {}) {
	return {
		number,
		state: 'open',
		merged_at: null, // eslint-disable-line camelcase
		head: { ref: branch, sha, repo: { full_name: headRepo, owner: { login: headRepo.split('/')[0] } } }, // eslint-disable-line camelcase
		base: { ref: 'main', repo: { full_name: repository, private: false } }, // eslint-disable-line camelcase
		user: { login: user },
	};
}

/** @type {(name: string, conclusion?: string | null, status?: string) => Record<string, unknown>} */
export function checkRun(name, conclusion = 'success', status = 'completed') {
	return {
		id: 1,
		name,
		status,
		conclusion,
		url: `https://api.github.com/check-runs/${name}`,
		app: { slug: 'other-ci' },
	};
}

export const passing = { checkRuns: [checkRun('tests')] };
export const pending = { checkRuns: [checkRun('tests', null, 'in_progress')] };
export const failing = { checkRuns: [checkRun('tests', 'failure')] };

/**
 * Runs `script` (relative to the repository's root) in a child process, as the workflow would, against the mocked API.
 * @type {(t: Test, script: string, options: {
 *   event?: unknown,
 *   github?: GitHubScenario,
 *   commands?: CommandsScenario,
 *   merge?: MergeScenario,
 *   env?: Record<string, string>,
 *   throwStringOnSplit?: string,
 * }) => ChildResult}
 */
export function runScript(
	t,
	script,
	{
		event = {},
		github = {},
		commands = { permissions: { maintainer: 'write' } },
		merge = {},
		env = {},
		throwStringOnSplit,
	},
) {
	const eventPath = path.join(tempDir(t, 'fleet-merge-event'), 'event.json');
	writeFileSync(eventPath, JSON.stringify(event));
	/** @type {Scenario} */
	const scenario = {
		github,
		commands,
		merge,
		...throwStringOnSplit ? { throwStringOnSplit } : {},
	};
	return runChild([script], {
		scenario,
		preload,
		env: {
			...gitIsolation,
			'INPUT_APP-ID': '1234',
			'INPUT_PRIVATE-KEY': privateKey(),
			INPUT_ACCOUNTS: 'ljharb',
			GITHUB_EVENT_PATH: eventPath,
			GITHUB_REPOSITORY: 'ljharb/actions',
			GITHUB_RUN_ID: '42',
			...env,
		},
	});
}

/** @type {(requests: Recorded[], method: string, pattern: RegExp) => Recorded[]} */
export function matching(requests, method, pattern) {
	return requests.filter((r) => r.method === method && pattern.test(r.path));
}

/**
 * The replies on issue `issue`, as they're shown: without the hidden marker each part of a command's reply starts with.
 * @type {(requests: Recorded[], issue?: number) => string[]}
 */
export function replies(requests, issue = 9) {
	return matching(requests, 'POST', new RegExp(`^/repos/ljharb/actions/issues/${issue}/comments$`)).map((r) => unmarked(r.body.body));
}

/** @type {(requests: Recorded[], id?: number) => string[]} */
export function reactions(requests, id = 77) {
	return [
		...matching(requests, 'POST', new RegExp(`^/repos/ljharb/actions/issues/comments/${id}/reactions$`)).map((r) => `+${r.body.content}`),
		...matching(requests, 'DELETE', new RegExp(`^/repos/ljharb/actions/issues/comments/${id}/reactions/\\d+$`)).map((r) => `-${r.path.split('/').pop()}`),
	];
}

/**
 * The merge queue as last written, without each entry's `queuedAt`, which is checked to be a time; `undefined` if it never was.
 * @type {(requests: Recorded[]) => Record<string, unknown>[] | undefined}
 */
export function writtenQueue(requests) {
	const writes = requests.filter((r) => (r.method === 'PATCH' && (/^\/repos\/ljharb\/actions\/actions\/variables\/FLEET_MERGE_QUEUE$/).test(r.path)) || (r.method === 'POST' && r.path === '/repos/ljharb/actions/actions/variables'));
	const last = writes.at(-1);
	if (!last) {
		return void undefined;
	}
	/** @type {Record<string, unknown>[]} */
	const entries = JSON.parse(last.body.value);
	return entries.map(({ queuedAt, ...rest }) => {
		if (typeof queuedAt !== 'string' || Number.isNaN(Date.parse(queuedAt))) {
			throw new TypeError(`not a time: ${queuedAt}`);
		}
		return rest;
	});
}

/**
 * A queue entry, as written: `queuedAt` is left out, as `writtenQueue` leaves it out.
 * @type {(repository: string, number: number, options?: { headSha?: string, base?: string, commentId?: number, isPrivate?: boolean, commandFailed?: boolean }) => Record<string, unknown>}
 */
export function entry(
	repository,
	number,
	{
		headSha = `${repository.split('/')[1]}-${number}`,
		base = 'main',
		commentId = 77,
		isPrivate = false,
		commandFailed,
	} = {},
) {
	return {
		repository,
		number,
		headSha,
		base,
		commentId,
		issueNumber: 9,
		private: isPrivate,
		...commandFailed ? { commandFailed } : {},
	};
}

/** @type {(dryRun: boolean) => string} */
export function privateNote(dryRun) {
	return `Private repositories matching these filters, if any, ${dryRun ? 'would also be' : 'were also'} processed; nothing about them is shown here.`;
}

/**
 * What a reply lists below its table about one PR, collapsed: each of `jobs` (a name, then its messages), in a block fenced with three backticks.
 * @type {(repository: string, number: number, what: 'failed' | 'optional', jobs: [string, ...string[]][]) => string}
 */
export function expectedDetails(repository, number, what, jobs) {
	return /** @type {string[]} */ ([]).concat(
		`<details><summary><code>${repository}</code> <a href="https://github.com/${repository}/pull/${number}">#${number}</a>: ${what === 'failed' ? 'the checks that failed' : 'optional jobs that failed, which don’t block merging'}</summary>`,
		'',
		'```',
		jobs.flatMap(([name, ...messages]) => [name].concat(messages.map((message) => `  ${message}`))),
		'```',
		'',
		'</details>',
	).join('\n');
}

/** @type {(line: string, rows: string[], dryRun: boolean, details?: string[]) => string} */
export function expectedReply(line, rows, dryRun, details = []) {
	return /** @type {string[]} */ ([]).concat(
		`\`${line}\` (${dryRun ? 'a dry run, so nothing was changed or queued' : 'from each repository’s `fleet/workflows` and `actions-lock/relock` PRs by the App’s bot'}; see [the run](${runURL})):`,
		'',
		rows.length > 0 ? ['| Repository | Outcome |', '| --- | --- |'].concat(rows) : 'No repository matches those filters.',
		details.flatMap((text) => ['', text]),
		'',
		privateNote(dryRun),
	).join('\n');
}
