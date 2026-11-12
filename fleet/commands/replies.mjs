import { createHash } from 'crypto';

import * as core from '@actions/core';

import { failureDetails } from '../lib/app.mjs';
import { hideable, minimizeEach } from '../lib/said.mjs';
import { parseCommand } from './syntax.mjs';

/** @import { Octokit } from '../lib/app.mjs' */
/** @import { Classifier } from '../lib/said.mjs' */
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
 * `author`'s comments, among `comments` (in the order they were posted), each with the parts that carry it on: those of `author`'s comments right after one that ends saying it's continued below (with none of `author`'s in between) that say which part they are, in order.
 * A marked reply's later parts start with its marker (see `replyMarker`), so each is found on its own.
 * @type {(comments: IssueComment[], author: string) => IssueComment[][]}
 */
function replyParts(comments, author) {
	/** @type {IssueComment[][]} */
	const replies = [];
	/** @type {{ next: number, total: number } | null} */
	let pending = null;
	comments.filter((c) => c.user?.login?.toLowerCase() === author.toLowerCase()).forEach((c) => {
		const body = c.body ?? '';
		const continued = (/^_continued \((?<part>\d+)\/(?<total>\d+)\)_\n/).exec(body)?.groups;
		if (pending && continued && Number(continued.part) === pending.next && Number(continued.total) === pending.total) {
			replies[replies.length - 1].push(c);
			pending = pending.next < pending.total ? { ...pending, next: pending.next + 1 } : null;
		} else {
			replies.push([c]);
			const more = (/\n_continued below \(2\/(?<total>\d+)\)_$/).exec(body)?.groups;
			pending = more ? { next: 2, total: Number(more.total) } : null;
		}
	});
	return replies;
}

/** @type {(parts: IssueComment[]) => string[]} */
function nodeIds(parts) {
	return parts.flatMap((c) => (c.node_id ? [c.node_id] : []));
}

/**
 * The node IDs of the parts of `author`'s replies, among `comments` (in the order they were posted), to a command that `matches` (see `replyParts`).
 * @type {(comments: IssueComment[], author: string, matches: (earlier: Identity) => boolean) => string[]}
 */
function repliesMatching(comments, author, matches) {
	return replyParts(comments, author).flatMap((parts) => {
		const earlier = repliedTo(parts[0].body ?? '');
		// a marked reply's every part is marked, so it's never carried on by an unmarked one
		const reply = earlier?.marked ? parts.slice(0, 1) : parts;
		return earlier && matches(earlier) ? nodeIds(reply) : [];
	});
}

/**
 * Which repository (`owner/name`, lowercased) a reply of the merge queue's is only about, as every row of its table, across all its `parts`, names it; or `null`, for any other comment, or one about more than one repository.
 * @type {(parts: IssueComment[]) => string | null}
 */
