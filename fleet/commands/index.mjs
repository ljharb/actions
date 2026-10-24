import { readFileSync } from 'fs';

import * as core from '@actions/core';
import { getOctokit } from '@actions/github';

import { checkSafely } from '../drift/check.mjs';
import { marker } from '../drift/marker.mjs';
import {
	appAuth,
	discover,
	isSkippedAccount,
	parseAccounts,
} from '../lib/app.mjs';
import { code } from '../lib/markdown.mjs';
import { branch, fixRepo } from './apply.mjs';
import { legend, parseCommand, quote } from './syntax.mjs';

/** @typedef {import('../lib/app.mjs').RepoState} RepoState */
/** @typedef {import('../drift/check.mjs').Result} Result */
/** @typedef {import('../drift/fix.mjs').Category} Category */
/** @typedef {import('./syntax.mjs').Filters} Filters */
/** @typedef {import('./apply.mjs').Candidate} Candidate */
/** @typedef {import('./apply.mjs').Context} Context */

const maxBodyLength = 60000; // GitHub's limit is 65536 characters

const {
	GITHUB_SERVER_URL = 'https://github.com',
	GITHUB_REPOSITORY = '',
	GITHUB_RUN_ID,
	GITHUB_EVENT_PATH = '',
} = process.env;
const runURL = `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;

/**
 * Which of a repository's discrepancies the filters keep, as the file names to pass to `planFixes` (`undefined` limits nothing, and an empty set means none matched); `null` when the repository isn't kept at all.
 * A repository with no matching discrepancies is only kept when it's named, so that `/fix owner/name` always says what happened to it.
 * A private repository is kept exactly like a public one; what's output about it is limited elsewhere.
 * @type {(state: RepoState, result: Result | null, filters: Filters) => Set<string> | undefined | null}
 */
function select(state, result, {
	repositories, accounts, files, categories,
}) {
	if (
		(repositories.size > 0 && !repositories.has(state.repository.toLowerCase()))
		|| (accounts.size > 0 && !accounts.has(state.owner.toLowerCase()))
	) {
		return null;
	}
	if (files.size === 0 && categories.size === 0) {
		return result || repositories.size > 0 ? undefined : null;
	}
	/** @type {{ name: string, category: Category }[]} */
	const entries = [
		...(result?.missing ?? []).map((name) => ({ name, category: /** @type {const} */ ('missing') })), // eslint-disable-line no-extra-parens
		...(result?.unexpected ?? []).map((name) => ({ name, category: /** @type {const} */ ('unexpected') })), // eslint-disable-line no-extra-parens
		...(result?.drifted ?? []).map(({ name }) => ({ name, category: /** @type {const} */ ('drifted') })), // eslint-disable-line no-extra-parens
	];
	// file names are case-sensitive, but the filters aren't
	const names = entries
		.filter(({ name, category }) => (files.size === 0 || files.has(name.toLowerCase())) && (categories.size === 0 || categories.has(category)))
		.map(({ name }) => name);
	return names.length > 0 || repositories.size > 0 ? new Set(names) : null;
}

/** @type {(context: Context, candidate: Candidate) => Promise<{ outcome: string, failed: boolean }>} */
async function attempt(context, candidate) {
	try {
		return { outcome: await fixRepo(context, candidate), failed: false };
	} catch (error) {
		/*
		 * a private repository's error can quote its files, branches, or git output, and the run's log is as public as the reply;
		 * even counting it, or failing the run over it, would confirm that a private repository matched, so it's only seen in that repository (eg, in its PR)
		 */
		if (candidate.state.private) {
			return { outcome: '', failed: false };
		}
		const text = error instanceof Error ? error.message : String(error);
		core.warning(`${candidate.state.repository}: ${text}`);
		return { outcome: `failed: ${code(text)}`, failed: true };
	}
}

/** @type {(n: number, one: string, many: string) => string} */
function plural(n, one, many) {
	return n === 1 ? one : many;
}

/**
 * The same whether or not any private repository exists or matched, so that it says nothing about them.
 * @type {(dryRun: boolean) => string}
 */
function privateNote(dryRun) {
	return `Private repositories matching these filters, if any, ${dryRun ? 'would also be' : 'were also'} processed; nothing about them is shown here.`;
}

/**
 * @type {(options: {
 *   line: string,
 *   dryRun: boolean,
 *   rows: string[],
 *   failures: number,
 * }) => (shown: number, where: string) => string}
 */
function replyBody({
	line, dryRun, rows, failures,
}) {
	const intro = `${quote(line)} (${dryRun ? 'a dry run, so nothing was changed' : `from each repository’s \`${branch}\` branch`}; see [the run](${runURL})):`;
	return (shown, where) => [
		intro,
		'',
		...rows.length > 0 ? [
			'| Repository | Outcome |',
			'| --- | --- |',
			...rows.slice(0, shown),
		] : ['No repository matches those filters.'],
		...shown < rows.length ? ['', `_…${rows.length - shown} more repositories ${where}._`] : [],
		...failures > 0 ? ['', `⚠️ Some repositories could not be read, so they were not considered; see [the run](${runURL}).`] : [],
		'',
		privateNote(dryRun),
	].join('\n');
}

/** @type {(context: Context, filters: Filters, line: string) => Promise<{ body: string, full: string, failed: number }>} */
async function run(context, filters, line) {
	const accounts = parseAccounts(core.getInput('accounts'), process.env.GITHUB_REPOSITORY_OWNER || '');
	// without source accounts, only repositories the App is installed on are discovered: it can't change any other
	const { states, failures } = await discover(context.auth, accounts);
	for (const { scope, message } of failures) {
		core.warning(`${scope}: ${message}`);
	}
	// an installation on an account that isn't allowed is left out on purpose, so it's only in the log
	const unread = failures.filter((f) => !isSkippedAccount(f)).length;

	const checked = states.filter((s) => s.stateError || (!s.archived && s.config.workflows !== false));
	/** @type {Candidate[]} */
	const candidates = (await Promise.all(checked.map(async (state) => {
		const result = await checkSafely(state);
		const files = select(state, result, filters);
		return files === null ? [] : [
			{
				state, result, files,
			},
		];
	}))).flat();

	/** @type {string[]} */
	const rows = [];
	let failed = 0;
	// one at a time, to stay clear of secondary rate limits; private repositories last, so that where one falls among the public ones' log lines, or how long one takes, says nothing about it
	for (const candidate of [...candidates.filter((c) => !c.state.private), ...candidates.filter((c) => c.state.private)]) {
		const { outcome, failed: didFail } = await attempt(context, candidate); // eslint-disable-line no-await-in-loop
		failed += Number(didFail);
		if (!candidate.state.private) {
			rows.push(`| ${code(candidate.state.repository)} | ${outcome} |`);
		}
	}

	const render = replyBody({
		line, dryRun: context.dryRun, rows, failures: unread,
	});
	const where = `omitted for length; see [the run summary](${runURL})`;
	// whole rows only, from the end
	let shown = rows.length;
	while (shown > 0 && render(shown, where).length > maxBodyLength) {
		shown -= 1;
	}
	return {
		body: render(shown, where),
		full: render(rows.length, where),
		failed,
	};
}

async function main() {
	const { issue, comment } = JSON.parse(readFileSync(GITHUB_EVENT_PATH, 'utf8'));
	const author = core.getInput('issue-author', { required: true });
	if (issue?.pull_request || !issue?.body?.includes(marker) || issue.user?.login !== author) {
		core.info('not a comment on the workflow drift report; nothing to do');
		return;
	}
	const command = parseCommand(String(comment.body));
	if (command.type === 'none') {
		core.info('not a command; nothing to do');
		return;
	}

	const [owner, repo] = GITHUB_REPOSITORY.split('/');
	const octokit = getOctokit(core.getInput('token', { required: true }));
	/** @type {(body: string) => Promise<unknown>} */
	const reply = (body) => octokit.rest.issues.createComment({
		owner, repo, issue_number: issue.number, body, // eslint-disable-line camelcase
	});

	// `author_association` says nothing about permissions on this repository, so ask
	const { data: { permission } } = await octokit.rest.repos.getCollaboratorPermissionLevel({
		owner, repo, username: comment.user.login,
	});
	if (permission !== 'admin' && permission !== 'write') {
		await reply('Only people with write access to this repository can run fleet commands, so nothing was done.');
		core.info(`the commenter’s permission is \`${permission}\`; nothing done`);
		return;
	}
	await octokit.rest.reactions.createForIssueComment({
		owner, repo, comment_id: comment.id, content: 'eyes', // eslint-disable-line camelcase
	});
	if (command.type === 'error') {
		await reply(`${command.message} Nothing was done.\n\n${legend()}`);
		core.info('not a valid command; replied with how to use them');
		return;
	}

	const {
		body, full, failed,
	} = await run({
		auth: appAuth(core.getInput('app-id', { required: true }), core.getInput('private-key', { required: true })),
		identities: new Map(),
		dryRun: command.dryRun,
		categories: command.filters.categories,
		link: comment.html_url,
	}, command.filters, command.line);
	// written first, so a failure to reply still leaves the outcome in the run
	await core.summary.addRaw(full).write();
	await reply(body);
	if (failed > 0) {
		core.setFailed(`${failed} ${plural(failed, 'repository', 'repositories')} could not be fixed`);
	}
}

main().catch((error) => {
	core.setFailed(error instanceof Error ? error : String(error));
});
