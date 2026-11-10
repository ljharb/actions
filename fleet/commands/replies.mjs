import { createHash } from 'crypto';

import * as core from '@actions/core';

import { failureDetails } from '../lib/app.mjs';
import { hideable, minimizeEach } from '../lib/said.mjs';
import { parseCommand } from './syntax.mjs';

/** @import { Octokit } from '../lib/app.mjs' */
/** @import { Invocation, Verb } from './syntax.mjs' */
/** @typedef {Invocation & { type: Verb }} Run */
/**
 * Which command a reply is to, as its parser understands it: its verb, whether it's a dry run, and a digest of its filters (see `identify`).
 * @typedef {{ verb: Verb, dryRun: boolean, digest: string }} Identity
 */
/** @typedef {{ id: number, node_id?: string, body?: string | null, user?: { login?: string } | null }} IssueComment */

const markerPattern = /^<!-- fleet:reply:(?:(?<dryRun>dry-run):)?(?<verb>fix|merge):(?<digest>[0-9a-f]{64}) -->\n/;

/**
 * Which command `command` is: its filters (each already lowercased) are sorted, so that the same filters, in any order or case, are the same command; and digested, so that a marker is short however many filters there are, and never names one.
 * @type {(command: Run) => Identity}
 */
export function identify({
	type,
	dryRun,
	filters,
}) {
	const tokens = /** @type {string[]} */ ([]).concat(
		Array.from(filters.repositories),
		Array.from(filters.accounts),
		Array.from(filters.files),
		Array.from(filters.categories),
	).sort();
	return {
		verb: type,
		dryRun,
		digest: createHash('sha256').update(tokens.join(' ')).digest('hex'),
	};
}

/**
 * The marker hidden at the start of each part of a reply to `command`, so that a later reply to the same command can find every part of it.
 * @type {(command: Run) => string}
 */
export function replyMarker(command) {
	const {
		verb,
		dryRun,
		digest,
	} = identify(command);
	return `<!-- fleet:reply:${dryRun ? 'dry-run:' : ''}${verb}:${digest} -->`;
}

/**
 * A reply's part without its marker, if it has one: as it's shown in the run summary, where nothing needs to find it.
 * @type {(body: string) => string}
 */
export function unmarked(body) {
	return body.replace(markerPattern, '');
}

/**
 * Which command a part of one of the App's replies is a reply to, if it's one: by its marker (see `replyMarker`), or, for a reply from before replies had one, by the command it quotes at the start of its first part.
 * An unmarked reply's later parts (`_continued (2/3)_`) quote nothing, so they're found in `earlierReplies`.
 * @type {(body: string) => Identity & { marked: boolean } | null}
 */
