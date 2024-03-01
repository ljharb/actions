'use strict';

const core = require('@actions/core');
const github = require('@actions/github');
const semver = require('semver');
const getJSON = require('get-json');

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

/** @type {(type?: 'nodejs' | 'iojs') => Promise<Version[]>} */
async function getNodeVersions(type = 'nodejs') {
	const url = `https://raw.githubusercontent.com/ljharb/actions/${type}/index.json`; // `https://${type}.org/dist/index.json`;

	const index = /** @type {{ version: Version, date: string, files: string[], npm: BareVersion, v8: `${BareVersion}.${number}`, uv: BareVersion, zlib: string, openssl: string, modules: `${number}`, lts: boolean, security: boolean }[]} */ (
		await getJSON(url).catch(/** @type {(e: Error) => never} */ (e) => {
			console.error(`Error fetching and parsing JSON from \`${url}\``);
			throw e;
		})
	);
	return index.map(({ version }) => version);
}

const nodeVersions = getNodeVersions();

/** @type {Promise<Version[]>} */
const allVersions = Promise.all([nodeVersions, getNodeVersions('iojs')])
	.then(([x, y]) => semver.sort(x.concat(y)).reverse());

/** @type {(v: Version) => `${number}.${number}`} */
function majMin(v) {
	return `${semver.major(v)}.${semver.minor(v)}`;
}

/** @type {(versions: Version[]) => Record<MajMin | Maj, Version[]>} */
function getMinorsByMajor(versions) {
	const minorEntries = /** @type {[keyof ReturnType<typeof getMinorsByMajor>, ReturnType<majMin>][]} */ (
		versions.map((v) => [`${semver.satisfies(v, '< 1') ? majMin(v) : semver.major(v)}`, majMin(v)])
	);
	/** @type {ReturnType<typeof getMinorsByMajor>} */
	const minorsByMajor = {};
	minorEntries.forEach(([maj, v]) => {
		minorsByMajor[maj] = Array.from(new Set([].concat(
			// @ts-expect-error TS sucks with concat
			minorsByMajor[maj] || [],
			v,
		)));
	});
	return minorsByMajor;
}

const presets = ['0.x', 'iojs'];

/** @type {(a: string, b: typeof a) => number} */
function comparator(a, b) {
	// @ts-expect-error coerce can return null, but won't here
	return semver.compare(semver.coerce(b), semver.coerce(a));
}

/** @type {(filter?: nvmVersionish[]) => ReqOptMap} */
function get0xReqs(filter) {
	const requireds = [
		'0.12',
		'0.10',
		'0.8',
	].filter((x) => !filter || filter.some((f) => semver.satisfies(f, x)));
	const optionals = [
		'0.11',
		'0.9',
		// '0.6',
		// '0.4',
	].filter((x) => !filter || filter.some((f) => semver.satisfies(f, x)));
	/* eslint no-extra-parens: 0, object-shorthand: 0 */
	return {
		requireds: /** @type {ReqOptMap['requireds']} */ (requireds),
		optionals: /** @type {ReqOptMap['optionals']} */ (optionals),
	};
}

const iojsRange = '^1 || ^2 || ^3';

/** @type {(x: nvmVersionishBaseBare) => `iojs-${nvmVersionishBaseV}` | typeof x} */
function iojsMapper(x) {
	return semver.satisfies(x, iojsRange) ? `iojs-v${x}` : x;
}

