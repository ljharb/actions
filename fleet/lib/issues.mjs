import * as core from '@actions/core';
import { getOctokit } from '@actions/github';

import { appOctokit, installationToken } from './app.mjs';

/** @import { Octokit, appAuth } from './app.mjs' */
/** @typedef {ReturnType<typeof appAuth>} Auth */

// the report issue was first opened as GitHub Actions' bot; GitHub can't change an issue's author, so the App's bot adopts it
export const legacyAuthor = 'github-actions[bot]';

/** @type {(error: unknown) => string} */
function status(error) {
	return error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' ? ` (HTTP ${error.status})` : '';
}

/**
 * An Octokit that acts as the App's bot, with a token for only `owner/repo`, that can only read and write its issues (and read its metadata).
 * @type {(auth: Auth, owner: string, repo: string) => Promise<Octokit>}
 */
export async function issueOctokit(auth, owner, repo) {
	/** @type {string} */
	let token;
	try {
		const { data: installation } = await (await appOctokit(auth)).rest.apps.getRepoInstallation({ owner, repo });
		token = await installationToken(auth, installation.id, {
			repositoryNames: [repo],
			permissions: { issues: 'write', metadata: 'read' },
		});
	} catch (error) {
		throw new Error(`the fleet GitHub App could not get a token to write issues in \`${owner}/${repo}\`${status(error)}: the App needs the “Issues: Read and write” repository permission, and must be installed on \`${owner}/${repo}\`. After that permission is added to the App, its installation on \`${owner}\` must approve it (from the account’s settings, under “Applications”, or from GitHub’s email about it) before the App can use it.`);
	}
	core.setSecret(token);
	return getOctokit(token);
}

/**
 * Whether `login` is an author the report issue may have: the App's bot, or, for an issue it adopted, GitHub Actions' bot.
 * @type {(login: unknown, bot: string) => boolean}
 */
export function isReportAuthor(login, bot) {
	return typeof login === 'string' && [bot, legacyAuthor].some((author) => author.toLowerCase() === login.toLowerCase());
}

/**
 * Keeps a report's issue in `owner/repo` up to date, as the App's bot (`bot`): the newest issue, open or closed, whose body has `marker`, opened by the App's bot or (for one it adopted) GitHub Actions' bot (see `isReportAuthor`); an issue anyone else opens is never written to.
 * With `found`, it's updated to that title and body, and reopened, or created when there's none; without, an open one is closed, with a comment saying `closing`, and otherwise nothing changes (which is `unchanged`).
 * @type {(options: {
 *   octokit: Octokit,
 *   owner: string,
 *   repo: string,
 *   bot: string,
 *   marker: string,
 *   closing: string,
 *   unchanged: string,
 *   found: { title: string, body: string } | null,
 * }) => Promise<string>}
 */
export async function upsertReportIssue({
	octokit,
	owner,
	repo,
	bot,
	marker,
	closing,
	unchanged,
	found,
}) {
	// the App's bot's own, or one opened as GitHub Actions' bot before the App wrote the report, which it adopts
	const issues = (await Promise.all([bot, legacyAuthor].map((creator) => octokit.paginate(octokit.rest.issues.listForRepo, {
		owner,
		repo,
		state: 'all',
		creator,
		per_page: 100, // eslint-disable-line camelcase
	})))).flat();
	const [issue] = issues
		.filter((i) => !i.pull_request && i.body?.includes(marker) && isReportAuthor(i.user?.login, bot))
		.sort((a, b) => b.created_at.localeCompare(a.created_at));

	if (!found) {
		if (issue?.state === 'open') {
			await octokit.rest.issues.createComment({
				owner,
				repo,
				issue_number: issue.number, // eslint-disable-line camelcase
				body: closing,
			});
			await octokit.rest.issues.update({
				owner,
				repo,
				issue_number: issue.number, // eslint-disable-line camelcase
				state: 'closed',
			});
			return `closed ${issue.html_url}`;
		}
		return unchanged;
	}
	if (issue) {
		await octokit.rest.issues.update({
			owner,
			repo,
			issue_number: issue.number, // eslint-disable-line camelcase
			title: found.title,
			body: found.body,
			state: 'open',
		});
		return `updated ${issue.html_url}`;
	}
	const { data: created } = await octokit.rest.issues.create({
		owner,
		repo,
		title: found.title,
		body: found.body,
	});
	return `created ${created.html_url}`;
}