export function repliedTo(body) {
	const marked = markerPattern.exec(body)?.groups;
	if (marked) {
		return {
			verb: /** @type {Verb} */ (marked.verb),
			dryRun: !!marked.dryRun,
			digest: marked.digest,
			marked: true,
		};
	}
	// a quoted command is never padded, and has no backticks or pipes to escape, since none is valid in one
	const quoted = (/^`(?<line>\/[^`\n]+)` \((?:a dry run, |from each repository’s )/).exec(body)?.groups;
	const command = quoted ? parseCommand(quoted.line) : null;
	return command?.type === 'fix' || command?.type === 'merge' ? { ...identify(command), marked: false } : null;
}

/**
 * Whether a reply to `later` makes an earlier reply to `earlier` outdated: they're the same command (by verb and filters), and the earlier one was a dry run, or the later one wasn't (what a real run did stays shown until another real run).
 * @type {(later: Identity, earlier: Identity) => boolean}
 */
export function supersedes(later, earlier) {
	return later.verb === earlier.verb
		&& later.digest === earlier.digest
		&& (earlier.dryRun || !later.dryRun);
}

/**
 * The node IDs of the parts of `author`'s replies, among `comments` (in the order they were posted), that a reply to `command` makes outdated (see `supersedes`).
 * An unmarked reply's later parts are those of `author`'s comments right after its first part (with none of `author`'s in between) that say which part they are, in order.
 * @type {(comments: IssueComment[], author: string, command: Run) => string[]}
 */
export function earlierReplies(comments, author, command) {
	const later = identify(command);
	/** @type {{ outdated: boolean, next: number, total: number } | null} */
	let pending = null;
	/** @type {string[]} */
	const ids = [];
	comments.filter((c) => c.user?.login?.toLowerCase() === author.toLowerCase()).forEach((c) => {
		const body = c.body ?? '';
		const continued = (/^_continued \((?<part>\d+)\/(?<total>\d+)\)_\n/).exec(body)?.groups;
		/** @type {boolean} */
		let outdated;
		if (pending && continued && Number(continued.part) === pending.next && Number(continued.total) === pending.total) {
			({ outdated } = pending);
			pending = pending.next < pending.total ? { ...pending, next: pending.next + 1 } : null;
		} else {
			const earlier = repliedTo(body);
			outdated = !!earlier && supersedes(later, earlier);
			const more = earlier && !earlier.marked && (/\n_continued below \(2\/(?<total>\d+)\)_$/).exec(body)?.groups;
			pending = more ? {
				outdated,
				next: 2,
				total: Number(more.total),
			} : null;
		}
		if (outdated && c.node_id) {
			ids.push(c.node_id);
		}
	});
	return ids;
}

/**
 * Once the App's bot has replied to `command` on issue `number`, in the comments `ours` (as GitHub created them, which says who the bot is), hides its earlier replies to the same command that this reply makes outdated (see `supersedes`), as `OUTDATED`; every part of each.
 * Only comments posted before this reply are looked at, so that a later one's reply (eg, a run that finished sooner) is never hidden; and nobody else's comments, nor those already hidden (or since deleted), are touched.
 * Returns how many it hid. Hiding is never worth failing the command over, so a failure only warns, without saying which command (that could name a private repository).
 * @type {(options: { octokit: Octokit, owner: string, repo: string, number: number, command: Run, ours: { id: number, author?: string }[] }) => Promise<number>}
 */
export async function hideEarlierReplies({
	octokit,
	owner,
	repo,
	number,
	command,
	ours,
}) {
	const author = ours[0]?.author;
	if (!author) {
		return 0;
	}
	const own = new Set(ours.map((c) => c.id));
	/** @type {(what: string, error: unknown) => void} */
	const warn = (what, error) => {
		const details = failureDetails(error);
		core.warning(`${what}${details.length > 0 ? ` (${details.join(', ')})` : ''}`);
	};
	/** @type {string[]} */
	let ids;
	try {
		const comments = await octokit.paginate(octokit.rest.issues.listComments, {
			owner,
			repo,
			issue_number: number, // eslint-disable-line camelcase
			per_page: 100, // eslint-disable-line camelcase
		});
		const first = comments.findIndex((c) => own.has(c.id));
		const earlier = (first === -1 ? comments : comments.slice(0, first)).filter((c) => !own.has(c.id));
		ids = earlierReplies(earlier, author, command);
		if (ids.length > 0) {
			const left = await hideable(octokit, ids);
			ids = ids.filter((id) => left.has(id));
		}
	} catch (error) {
		warn('could not read the App’s earlier replies to this command, to hide them as outdated', error);
		return 0;
	}
	const failures = await minimizeEach(octokit, ids.map((id) => ({
		id,
		classifier: /** @type {const} */ ('OUTDATED'),
	})));
	if (failures.length > 0) {
		warn(`could not hide ${failures.length} of the App’s earlier replies to this command as outdated`, failures[0]);
	}
	const hidden = ids.length - failures.length;
	if (hidden > 0) {
		core.info(`hid ${hidden} of the App’s earlier replies to this command as outdated`);
	}
	return hidden;
}
