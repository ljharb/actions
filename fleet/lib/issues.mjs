import * as core from '@actions/core';
import { getOctokit } from '@actions/github';

import { appOctokit, installationToken } from './app.mjs';

/** @typedef {import('./app.mjs').Octokit} Octokit */
/** @typedef {ReturnType<typeof import('./app.mjs').appAuth>} Auth */

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
