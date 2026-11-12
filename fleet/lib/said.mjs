import * as core from '@actions/core';

import { failureDetails } from './app.mjs';

/** @import { Octokit } from './app.mjs' */

/**
 * What the App says on one of its PRs, in a comment it makes once for each head commit (and, for the kinds about the PR's base too, once for each of its base's tips):
 * - `foreign`: it has commits by someone else, so the App never touches it
 * - `conflict`: it conflicts with its base, so it can't be rebased
 * - `empty`: its base already has everything it changes
 * - `stuck`: its CI failed (not only in ways `continue-on-error` hides, which never make it stuck), and the App has nothing it can restore; once CI passes on that head commit after all (eg, once a flaky job that failed is re-run), it no longer applies, and is hidden as `OUTDATED`, after which it no longer counts as said (see `findMarked`'s `visible`), so if CI fails again on that head, it's decided, and said, again
 * - `matches`: all it would change on its base is the App's bookkeeping (see `onlyBookkeeping`), since its base's workflow files already match, so the App closed it
 * @typedef {'foreign' | 'conflict' | 'empty' | 'stuck' | 'matches'} Said
 */
/** @typedef {{ kind: Said, head: string, base?: string }} Marked */
/** @typedef {'RESOLVED' | 'OUTDATED'} Classifier */
/**
 * What one of the App's PRs is, just after the App updated it: the head commit that update replaced (`null`: none it knows of), its head commit, its base's tip, and which kinds of what it said about the head commit it replaced that update resolves (rather than only replacing what they were about).
 * @typedef {{ previous: string | null, head: string, base: string, resolved: Said[] }} Current
 */
/** @typedef {{ nodes: ({ id: string, isMinimized?: boolean } | null)[] }} Nodes */

// the kinds that are about the PR's base's tip too, and so have it in their marker
const aboutBase = new Set(['conflict', 'empty']);

/**
 * The marker hidden at the start of each comment, so that each is only ever made once for each head commit (and, for `conflict` and `empty`, for each of its base's tips).
 * @type {(kind: Said, head: string, base?: string) => string}
 */
export function marker(kind, head, base) {
	return `<!-- fleet:${kind}:${head}${base ? `:${base}` : ''} -->`;
}

/**
 * What a comment's body, starting with a marker on a line of its own (as `commentOnce` puts it), says it's about; or `null` for anything else, including a marker that doesn't have the base's tip exactly when its kind is about it.
 * @type {(body: string | null | undefined) => Marked | null}
 */
export function parseMarker(body) {
	const groups = (/^<!-- fleet:(?<kind>foreign|conflict|empty|stuck|matches):(?<head>[0-9a-f]+)(?::(?<base>[0-9a-f]+))? -->\n/).exec(body ?? '')?.groups;
	if (!groups || aboutBase.has(groups.kind) !== (typeof groups.base === 'string')) {
		return null;
	}
	const {
		kind,
		head,
		base,
	} = /** @type {Marked} */ (groups);
	return base ? {
		kind,
		head,
		base,
	} : { kind, head };
}

/**
 * Whether what a comment said still applies to the PR as it now is (`null`), and if not, why not: `RESOLVED`, when it was about the head commit the update replaced, and the update resolved what it said; otherwise `OUTDATED`, since it was about a head commit (or a base's tip) that has since been replaced.
 * What's about the PR's current head commit (and, for a kind about its base, its base's current tip) always still applies; what's about an even earlier head commit was replaced before this update, which so resolved nothing about it.
 * @type {(said: Marked, current: Current) => Classifier | null}
 */
export function classify(
	{
		kind,
		head,
		base,
	},
	current,
) {
	if (head === current.head && (!base || base === current.base)) {
		return null;
	}
	return head === current.previous && current.resolved.includes(kind) ? 'RESOLVED' : 'OUTDATED';
}

/**
 * What GitHub found of the nodes it was asked for, when the only errors are that it couldn't find some: it answers each ID it can't find (eg, a comment deleted since it was listed) with a `null` node and a `NOT_FOUND` error, which Octokit throws, along with what it did find. Any other failure is rethrown.
 * @type {(error: unknown) => Nodes}
 */
function foundNodes(error) {
	const { errors, data } = /** @type {{ errors?: { type?: string }[], data?: Nodes }} */ (error);
	if (!data?.nodes || !errors?.every((e) => e?.type === 'NOT_FOUND')) {
		throw error;
	}
	return data;
}

/**
 * Which of the comments with node `ids` are still there, and not already hidden.
 * @type {(octokit: Octokit, ids: string[]) => Promise<Set<string>>}
 */
