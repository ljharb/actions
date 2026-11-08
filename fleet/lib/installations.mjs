import * as core from '@actions/core';

/** @import { Failure, Octokit } from './app.mjs' */
/** @typedef {{ id: number, account?: unknown, permissions?: Record<string, string | undefined> }} Installation */

/** @type {(installation: { account?: unknown }) => string} */
export function accountLogin({ account }) {
	return account && typeof account === 'object' && 'login' in account && typeof account.login === 'string' ? account.login : '';
}

/** @type {Record<string, number>} */
const levels = {
	read: 1,
	write: 2,
	admin: 3,
};

/**
 * The permissions of `wanted` that `installation` hasn't been granted, as `GET /app/installations` lists the ones it has (eg, ones added to the App that its account hasn't approved yet), each as `name: level`; a token asking for any of them is refused, with an HTTP 422. A higher level (eg, `write`) covers a lower one (eg, `read`). An installation listed without its permissions can't be shown to lack any.
 * @type {(installation: Installation, wanted: Record<string, string>) => string[]}
 */
export function missingPermissions({ permissions }, wanted) {
	if (!permissions || typeof permissions !== 'object') {
		return [];
	}
	return Object.entries(wanted)
		.filter(([name, level]) => (levels[String(permissions[name])] ?? 0) < levels[level])
		.map(([name, level]) => `${name}: ${level}`);
}

/**
 * Of `installations`, the ones to go on with (`ready`); the ones waiting on their account to approve permissions of `wanted` that the App was given after they were installed (see `missingPermissions`), which are skipped, rather than failing, each with a notice saying so; and a failure for each one that lacks a permission the App itself doesn't have (as `GET /app` lists them, read only when an installation lacks any), since an installation is only ever granted the App's own, so no approval can help it: only the App's settings can.
 * Only an installation on an allowed account is ever asked about, and an account is a user or an organization, never a repository, so its login is named.
 * @type {<T extends Installation>(app: Octokit, installations: T[], wanted: Record<string, string>) => Promise<{ ready: T[], waiting: T[], failures: Failure[] }>}
 */
export async function awaitingApproval(app, installations, wanted) {
	const lacking = installations.filter((i) => missingPermissions(i, wanted).length > 0);
	if (lacking.length === 0) {
		return {
			ready: installations,
			waiting: [],
			failures: [],
		};
	}
	const { data } = await app.rest.apps.getAuthenticated();
	const unavailable = missingPermissions({ id: 0, permissions: data?.permissions }, wanted);
	/** @type {typeof installations} */
	const waiting = [];
	/** @type {Failure[]} */
	const failures = [];
	lacking.forEach((installation) => {
		const missing = missingPermissions(installation, wanted);
		const lacked = missing.filter((p) => unavailable.includes(p));
		if (lacked.length > 0) {
			failures.push({
				scope: `installation ${installation.id}`,
				message: `the App itself doesn’t have permissions this needs (${lacked.join(', ')}); give them to it in its settings`,
			});
		} else {
			core.notice(`installation ${installation.id} (${accountLogin(installation)}) is waiting on its account to approve the App’s permissions (${missing.join(', ')}), so it’s skipped until then`);
			waiting.push(installation);
		}
	});
	return {
		ready: installations.filter((i) => !lacking.includes(i)),
		waiting,
		failures,
	};
}
