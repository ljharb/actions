'use strict';

const core = require('@actions/core');
const github = require('@actions/github');
const semver = require('semver');
const getJSON = require('get-json');

async function getNodeVersions(type = 'nodejs') {
	const index = await getJSON(`https://${type}.org/dist/index.json`).catch((e) => {
		console.error(`Error fetching and parsing JSON from \`https://${type}.org/dist/index.json\``);
		throw e;
	});
	return index.map(({ version }) => version);
}

const nodeVersions = getNodeVersions();

const allVersions = Promise.all([nodeVersions, getNodeVersions('iojs')]).then(([x, y]) => semver.sort(x.concat(y)).reverse());

function majMin(v) {
	return `${semver.major(v)}.${semver.minor(v)}`;
}

function getMinorsByMajor(versions) {
	const minorEntries = versions.map(v => [`${semver.satisfies(v, '< 1') ? majMin(v) : semver.major(v)}`, majMin(v)]);
	const minorsByMajor = {};
	minorEntries.forEach(([maj, v]) => {
		minorsByMajor[maj] = Array.from(new Set([].concat(minorsByMajor[maj] || [], v)));
	});
	return minorsByMajor;
}

const presets = ['0.x', 'iojs'];

function comparator(a, b) {
	return semver.compare(semver.coerce(b), semver.coerce(a));
}

function get0xReqs(filter) {
	const requireds = [
		'0.12',
		'0.10',
		'0.8',
	].filter(x => !filter || filter.some(f => semver.satisfies(f, x)));
	const optionals = [
		'0.11',
		'0.9',
		'0.6',
		//'0.4',
	].filter(x => !filter || filter.some(f => semver.satisfies(f, x)));
	return { requireds, optionals };
}

const iojsRange = '^1 || ^2 || ^3';

function iojsMapper(x) {
	return semver.satisfies(x, iojsRange) ? `iojs-v${x}` : x;
}

async function getReqOpts(reqRange, optRange, type) {
	const versions = (await allVersions).filter(v => (reqRange && semver.satisfies(v, reqRange)) || (optRange && semver.satisfies(v, optRange)));
	const map = getMinorsByMajor(versions);
	const { requireds: req0x, optionals: opt0x } = get0xReqs(versions);
	const values = Object.values(map);

	let requireds = [];
	let optionals = [];
	if (type === 'majors') {
		if (reqRange) {
			requireds = Object.keys(map).filter(x => semver.subset(x, '>= 1') || req0x.includes(x));
		}
		if (optRange) {
			optionals = values.flat().filter(x => !requireds.includes(x) && opt0x.includes(x));
		}
	} else {
		if (reqRange && !optRange) {
			const reqs = values.flat();
			requireds = reqs.filter(x => semver.subset(x, '>= 1') || req0x.includes(x));
		} else {
			if (reqRange) {
				const latest = values.map(([v]) => v);
				requireds = latest.filter(x => semver.subset(x, '>= 1') || req0x.includes(x));
			}
			if (optRange) {
				const nonLatest = values.flatMap(([, ...vs]) => vs);
				optionals = nonLatest.filter(x => semver.subset(x, '>= 1') || opt0x.includes(x));
			}
		}
	}
	requireds.sort(comparator);
	optionals.sort(comparator);

	requireds = requireds.map(iojsMapper);
	optionals = optionals.map(iojsMapper).filter(x => !requireds.includes(x));

	return { requireds, optionals };
}

async function getPreset(preset, type) {
	if (preset === '0.x') {
		if (type) {
			throw new TypeError('the `0.x` preset is incompatible with `type`');
		}
		return get0xReqs()
	} else if (preset === 'iojs') {
		const iojsVersions = (await getNodeVersions('iojs')).filter(v => semver.satisfies(v, ));
		return getReqOpts(iojsRange, iojsRange, type);
	}
	return getReqOpts(preset, preset, type);
}

async function main() {
	const key = core.getInput('version_key');
	const versionsAsRoot = core.getInput('versionsAsRoot');
	const requireds = core.getInput('requireds');
	const optionals = core.getInput('optionals');
	const type = core.getInput('type');
	const preset = core.getInput('preset');
	const envs = JSON.parse(core.getInput('envs') || null);
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

	const makePayload = versionsAsRoot ? (x) => x : (versions) => ({ ...(envs && { envs }), [key]: versions });


	if (!preset && (!semver.validRange(requireds) || !semver.validRange(optionals))) {
		throw new TypeError('`requireds` and `optionals` must both be valid semver ranges');
	}
	const { requireds: reqs, optionals: opts } = await (preset ? getPreset(preset, type) : getReqOpts(requireds, optionals, type));

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
	console.error(error)
	core.setFailed(error.message);
});
