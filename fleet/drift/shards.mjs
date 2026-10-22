import semver from 'semver';

import { allVersions, getPreset } from '../../node/matrix/versions.mjs';

/** @typedef {import('../../node/matrix/versions.mjs').Type} Type */

const maxJobs = 256; // GitHub's limit for a single job's matrix

const decades = [
	'aught',
	'tens',
	'twenties',
	'thirties',
	'forties',
	'fifties',
	'sixties',
	'seventies',
	'eighties',
	'nineties',
];

/** @type {(decade: number) => string} */
function shardName(decade) {
	return `node-${decades[decade] ?? `${decade}0s`}.yml`;
}

const shardPattern = new RegExp(`^node(?:-(?:${decades.join('|')}|\\d+0s))?\\.yml$`);

/** @type {(name: string) => boolean} */
export function isShard(name) {
	return shardPattern.test(name);
}

/** @type {(comparators: readonly semver.Comparator[]) => string} */
function comparatorSet(comparators) {
	return comparators.map((c) => c.value).join(' ').trim();
}

// semver has no range intersection, but distributing the `||`s of both is one
/** @type {(a: string, b: string) => string} */
function intersect(a, b) {
	const right = new semver.Range(b).set;
	return new semver.Range(a).set.flatMap((x) => right.map((y) => comparatorSet([...x, ...y]))).join(' || ');
}

/** @type {(from: number) => string} */
function decadeRange(from) {
	return from > 0 ? `>= ${from * 10}` : '*';
}

/** @type {(range: string, type: Type) => Promise<number>} */
async function jobs(range, type) {
	const { requireds, optionals } = await getPreset(range, type, false);
	return Math.max(requireds.length, optionals.length);
}

/** @type {Map<string, Promise<string[]>>} */
const cache = new Map();

// node tests are split into one workflow file per decade of majors only to keep each job matrix within GitHub's limit, so they're split only when one `node.yml` would exceed it, and then only until the rest fits in one open-ended file
/** @type {(engines: string, type: Type) => Promise<string[]>} */
async function pack(engines, type) {
	const versions = (await allVersions()).filter((v) => semver.satisfies(v, engines));
	if (versions.length === 0) {
		return [];
	}
	if (await jobs(engines, type) <= maxJobs) {
		return ['node.yml'];
	}
	const used = [...new Set(versions.map((v) => Math.floor(semver.major(v) / 10)))].sort((a, b) => a - b);
	let last = 0;
	while (last < used.length - 1 && await jobs(intersect(decadeRange(used[last]), engines), type) > maxJobs) { // eslint-disable-line no-await-in-loop
		last += 1;
	}
	return used.slice(0, last + 1).map(shardName);
}

/** @type {(engines: string, type: Type) => Promise<string[]>} */
export function expectedShards(engines, type) {
	const key = `${type}\n${engines}`;
	let shards = cache.get(key);
	if (!shards) {
		shards = pack(engines, type);
		cache.set(key, shards);
	}
	return shards;
}
