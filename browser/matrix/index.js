'use strict';

const util = require('util');
const { execSync } = require('child_process');

const core = require('@actions/core');
const semverCoerce = require('semver/functions/coerce');
const semverCompare = require('semver/functions/compare');
const satisfies = require('semver/functions/satisfies');

const username = core.getInput('username', { required: true });
const accessKey = core.getInput('accessKey', { required: true });
const browser = core.getInput('browser', {
	choices: [
		'safari',
		'chrome',
		'firefox',
		'ie',
		'edge',
		'yandex',
		'opera',
		'IE Mobile',
		'Mobile Safari',
		'Android Browser',
	],
});

const browserJSON = String(execSync(`curl -qs -u "${username}:${accessKey}" https://api.browserstack.com/5/browsers -o -`));

const browsers = JSON.parse(browserJSON);

console.log('browser data response:', util.inspect(browsers, { depth: Infinity }));

const seenVersions = new Map();

function isChromeEquivalent(b, v) {
	const { version } = semverCoerce(v) ?? {};
	return version && (
		(b === 'opera' && satisfies(version, '>= 15'))
        || (b === 'edge' && satisfies(version, '>= 80'))
	);
}

/* eslint max-nested-callbacks: 0, camelcase: 0 */

const result = Object.entries(browsers)
	.flatMap(([os, v]) => Object.entries(v)
		.flatMap(([ov, rest]) => rest.map(({ browser: b, browser_version }) => ({
			os,
			'os-version': ov,
			browser: b,
			'browser-version': browser_version,
		}))))
	.filter(({ browser: b, 'browser-version': v }) => {
		let versions = seenVersions.get(b);
		if (!seenVersions.has(b)) {
			versions = new Set();
			seenVersions.set(b, versions);
		}
		if ((browser && b !== browser) || versions.has(v) || isChromeEquivalent(b, v)) {
			return false;
		}
		versions.add(v);
		return true;
	})
	.sort(({
		browser: bA,
		'browser-version': vA,
		os: osA,
		'os-version': ovA,
	}, {
		browser: bB,
		'browser-version': vB,
		os: osB,
		'os-version': ovB,
	}) => {
		const bCompare = bA.localeCompare(bB);
		if (bCompare !== 0) {
			return bCompare;
		}

		const bvCompare = semverCompare(
			semverCoerce(vB)?.version ?? '999.999.999',
			semverCoerce(vA)?.version ?? '999.999.999',
		);
		if (bvCompare !== 0) {
			return bvCompare;
		}

		const osCompare = osA.localeCompare(osB);
		if (osCompare !== 0) {
			return osCompare;
		}

		return semverCompare(
			semverCoerce(ovB)?.version ?? '999.999.999',
			semverCoerce(ovA)?.version ?? '999.999.999',
		);
	});

const json = JSON.stringify({ include: result });

console.log('customized JSON:', util.inspect(result, { depth: Infinity }));

core.setOutput('matrix', json);

const counts = {};
result.forEach(({ browser: b }) => {
	counts[b] = (counts[b] || 0) + 1;
});
console.log(counts, result.length);