export async function hideable(octokit, ids) {
	// as many as GitHub looks up at once
	const batches = Array.from({ length: Math.ceil(ids.length / 100) }, (_, i) => ids.slice(i * 100, (i + 1) * 100));
	const found = await Promise.all(batches.map(async (batch) => {
		/** @type {Nodes} */
		const data = await octokit.graphql(
			`query($ids: [ID!]!) {
			nodes(ids: $ids) { id ... on Minimizable { isMinimized } }
		}`,
			{ ids: batch },
		).then((d) => /** @type {Nodes} */ (d), foundNodes);
		return data.nodes.flatMap((n) => (n && !n.isMinimized ? [n.id] : []));
	}));
	return new Set(found.flat());
}

/**
 * Hides (minimizes) each of the comments with node `id`, as its `classifier`; returns the failures, one for each comment that couldn't be hidden.
 * @type {(octokit: Octokit, comments: { id: string, classifier: Classifier }[]) => Promise<unknown[]>}
 */
export async function minimizeEach(octokit, comments) {
	/** @type {unknown[]} */
	const failures = [];
	// one at a time, as GitHub asks of mutations
	await comments.reduce(
		async (previous, { id, classifier }) => {
			await previous;
			try {
				await octokit.graphql(
					`mutation($id: ID!, $classifier: ReportedContentClassifiers!) {
				minimizeComment(input: { subjectId: $id, classifier: $classifier }) { minimizedComment { isMinimized } }
			}`,
					{ id, classifier },
				);
			} catch (error) {
				failures.push(error);
			}
		},
		Promise.resolve(),
	);
	return failures;
}

/**
 * Hides each of `author`'s own comments on PR `number` (recognized by its marker: see `parseMarker`) that `classifierOf` says to, as what it says; anyone else's comments, and any already hidden (or since deleted), are left alone.
 * They're read with `octokit`, and hidden with what `writer` makes (unspecified, `octokit`), which is only made when there's something to hide.
 * Returns how many it hid. Hiding is never worth failing anything over, so a failure only warns (`unread`, when they couldn't be read, and `unhidden`, with how many couldn't be hidden), without saying where; and, for a private repository, not even that, since even a warning would confirm that one has a PR of the App's.
 * @type {(options: {
 *   octokit: Octokit,
 *   writer?: () => Promise<Octokit>,
 *   owner: string,
 *   name: string,
 *   number: number,
 *   author: string,
 *   isPrivate: boolean,
 *   classifierOf: (said: Marked) => Classifier | null,
 *   unread: string,
 *   unhidden: (count: number) => string,
 * }) => Promise<number>}
 */
export async function hideSaid({
	octokit,
	writer = async () => octokit,
	owner,
	name,
	number,
	author,
	isPrivate,
	classifierOf,
	unread,
	unhidden,
}) {
	/** @type {(what: string, error: unknown) => void} */
	const warn = (what, error) => {
		if (!isPrivate) {
			const details = failureDetails(error);
			// never which repository, or which PR
			core.warning(`${what}${details.length > 0 ? ` (${details.join(', ')})` : ''}`);
		}
	};
	/** @type {{ id: string, classifier: Classifier }[]} */
	let stale;
	/** @type {Octokit} */
	let write;
	try {
		const comments = await octokit.paginate(octokit.rest.issues.listComments, {
			owner,
			repo: name,
			issue_number: number, // eslint-disable-line camelcase
			per_page: 100, // eslint-disable-line camelcase
		});
		stale = comments.filter((c) => c.user?.login === author && c.node_id).flatMap((c) => {
			const said = parseMarker(c.body);
			const classifier = said && classifierOf(said);
			return classifier ? [{ id: c.node_id, classifier }] : [];
		});
		if (stale.length === 0) {
			return 0;
		}
		const left = await hideable(octokit, stale.map((s) => s.id));
		stale = stale.filter((s) => left.has(s.id));
		if (stale.length === 0) {
			return 0;
		}
		write = await writer();
	} catch (error) {
		warn(unread, error);
		return 0;
	}
	const failures = await minimizeEach(write, stale);
	if (failures.length > 0) {
		warn(unhidden(failures.length), failures[0]);
	}
	return stale.length - failures.length;
}

/**
 * Hides each of `author`'s own comments on PR `number` that no longer applies to it, as it is just after the App updated it (see `classify`), as `RESOLVED` or `OUTDATED` (see `hideSaid`).
 * @type {(options: { octokit: Octokit, owner: string, name: string, number: number, author: string, current: Current, isPrivate: boolean }) => Promise<number>}
 */
export async function hideStale({
	octokit,
	owner,
	name,
	number,
	author,
	current,
	isPrivate,
}) {
	return hideSaid({
		octokit,
		owner,
		name,
		number,
		author,
		isPrivate,
		classifierOf: (said) => classify(said, current),
		unread: 'could not read the App’s earlier comments on one of its PRs, to hide those that no longer apply',
		unhidden: (count) => `could not hide ${count} of the App’s earlier comments on one of its PRs that no longer apply`,
	});
}
