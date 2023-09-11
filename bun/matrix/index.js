'use strict';

const core = require('@actions/core');
const github = require('@actions/github');
const semver = require('semver');
// const getJSON = require('get-json');

async function getVersions() {
	return ['latest'];
	/*
	 * const index = await getJSON(`https://${type}.org/dist/index.json`).catch((e) => {
	 * 	console.error(`Error fetching and parsing JSON from \`https://${type}.org/dist/index.json\``);
	 * 	throw e;
	 * });
	 * return index.map(({ version }) => version);
	 */
}

const allVersions = getVersions().then((x) => semver.sort(x).reverse());

function majMin(v) {
	return `${semver.major(v)}.${semver.minor(v)}`;
}

function getMinorsByMajor(versions) {
	const minorEntries = versions.map((v) => [`${semver.satisfies(v, '< 1') ? majMin(v) : semver.major(v)}`, majMin(v)]);
	const minorsByMajor = {};
	minorEntries.forEach(([maj, v]) => {
		minorsByMajor[maj] = Array.from(new Set([].concat(minorsByMajor[maj] || [], v)));
	});
	return minorsByMajor;
}

function comparator(a, b) {
	return semver.compare(semver.coerce(b), semver.coerce(a));
}

async function getReqOpts(range, type) {
	if (range === 'latest') {
		return {
			requireds: ['latest'],
			optionals: [],
		};
	}

	const versions = (await allVersions)
		.filter((v) => range && semver.satisfies(v, range));
	const map = getMinorsByMajor(versions);
	const values = Object.values(map);

	let requireds = [];
	let optionals = [];
	if (type === 'majors') {
		requireds = Object.entries(map).flatMap(([x, [latest]]) => (semver.subset(x, '>= 1') && semver.subset(latest, range)) || []);
		optionals = Object.keys(map)
			.flat()
			.filter((x) => !requireds.includes(x) && semver.subset(map[x][0], range));
	} else {
		const latest = values.map(([v]) => v);
		requireds = latest.filter((x) => semver.subset(x, '>= 1'));
		const nonLatest = values.flatMap(([, ...vs]) => vs);
		optionals = [].concat(
			latest.filter((x) => semver.subset(x, '< 1')),
			nonLatest.filter((x) => semver.subset(x, '>= 1')),
		);
	}
	requireds.sort(comparator);
	optionals.sort(comparator);

	optionals = optionals.filter((x) => !requireds.includes(x));

	return { requireds, optionals };
}

async function main() {
	const key = core.getInput('version_key');
	const versionsAsRoot = core.getInput('versionsAsRoot');
	const type = core.getInput('type');
	const range = core.getInput('range');
	const envs = JSON.parse(core.getInput('envs') || null);
	if (envs && versionsAsRoot) {
		throw new TypeError('`envs` and `versionsAsRoot` are mutually exclusive');
	}

	if (range !== 'latest' && !semver.validRange(range)) {
		throw new TypeError('`range`, if provided, must be a valid semver range or "latest"');
	}
	if (type && (type !== 'majors' && type !== 'minors')) {
		throw new TypeError('`type` must be "majors" or "minors"');
	}

	const makePayload = versionsAsRoot ? (x) => x : (versions) => ({ ...envs && { envs }, [key]: versions });

	const {
		requireds: reqs,
		optionals: opts,
	} = await getReqOpts(range, type);

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
