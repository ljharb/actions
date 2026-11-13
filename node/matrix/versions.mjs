import semver from 'semver';
import getJSON from 'get-json';

/** @typedef {`${number}.${number}.${number}`} BareVersion */
/** @typedef {`v${BareVersion}`} Version */
/** @typedef {`${number}.${number}`} BareMajMin */
/** @typedef {`v${BareMajMin}`} MajMin */
/** @typedef {`${number}`} BareMaj */
/** @typedef {`v${BareMaj}`} Maj */
/** @typedef {BareVersion | BareMajMin | BareMaj} nvmVersionishBaseBare */
/** @typedef {Version | MajMin | Maj} nvmVersionishBaseV */
/** @typedef {nvmVersionishBaseV | nvmVersionishBaseBare | `iojs-${nvmVersionishBaseV}`} nvmVersionish */
/** @typedef {'majors' | 'minors'} Type */
/** @typedef {{ requireds: nvmVersionish[], optionals: nvmVersionish[] }} ReqOptMap */
/** @typedef {{ version: Version, date: string, files: string[], npm: BareVersion, v8: `${BareVersion}.${number}`, uv: BareVersion, zlib: string, openssl: string, modules: `${number}`, lts: boolean, security: boolean }} IndexEntry */

/** @type {(type?: 'nodejs' | 'iojs') => Promise<Version[]>} */
async function getNodeVersions(type = 'nodejs') {
	const url = `https://raw.githubusercontent.com/ljharb/actions/${type}/index.json`; // `https://${type}.org/dist/index.json`;

	/** @type {Promise<IndexEntry[]>} */
	const fetched = getJSON(url);
	const index = await fetched.catch(/** @type {(e: Error) => never} */ (e) => {
		console.error(`Error fetching and parsing JSON from \`${url}\``);
		throw e;
	});
	console.log(`all versions of type ${type}`, index.map(({ version }) => version));
	return index.map(({ version }) => version).filter((x) => x !== 'v22.5.0');
}

/** @type {Promise<Version[]> | undefined} */
let allVersionsPromise;

/** @type {() => Promise<Version[]>} */
export function allVersions() {
	allVersionsPromise ??= Promise.all([getNodeVersions(), getNodeVersions('iojs')])
		.then(([x, y]) => semver.sort(x.concat(y)).reverse());
	return allVersionsPromise;
}

/** @type {(v: Version) => BareMajMin} */
function majMin(v) {
	return `${semver.major(v)}.${semver.minor(v)}`;
}

/** @type {(versions: Version[]) => Map<BareMajMin | BareMaj, BareMajMin[]>} */
function getMinorsByMajor(versions) {
	/** @type {ReturnType<typeof getMinorsByMajor>} */
	const minorsByMajor = new Map();
	versions.forEach((v) => {
		const minor = majMin(v);
		/** @type {BareMajMin | BareMaj} */
		const maj = semver.satisfies(v, '< 1') ? minor : `${semver.major(v)}`;
		minorsByMajor.set(maj, Array.from(new Set((minorsByMajor.get(maj) || []).concat(minor))));
	});
	return minorsByMajor;
}

export const presets = ['0.x', 'iojs'];

/** @type {(a: string, b: typeof a) => number} */
function comparator(a, b) {
	// @ts-expect-error coerce can return null, but won't here
	return semver.compare(semver.coerce(b), semver.coerce(a));
}

/** @type {(filter?: nvmVersionish[]) => ReqOptMap} */
function get0xReqs(filter) {
	/** @type {(x: string) => boolean} */
	const filterer = (x) => !filter || filter.some((f) => semver.satisfies(f, x));
	/** @type {BareMajMin[]} */
	const requiredCandidates = [
		'0.12',
		'0.10',
		'0.8',
	];
	/** @type {BareMajMin[]} */
	const optionalCandidates = [
		'0.11',
		'0.9',
		// '0.6',
		// '0.4',
	];
	return {
		requireds: requiredCandidates.filter(filterer),
		optionals: optionalCandidates.filter(filterer),
	};
}

const iojsRange = '^1 || ^2 || ^3';

const bareVersion = /^\d+\.\d+\.\d+$/;

/** @type {(x: string) => x is BareVersion} */
function isBareVersion(x) {
	return bareVersion.test(x);
}