/** @type {(regRange: string, optRange: string, type: Type) => Promise<ReqOptMap>} */
async function getReqOpts(reqRange, optRange, type) {
	const versions = (await allVersions)
		.filter((v) => (reqRange && semver.satisfies(v, reqRange)) || (optRange && semver.satisfies(v, optRange)));
	const map = getMinorsByMajor(versions);
	const { requireds: req0x, optionals: opt0x } = get0xReqs(versions);
	const values = Object.values(map);

	/** @type {ReqOptMap['requireds']} */
	let requireds = [];
	/** @type {ReqOptMap['optionals']} */
	let optionals = [];
	if (type === 'majors') {
		if (reqRange) {
			const entries = (/** @type {[MajMin | Maj, Version[]]} */ (/** @type {unknown} */ (Object.entries(map))));
			/** @type {(entry: [MajMin | Maj, Version[]]) => [MajMin | Maj] | []} */
			const mapper = ([x, [latest]]) => {
				const subset = semver.subset(x, '>= 1') && semver.subset(latest, reqRange);
				return subset || req0x.includes(x) ? [x] : [];
			};
			// @ts-expect-error FIXME no idea why TS can't handle this one
			requireds = entries.flatMap(mapper);
		}
		if (optRange) {
			optionals = /** @type {nvmVersionish[]} */ (
				Object.keys(map)
					.flat()
					.filter((x) => (
						!requireds.includes(/** @type {nvmVersionish} */ (x))
						&& (
							opt0x.includes(/** @type {nvmVersionish} */ (x))
							|| semver.subset(map[/** @type {keyof map} */ (x)][0], optRange)
						)
					))
			);
		}
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

	// @ts-expect-error FIXME figure out how to untangle this type
	requireds = requireds.map(iojsMapper);
	// @ts-expect-error FIXME figure out how to untangle this type
	optionals = optionals.map(iojsMapper).filter((x) => !requireds.includes(x));

	return { requireds, optionals };
}

/** @type {(preset: '0.x' | 'iojs' | string, type: Type) => Promise<ReqOptMap>} */
async function getPreset(preset, type) {
	if (preset === '0.x') {
		if (type) {
			throw new TypeError('the `0.x` preset is incompatible with `type`');
		}
		return get0xReqs();
	}
	if (preset === 'iojs') {
		return getReqOpts(iojsRange, iojsRange, type);
	}
	return getReqOpts(preset, preset, type);
}

async function main() {
	const key = /** @type {'node-version'} */ (core.getInput('version_key'));
	const versionsAsRoot = core.getInput('versionsAsRoot');
	const requireds = core.getInput('requireds');
	const optionals = core.getInput('optionals');
	const type = /** @type {Type} */ (core.getInput('type'));
	const preset = core.getInput('preset');
	/** @type {Record<string, string>} */
	const envs = JSON.parse(core.getInput('envs') || 'null');
	if (envs && versionsAsRoot) {
		throw new TypeError('`envs` and `versionsAsRoot` are mutually exclusive');
	}

	if (preset && !presets.includes(preset) && !semver.validRange(preset)) {
		throw new TypeError(`\`preset\`, if provided, must be a valid semver range, or one of: \`${presets.join(', ')}\``);
	}
	if (preset && (requireds || optionals)) {
		throw new TypeError('if `preset` is provided, `requireds` and `optionals` must not be');
	}
	if (type && (type !== 'majors' && type !== 'minors')) {
		throw new TypeError('`type` must be "majors" or "minors"');
	}

	const makePayload = versionsAsRoot
		? /** @type {<T extends nvmVersionish[]>(x: T) => T} */ (x) => x
		// eslint-disable-next-line operator-linebreak
		: /** @type {<T extends nvmVersionish[]>(versions: T) => { envs: typeof envs, 'node-version': T }} */
		(versions) => ({
			...envs && { envs },
			[key]: versions,
		});

	if (!preset && (!semver.validRange(requireds) || !semver.validRange(optionals))) {
		throw new TypeError('`requireds` and `optionals` must both be valid semver ranges');
	}
	const {
		requireds: reqs,
		optionals: opts,
	} = await (preset
		? getPreset(preset, type)
		: getReqOpts(requireds, optionals, type)
	);

	const requiredsOutput = makePayload(reqs);
	core.setOutput('requireds', JSON.stringify(requiredsOutput));
	core.info(`requireds: ${JSON.stringify(requiredsOutput)}`);

	const optionalsOutput = makePayload(opts);
	core.setOutput('optionals', JSON.stringify(optionalsOutput));
	core.info(`optionals: ${JSON.stringify(optionalsOutput)}`);

	// Get the JSON webhook payload for the event that triggered the workflow
	const payload = JSON.stringify(github.context.payload, null, '\t');
	console.log(`The event payload: ${payload}`);
}
main().catch((error) => {
	console.error(error);
	core.setFailed(error.message);
});
