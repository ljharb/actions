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

const presets = ['0.x', 'iojs', '>=4'];

function comparator(a, b) {
	return semver.compare(semver.coerce(b), semver.coerce(a));
}

async function getPreset(key, preset) {
	let requireds;
	let optionals;
	if (preset === '0.x') {
		requireds = [
			'0.12',
			'0.10',
			'0.8',
		],
		optionals = [
			'0.11',
			'0.9',
			'0.6',
			'0.4',
		];
	} else if (preset === 'iojs') {
		const iojsVersions = (await getNodeVersions('iojs')).filter(v => semver.satisfies(v, '^1 || ^2 || ^3'));
		const iojs = getMinorsByMajor(iojsVersions);
		requireds = Object.values(iojs).map(([v]) => v).sort(comparator).map(x => `iojs-v${x}`);
		optionals = Object.values(iojs).flatMap(([_, ...vs]) => vs).sort(comparator).map(x => `iojs-v${x}`);
	} else if (preset === '>=4') {
		const map = getMinorsByMajor((await nodeVersions).filter(v => semver.satisfies(v, preset)));
		requireds = Object.values(map).map(([v]) => v).sort(comparator);
		optionals = Object.values(map).flatMap(([_, ...vs]) => vs).sort(comparator);
	}
	core.setOutput('requireds', JSON.stringify({ [key]: requireds }));
	core.setOutput('optionals', JSON.stringify({ [key]: optionals }));
}

async function main() {
	const key = core.getInput('version_key');
	const requireds = core.getInput('requireds');
	const optionals = core.getInput('optionals');
	const type = core.getInput('type');
	const preset = core.getInput('preset');

	if (preset && !presets.includes(preset)) {
		throw new TypeError(`\`preset\`, if provided, must be one of: \`${presets.join(', ')}\``);
	}
	if (preset && (requireds || optionals || type)) {
		throw new TypeError('if `preset` is provided, `requireds` and `optionals` and `type` must not be');
	}

	if (preset) {
		await getPreset(key, preset);
	} else {
		if (!semver.validRange(requireds) || !semver.validRange(optionals)) {
			throw new TypeError('`requireds` and `optionals` must both be valid semver ranges');
		}
		if (type !== 'majors' && type !== 'minors') {
			throw new TypeError('`type` must be "majors" or "minors"');
		}

		const versions = await getNodeVersions().then((versions) => {
			if (type === 'majors') {
				return [...new Set(versions.filter(v => semver.major(v)))];
			}
			return [...new Set(versions.filter((v) => `${majMin(v)}`))]
		});

		core.setOutput('requireds', JSON.stringify({ [key]: versions.filter(v => semver.intersects(semver.coerce(v).version, requireds)) }));
		core.setOutput('optionals', JSON.stringify({ [key]: versions.filter(v => semver.intersects(semver.coerce(v).version, optionals)) }));
	}

	// Get the JSON webhook payload for the event that triggered the workflow
	const payload = JSON.stringify(github.context.payload, null, '\t');
	console.log(`The event payload: ${payload}`);
}
main().catch((error) => {
	core.setFailed(error.message);
});
