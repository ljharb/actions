import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import test from 'tape';

import { runAction } from '../../node/matrix/index/run.mjs';

const script = fileURLToPath(new URL('../../../browser/matrix/index.mjs', import.meta.url));
const fixture = fileURLToPath(new URL('fixtures/browsers.json', import.meta.url));

/** @typedef {{ os: string, 'os-version': string, browser: string, 'browser-version': string | null }} Entry */

/**
 * Runs the action with a fake `curl` first on `PATH`, which records its arguments and prints `body`.
 * @param {Record<string, string>} inputs
 * @param {{ body?: string, exitCode?: number }} [options]
 */
function run(inputs, { body = readFileSync(fixture, 'utf8'), exitCode = 0 } = {}) {
	const bin = mkdtempSync(path.join(tmpdir(), 'ljharb-actions-browser-'));
	try {
		const argsFile = path.join(bin, 'args.txt');
		const bodyFile = path.join(bin, 'body.json');
		writeFileSync(bodyFile, body);
		const curl = path.join(bin, 'curl');
		writeFileSync(curl, `#!/bin/sh
for arg in "$@"; do printf '%s\\n' "$arg" >> ${JSON.stringify(argsFile)}; done
cat ${JSON.stringify(bodyFile)}
exit ${exitCode}
`);
		chmodSync(curl, 0o755);

		const result = runAction(script, { inputs, prependPath: bin });
		/** @type {string[]} */
		let curlArgs = [];
		try {
			curlArgs = readFileSync(argsFile, 'utf8').split('\n').slice(0, -1);
		} catch { /**/ }
		return { ...result, curlArgs };
	} finally {
		rmSync(bin, { force: true, recursive: true });
	}
}

const expectedCurlArgs = [
	'-qs',
	'-u',
	'user:key',
	'https://api.browserstack.com/5/browsers',
	'-o',
	'-',
];

/** @type {Entry[]} */
const expectedAll = [
	{ os: 'Windows', 'os-version': '10', browser: 'chrome', 'browser-version': '120.0' },
	{ os: 'Windows', 'os-version': '10', browser: 'chrome', 'browser-version': '119.0' },
	{ os: 'Windows', 'os-version': '10', browser: 'chrome', 'browser-version': '118' },
	{ os: 'Windows', 'os-version': '8.1', browser: 'chrome', 'browser-version': '118.0' },
	{ os: 'OS X', 'os-version': 'Sonoma', browser: 'chrome', 'browser-version': '117' },
	{ os: 'OS X', 'os-version': 'Ventura', browser: 'chrome', 'browser-version': '117.0' },
	{ os: 'Windows', 'os-version': '10', browser: 'edge', 'browser-version': '79.0' },
	{ os: 'OS X', 'os-version': 'Sonoma', browser: 'firefox', 'browser-version': 'dev' },
	{ os: 'Windows', 'os-version': '11', browser: 'firefox', 'browser-version': 'beta' },
	{ os: 'Windows', 'os-version': '10', browser: 'firefox', 'browser-version': '121.0' },
	// same browser, version, and OS: only the os version (descending) puts 11 before 10, against input order
	{ os: 'Windows', 'os-version': '11', browser: 'ie', 'browser-version': '11' },
	{ os: 'Windows', 'os-version': '10', browser: 'ie', 'browser-version': '11.0' },
	{ os: 'ios', 'os-version': '17', browser: 'iphone', 'browser-version': null },
	{ os: 'Windows', 'os-version': '10', browser: 'opera', 'browser-version': '12.16' },
	{ os: 'OS X', 'os-version': 'Sonoma', browser: 'safari', 'browser-version': '17.0' },
	// same browser and version: only the OS name puts OS X first, against input order and the os version (11 > 10.15)
	{ os: 'OS X', 'os-version': '10.15', browser: 'yandex', 'browser-version': '23.0' },
	{ os: 'Windows', 'os-version': '11', browser: 'yandex', 'browser-version': '23' },
];

test('browser/matrix: all browsers', (t) => {
	const result = run({ username: 'user', accessKey: 'key' });

	t.equal(result.status, 0, 'exits successfully');
	t.deepEqual(result.curlArgs, expectedCurlArgs, 'calls curl with the credentials and the BrowserStack browsers URL');
	t.deepEqual(Object.keys(result.outputs), ['matrix'], 'sets exactly the `matrix` output');

	const matrix = JSON.parse(result.outputs.matrix);
	t.deepEqual(
		matrix,
		{ include: expectedAll },
		'dedupes browser versions, drops chromium-based opera/edge, and sorts by browser, version desc, os, os version desc',
	);
	t.ok(result.stdout.includes('browser data response:'), 'logs the raw response');
	t.ok(result.stdout.includes('customized JSON:'), 'logs the result');
	t.ok(result.stdout.includes(`${expectedAll.length}\n`), 'logs the total count');
	t.match(result.stdout, /chrome: 6,\s+edge: 1,\s+firefox: 3,\s+ie: 2,\s+iphone: 1,\s+opera: 1,\s+safari: 1,\s+yandex: 2/, 'logs per-browser counts');

	t.end();
});

test('browser/matrix: `browser` filter', (t) => {
	const result = run({ username: 'user', accessKey: 'key', browser: 'firefox' });

	t.equal(result.status, 0, 'exits successfully');
	t.deepEqual(
		JSON.parse(result.outputs.matrix),
		{ include: expectedAll.filter(({ browser }) => browser === 'firefox') },
		'only includes the requested browser',
	);
	t.end();
});

test('browser/matrix: empty response', (t) => {
	const result = run({ username: 'user', accessKey: 'key' }, { body: '{}' });

	t.equal(result.status, 0, 'exits successfully');
	t.deepEqual(JSON.parse(result.outputs.matrix), { include: [] }, 'outputs an empty matrix');
	t.end();
});

test('browser/matrix: required inputs', (t) => {
	t.test('missing `username`', (st) => {
		const result = run({ accessKey: 'key' });
		st.notEqual(result.status, 0, 'exits with failure');
		st.ok(result.stderr.includes('Input required and not supplied: username'), 'reports the missing input');
		st.deepEqual(result.curlArgs, [], 'does not call curl');
		st.deepEqual(result.outputs, {}, 'sets no outputs');
		st.end();
	});

	t.test('missing `accessKey`', (st) => {
		const result = run({ username: 'user' });
		st.notEqual(result.status, 0, 'exits with failure');
		st.ok(result.stderr.includes('Input required and not supplied: accessKey'), 'reports the missing input');
		st.deepEqual(result.curlArgs, [], 'does not call curl');
		st.deepEqual(result.outputs, {}, 'sets no outputs');
		st.end();
	});

	t.end();
});

test('browser/matrix: failures', (t) => {
	t.test('curl fails', (st) => {
		const result = run({ username: 'user', accessKey: 'key' }, { body: '', exitCode: 7 });
		st.notEqual(result.status, 0, 'exits with failure');
		st.ok(result.stderr.includes('Command failed'), 'reports the failed command');
		st.deepEqual(result.curlArgs, expectedCurlArgs, 'called curl');
		st.deepEqual(result.outputs, {}, 'sets no outputs');
		st.end();
	});

	t.test('invalid JSON', (st) => {
		const result = run({ username: 'user', accessKey: 'key' }, { body: '<html>nope</html>' });
		st.notEqual(result.status, 0, 'exits with failure');
		st.ok(result.stderr.includes('SyntaxError'), 'reports the parse error');
		st.deepEqual(result.outputs, {}, 'sets no outputs');
		st.end();
	});

	t.end();
});