export function queueReplyAbout(parts) {
	if (!(parts[0].body ?? '').startsWith('The merge queue, as of [this run](')) {
		return null;
	}
	const repositories = new Set(parts.flatMap((c) => Array.from(String(c.body).matchAll(/^\| `(?<repository>[^`|]+)` \|/gm), (m) => /** @type {{ repository: string }} */ (m.groups).repository.toLowerCase())));
	return repositories.size === 1 ? Array.from(repositories)[0] : null;
}

/**
 * The node IDs of the parts of `author`'s replies, among `comments` (in the order they were posted), that a reply to `command` makes outdated (see `supersedes`).
 * @type {(comments: IssueComment[], author: string, command: Run) => string[]}
 */
export function earlierReplies(comments, author, command) {
	const later = identify(command);
	return repliesMatching(comments, author, (earlier) => supersedes(later, earlier));
}

/**
 * Whether `command` is only about `repository` (`owner/name`, lowercased): its filters name only that repository (and, if any, its account), so that whatever else they narrow it by, it selects nothing else.
 * @type {(command: Run, repository: string) => boolean}
 */
export function onlyAbout({ filters: { repositories, accounts } }, repository) {
	return repositories.size === 1
		&& repositories.has(repository)
		&& (accounts.size === 0 || (accounts.size === 1 && accounts.has(repository.split('/')[0])));
}

/**
 * The node IDs of the comments, among `comments` (in the order they were posted), that are only about one of `repositories` (each `owner/name`, lowercased): the commands only about one of them (see `onlyAbout`), by anyone; every part of `author`'s replies to those; and every part of the merge queue's replies (by `author`) only about one of them (see `queueReplyAbout`).
 * @type {(comments: IssueComment[], author: string, repositories: Set<string>) => string[]}
 */
export function aboutOnly(comments, author, repositories) {
	/** @type {Identity[]} */
	const commands = [];
	/** @type {string[]} */
	const ids = [];
	comments.forEach((c) => {
		const command = parseCommand(c.body ?? '');
		if ((command.type === 'fix' || command.type === 'merge') && Array.from(repositories).some((r) => onlyAbout(command, r))) {
			commands.push(identify(command));
			if (c.node_id) {
				ids.push(c.node_id);
			}
		}
	});
	const queued = replyParts(comments, author).flatMap((parts) => {
		const about = queueReplyAbout(parts);
		return about && repositories.has(about) ? nodeIds(parts) : [];
	});
	const hide = new Set(/** @type {string[]} */ ([]).concat(
		ids,
		repliesMatching(comments, author, (earlier) => commands.some((c) => c.verb === earlier.verb
			&& c.dryRun === earlier.dryRun
			&& c.digest === earlier.digest)),
		queued,
	));
	return comments.flatMap((c) => (c.node_id && hide.has(c.node_id) ? [c.node_id] : []));
}

/**
 * Once the App's bot has posted the comments `ours` on issue `number` (as GitHub created them, which says who the bot is), hides those of the comments before them that `pick` picks (by node ID), as `classifier`.
 * Only comments posted before `ours` are looked at, so that a later one's (eg, a reply to a run that finished sooner) is never hidden; nor are those already hidden (or since deleted).
 * Returns how many it hid. Hiding is never worth failing anything over, so a failure only warns (`unread`, when they couldn't be read, and `unhidden`, with how many couldn't be hidden), without saying which comments; `hid` is what's logged, with how many were hidden, when any were.
 * @type {(options: {
 *   octokit: Octokit,
 *   owner: string,
 *   repo: string,
 *   number: number,
 *   ours: { id: number, author?: string }[],
 *   pick: (earlier: IssueComment[], author: string) => string[],
 *   classifier: Classifier,
 *   unread: string,
 *   unhidden: (count: number) => string,
 *   hid: (count: number) => string,
 * }) => Promise<number>}
 */
async function hideBefore({
	octokit,
	owner,
	repo,
	number,
	ours,
	pick,
	classifier,
	unread,
	unhidden,
	hid,
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
		ids = pick(earlier, author);
		if (ids.length > 0) {
			const left = await hideable(octokit, ids);
			ids = ids.filter((id) => left.has(id));
		}
	} catch (error) {
		warn(unread, error);
		return 0;
	}
	const failures = await minimizeEach(octokit, ids.map((id) => ({ id, classifier })));
	if (failures.length > 0) {
		warn(unhidden(failures.length), failures[0]);
	}
	const hidden = ids.length - failures.length;
	if (hidden > 0) {
		core.info(hid(hidden));
	}
	return hidden;
}

/**
 * Once the App's bot has replied to `command` on issue `number`, in the comments `ours`, hides its earlier replies to the same command that this reply makes outdated (see `supersedes`), as `OUTDATED`; every part of each (see `hideBefore`).
 * Nobody else's comments are touched; a failure only warns, without saying which command (that could name a private repository).
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
	return hideBefore({
		octokit,
		owner,
		repo,
		number,
		ours,
		pick: (earlier, author) => earlierReplies(earlier, author, command),
		classifier: 'OUTDATED',
		unread: 'could not read the App’s earlier replies to this command, to hide them as outdated',
		unhidden: (count) => `could not hide ${count} of the App’s earlier replies to this command as outdated`,
		hid: (count) => `hid ${count} of the App’s earlier replies to this command as outdated`,
	});
}

/**
 * Once the App's bot has posted the comments `ours` on issue `number`, saying that it merged the last of its open PRs in each of `repositories` (each `owner/name`, public), hides every comment before them that's only about one of those (see `aboutOnly`), as `RESOLVED`: there's nothing left there to fix or merge.
 * A failure only warns, never naming a repository.
 * @type {(options: { octokit: Octokit, owner: string, repo: string, number: number, repositories: string[], ours: { id: number, author?: string }[] }) => Promise<number>}
 */
export async function hideResolved({
	octokit,
	owner,
	repo,
	number,
	repositories,
	ours,
}) {
	if (repositories.length === 0) {
		return 0;
	}
	const resolved = new Set(repositories.map((r) => r.toLowerCase()));
	return hideBefore({
		octokit,
		owner,
		repo,
		number,
		ours,
		pick: (earlier, author) => aboutOnly(earlier, author, resolved),
		classifier: 'RESOLVED',
		unread: 'could not read the comments on the report, to hide those about a repository whose PRs the App has all merged as resolved',
		unhidden: (count) => `could not hide ${count} of the comments about a repository whose PRs the App has all merged as resolved`,
		hid: (count) => `hid ${count} ${count === 1 ? 'comment' : 'comments'} about a repository whose PRs the App has all merged as resolved`,
	});
}