// `x`, as a full `major.minor.patch` version, when it can be one
/** @type {(x: nvmVersionish) => nvmVersionish} */
function fullVersion(x) {
	const version = semver.coerce(x)?.version;
	return typeof version === 'string' && isBareVersion(version) ? version : x;
}

/** @type {(x: nvmVersionishBaseBare) => `iojs-${nvmVersionishBaseV}` | typeof x} */
function iojsMapper(x) {
	return semver.satisfies(x, iojsRange) ? `iojs-v${x}` : x;
}

/**
 * @param {string} reqRange
 * @param {string} optRange
 * @param {Type | ''} type
 * @param {boolean} isNotable
 * @param {boolean} fullSemver
 */
// eslint-disable-next-line max-params
export async function getReqOpts(reqRange, optRange, type, isNotable, fullSemver) {
	const versions = (await allVersions())
		.filter((v) => (reqRange && semver.satisfies(v, reqRange)) || (optRange && semver.satisfies(v, optRange)));
	const map = getMinorsByMajor(versions);
	const { requireds: req0x, optionals: opt0x } = get0xReqs(versions);
	const values = Array.from(map.values());

	/** @type {ReqOptMap['requireds']} */
	let requireds = [];
	/** @type {ReqOptMap['optionals']} */
	let optionals = [];

	if (type === 'majors') {
		if (reqRange) {
			requireds = map.entries()
				.filter(([x, [latest]]) => (semver.subset(x, '>= 1') && semver.subset(latest, reqRange)) || req0x.includes(x))
				.map(([x]) => x)
				.toArray();
		}
		if (optRange) {
			optionals = map.entries()
				.filter(([x, [latest]]) => (
					!requireds.includes(x)
					&& (
						opt0x.includes(x)
						|| semver.subset(latest, optRange)
					)
				))
				.map(([x]) => x)
				.toArray();
		}
	} else if (isNotable) {
		return { requireds: values.flat().sort(comparator), optionals };
	} else if (reqRange && !optRange) {
		const reqs = values.flat();
		requireds = reqs.filter((x) => semver.subset(x, '>= 1') || req0x.includes(x));
	} else {
		const latest = values.map(([v]) => v);
		if (reqRange) {
			requireds = latest.filter((x) => semver.subset(x, '>= 1') || req0x.includes(x));
		}
		if (optRange) {
			const nonLatest = values.flatMap(([, ...vs]) => vs);
			optionals = [].concat(
				// @ts-expect-error TS sucks with concat
				latest.filter((x) => semver.subset(x, '< 1') && opt0x.includes(x)),
				nonLatest.filter((x) => semver.subset(x, '>= 1')),
			);
		}
	}
	requireds.sort(comparator);
	optionals.sort(comparator);
	if (fullSemver) {
		requireds = requireds.map(fullVersion);
		optionals = optionals.map(fullVersion);
	}

	// @ts-expect-error FIXME figure out how to untangle this type
	requireds = requireds.map(iojsMapper);
	// @ts-expect-error FIXME figure out how to untangle this type
	optionals = optionals.map(iojsMapper).filter((x) => !requireds.includes(x));

	return { requireds, optionals };
}

/** @type {(map: Awaited<ReturnType<typeof getReqOpts>>, opts: { type: Type | '', notable: string }) => Promise<typeof map>} */
export async function addNotable({ requireds: oldReqs, optionals: oldOpts }, { type, notable }) {
	const { requireds: notableVersions } = await getReqOpts(notable, '', type, true, false);

	/** @type {Set<nvmVersionish>} */ // @ts-expect-error TS sucks with concat
	const requiredSet = new Set([].concat(notableVersions, oldReqs));

	const requireds = Array.from(requiredSet).sort(comparator);

	const optionals = oldOpts.filter((x) => !requiredSet.has(x));

	return { requireds, optionals };
}

/**
 * @param {'0.x' | 'iojs' | string} preset
 * @param {Type | ''} type @param {boolean} fullSemver
 */
export async function getPreset(preset, type, fullSemver) {
	if (preset === '0.x') {
		if (type) {
			throw new TypeError('the `0.x` preset is incompatible with `type`');
		}
		return get0xReqs();
	}
	if (preset === 'iojs') {
		return getReqOpts(iojsRange, iojsRange, type, false, fullSemver);
	}
	return getReqOpts(preset, preset, type, false, fullSemver);
}
