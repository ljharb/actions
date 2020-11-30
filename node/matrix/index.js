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

function majMin(v) {
	return `${semver.major(v)}.${semver.minor(v)}`;
}

function getMinorsByMajor(versions) {
	const minorEntries = versions.map(v => [`${semver.major(v)}`, majMin(v)]);
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

async function getPreset(makePayload, preset, type) {
	let requireds;
	let optionals;
	if (preset === '0.x') {
		if (type) {
			throw new TypeError('the `0.x` preset is incompatible with `type`');
		}
		requireds = [
			'0.12',
			'0.10',
			'0.8',
		],
		optionals = [
			'0.11',
			'0.9',
			'0.6',
			//'0.4',
		];
	} else if (preset === 'iojs') {
		const iojsVersions = (await getNodeVersions('iojs')).filter(v => semver.satisfies(v, '^1 || ^2 || ^3'));
		const iojs = getMinorsByMajor(iojsVersions);
		if (type === 'majors') {
			requireds = Object.keys(iojs);
			optionals = [];
		} else {
			const values = Object.values(iojs);
			requireds = values.map(([v]) => v);
			optionals = values.flatMap(([_, ...vs]) => vs);
		}
		requireds = requireds.sort(comparator).map(x => `iojs-v${x}`);
		optionals = optionals.sort(comparator).map(x => `iojs-v${x}`);
	} else {
		const map = getMinorsByMajor((await nodeVersions).filter(v => semver.satisfies(v, preset)));
		if (type === 'majors') {
			requireds = Object.keys(map);
			optionals = [];
		} else {
			const values = Object.values(map);
			requireds = values.map(([v]) => v);
			optionals = values.flatMap(([_, ...vs]) => vs);
		}
		requireds.sort(comparator);
		optionals.sort(comparator);
	}
	const requiredsOutput = makePayload(requireds);
	core.setOutput('requireds', JSON.stringify(requiredsOutput));
	core.info(`requireds: ${requiredsOutput}`);

	const optionalsOutput = makePayload(optionals);
	core.setOutput('optionals', JSON.stringify(optionalsOutput));
	core.info(`optionals: ${optionalsOutput}`);
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

	if (preset) {
		await getPreset(makePayload, preset, type);
	} else {
		if (!semver.validRange(requireds) || !semver.validRange(optionals)) {
			throw new TypeError('`requireds` and `optionals` must both be valid semver ranges');
		}

		const versions = await getNodeVersions().then((versions) => {
			if (type === 'majors') {
				return [...new Set(versions.filter(v => semver.major(v)))];
			}
			return [...new Set(versions.filter((v) => `${majMin(v)}`))]
		});

		const requiredsOutput = makePayload(versions.filter(v => semver.intersects(semver.coerce(v).version, requireds)));
		core.setOutput('requireds', JSON.stringify(requiredsOutput));
		core.info(`requireds: ${requiredsOutput}`);

		const optionalsOutput = makePayload(versions.filter(v => semver.intersects(semver.coerce(v).version, optionals)));
		core.setOutput('optionals', JSON.stringify(optionalsOutput));
		core.info(`optionals: ${optionalsOutput}`);
	}

	// Get the JSON webhook payload for the event that triggered the workflow
	const payload = JSON.stringify(github.context.payload, null, '\t');
	console.log(`The event payload: ${payload}`);
}
main().catch((error) => {
	core.setFailed(error.message);
});
