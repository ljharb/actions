import test from 'tape';
import nock from 'nock';
import semver from 'semver';
import { readFileSync } from 'fs';
import { execFile } from 'child_process';
import { fileURLToPath } from 'url';
import { promisify } from 'util';

import {
	allVersions,
	getReqOpts,
	addNotable,
	getPreset,
	presets,
} from '../../../node/matrix/versions.mjs';

const execFileP = promisify(execFile);

const fixtureDir = new URL('./versions/', import.meta.url);
const nodeFixture = readFileSync(new URL('nodejs.json', fixtureDir), 'utf8');
const iojsFixture = readFileSync(new URL('iojs.json', fixtureDir), 'utf8');

const versionsModule = fileURLToPath(new URL('../../../node/matrix/versions.mjs', import.meta.url));
const root = fileURLToPath(new URL('../../../', import.meta.url));

const expectedAll = [
	'v24.1.0',
	'v24.0.0',
	'v23.11.0',
	'v23.0.0',
	'v22.5.1',
	'v22.4.0',
	'v20.2.0',
	'v20.1.0',
	'v18.0.0',
	'v4.9.1',
	'v4.0.0',
	'v3.3.1',
	'v3.0.0',
	'v2.5.0',
	'v1.8.4',
	'v1.0.0',
	'v0.12.18',
	'v0.12.0',
	'v0.11.16',
	'v0.10.48',
	'v0.10.0',
	'v0.9.12',
	'v0.8.28',
	'v0.6.21',
];

/** @param {import('tape').Test} t */
function blockNetwork(t) {
	nock.disableNetConnect();
	t.teardown(() => {
		nock.cleanAll();
		nock.enableNetConnect();
	});
}

/** @typedef {{ versions: string[], logs: [string, string[]][], scope: ReturnType<typeof nock> }} Primed */

/** @type {Promise<Primed> | undefined} */
let primed;

/*
 * `allVersions` memoizes its fetch for the life of the module, so every test
 * that depends on version data awaits this first: whichever test runs first
 * (regardless of ordering or `test.only`) fetches the fixtures via nock, and
 * the rest reuse the cached result without touching the network.
 */
function prime() {
	if (!primed) {
		const scope = nock('https://raw.githubusercontent.com')
			.get('/ljharb/actions/nodejs/index.json')
			.reply(200, nodeFixture)
			.get('/ljharb/actions/iojs/index.json')
			.reply(200, iojsFixture);

		/** @type {Primed['logs']} */
		const logs = [];
		const { log } = console;
		console.log = (label, list) => { logs.push([label, list]); };
		primed = allVersions().finally(() => {
			console.log = log;
		}).then((versions) => ({ versions, logs, scope }));
	}
	return primed;
}

test('presets', (t) => {
	t.deepEqual(presets, ['0.x', 'iojs'], 'exports the known presets');
	t.end();
});

test('allVersions', async (t) => {
	blockNetwork(t);

	const { versions, logs, scope } = await prime();

	t.deepEqual(versions, expectedAll, 'merges node and io.js versions, sorted descending, without v22.5.0');
	t.ok(scope.isDone(), 'both indexes were fetched');

	const sortLogs = logs.map(([label, list]) => [label, list.length]).sort();
	t.deepEqual(
		sortLogs,
		[
			['all versions of type iojs', 5],
			['all versions of type nodejs', 20],
		],
		'logs the unfiltered version list for each type',
	);
	t.ok(
		logs.some(([label, list]) => label === 'all versions of type nodejs' && list.includes('v22.5.0')),
		'the logged node list is unfiltered',
	);

	const again = allVersions();
	t.equal(again, allVersions(), 'the promise is memoized');
	t.deepEqual(await again, expectedAll, 'memoized result needs no further requests');
});

test('allVersions: fetch failure', async (t) => {
	const code = `
		import nock from 'nock';
		nock.disableNetConnect();
		nock('https://raw.githubusercontent.com')
			.get('/ljharb/actions/nodejs/index.json')
			.reply(500, '{}')
			.get('/ljharb/actions/iojs/index.json')
			.reply(200, ${JSON.stringify(iojsFixture)});
		const { allVersions } = await import(${JSON.stringify(versionsModule)});
		console.log = () => {};
		allVersions().then(
			() => { process.stdout.write('resolved'); },
			(e) => { process.stdout.write('rejected: ' + e); },
		);
	`;
	const { stdout, stderr } = await execFileP(
		process.execPath,
		['--input-type=module', '-e', code],
		{ cwd: root },
	);

	t.equal(stdout, 'rejected: Unexpected response code 500', 'the fetch rejection propagates');
	t.match(
		stderr,
		/Error fetching and parsing JSON from `https:\/\/raw\.githubusercontent\.com\/ljharb\/actions\/nodejs\/index\.json`/,
		'logs which URL failed',
	);
});

test('getReqOpts: majors', async (t) => {
	blockNetwork(t);
	await prime();

	t.deepEqual(
		await getReqOpts('>= 0.8', '', 'majors', false, false),
		{
			requireds: ['24', '23', '22', '20', '18', '4', '3', '2', '1', '0.12', '0.10', '0.8'],
			optionals: [],
		},
		'requireds only: every major, with 0.x minors limited to the required ones; io.js majors are not prefixed without fullSemver',
	);

	t.deepEqual(
		await getReqOpts('>= 0.8', '>= 0.8', 'majors', false, false),
		{
			requireds: ['24', '23', '22', '20', '18', '4', '3', '2', '1', '0.12', '0.10', '0.8'],
			optionals: ['0.11', '0.9'],
		},
		'both ranges: odd 0.x minors become optional, and requireds are not duplicated',
	);

	t.deepEqual(
		await getReqOpts('', '>= 0.6', 'majors', false, false),
		{
			requireds: [],
			optionals: ['24', '23', '22', '20', '18', '4', '3', '2', '1', '0.12', '0.11', '0.10', '0.9', '0.8', '0.6'],
		},
		'optionals only: every major whose latest is in range, including unlisted 0.x minors',
	);

	t.deepEqual(
		await getReqOpts('^20 || 0.12', '>= 18', 'majors', false, false),
		{
			requireds: ['20', '0.12'],
			optionals: ['24', '23', '22', '18'],
		},
		'majors outside the required range are excluded from requireds',
	);

	t.deepEqual(
		await getReqOpts('^24.0', '', 'majors', false, false),
		{
			requireds: ['24'],
			optionals: [],
		},
		'a major whose latest version satisfies the required range is required',
	);

	t.deepEqual(
		await getReqOpts('>= 20', '>= 0.10', 'majors', false, true),
		{
			requireds: ['24.0.0', '23.0.0', '22.0.0', '20.0.0', '0.12.0', '0.10.0'],
			optionals: ['18.0.0', '4.0.0', 'iojs-v3.0.0', 'iojs-v2.0.0', 'iojs-v1.0.0', '0.11.0'],
		},
		'fullSemver coerces to full versions',
	);

	t.deepEqual(
		await getReqOpts('^99', '^98', 'majors', false, false),
		{ requireds: [], optionals: [] },
		'no matching versions yields nothing',
	);
});

test('getReqOpts: fullSemver falls back to the original value when it cannot be coerced', async (t) => {
	blockNetwork(t);
	await prime();

	const { coerce } = semver;
	/** @type {unknown[]} */
	const coerced = [];
	semver.coerce = (v) => {
		coerced.push(v);
		return null;
	};
	try {
		// single-element lists, so the sort comparator (which also coerces) never runs
		t.deepEqual(
			await getReqOpts('^24', '', 'majors', false, true),
			{ requireds: ['24'], optionals: [] },
			'an uncoercible required is kept as-is',
		);
		t.deepEqual(
			await getReqOpts('', '^24', 'majors', false, true),
			{ requireds: [], optionals: ['24'] },
			'an uncoercible optional is kept as-is',
		);
	} finally {
		semver.coerce = coerce;
	}
	t.deepEqual(coerced, ['24', '24'], 'coerce was attempted on each value');
});

test('getReqOpts: minors', async (t) => {
	blockNetwork(t);
	await prime();

	t.deepEqual(
		await getReqOpts('>= 0.8', '', 'minors', false, false),
		{
			requireds: [
				'24.1',
				'24.0',
				'23.11',
				'23.0',
				'22.5',
				'22.4',
				'20.2',
				'20.1',
				'18.0',
				'4.9',
				'4.0',
				'3.3',
				'3.0',
				'2.5',
				'1.8',
				'1.0',
				'0.12',
				'0.10',
				'0.8',
			],
			optionals: [],
		},
		'requireds only: every minor >= 1, plus the required 0.x minors',
	);

	t.deepEqual(
		await getReqOpts('>= 0.8', '>= 0.8', 'minors', false, false),
		{
			requireds: ['24.1', '23.11', '22.5', '20.2', '18.0', '4.9', '3.3', '2.5', '1.8', '0.12', '0.10', '0.8'],
			optionals: ['24.0', '23.0', '22.4', '20.1', '4.0', '3.0', '1.0', '0.11', '0.9'],
		},
		'both ranges: latest minor per major is required, the rest optional',
	);

	t.deepEqual(
		await getReqOpts('', '>= 0.6', 'minors', false, false),
		{
			requireds: [],
			optionals: ['24.0', '23.0', '22.4', '20.1', '4.0', '3.0', '1.0', '0.11', '0.9'],
		},
		'optionals only: non-latest minors and the optional 0.x minors',
	);

	t.deepEqual(
		await getReqOpts('>= 20', '>= 0.10', 'minors', false, true),
		{
			requireds: ['24.1.0', '23.11.0', '22.5.0', '20.2.0', '18.0.0', '4.9.0', 'iojs-v3.3.0', 'iojs-v2.5.0', 'iojs-v1.8.0', '0.12.0', '0.10.0'],
			optionals: ['24.0.0', '23.0.0', '22.4.0', '20.1.0', '4.0.0', 'iojs-v3.0.0', 'iojs-v1.0.0', '0.11.0'],
		},
		'both ranges with fullSemver: the latest minor of every matched major is required',
	);

	t.deepEqual(
		await getReqOpts('^22 || ^1', '', 'minors', false, true),
		{
			requireds: ['22.5.0', '22.4.0', 'iojs-v1.8.0', 'iojs-v1.0.0'],
			optionals: [],
		},
		'requireds only with fullSemver and io.js mapping',
	);
});

test('getReqOpts: notable', async (t) => {
	blockNetwork(t);
	await prime();

	t.deepEqual(
		await getReqOpts('^22.4 || ^18 || 0.11', '', 'minors', true, false),
		{
			requireds: ['22.5', '22.4', '18.0', '0.11'],
			optionals: [],
		},
		'notable returns every matching minor, sorted, without filtering 0.x or io.js mapping',
	);

	t.deepEqual(
		await getReqOpts('^3', '', 'minors', true, true),
		{
			requireds: ['3.3', '3.0'],
			optionals: [],
		},
		'notable returns early, ignoring fullSemver and io.js mapping',
	);
});

test('addNotable', async (t) => {
	blockNetwork(t);
	await prime();

	t.deepEqual(
		await addNotable(
			{ requireds: ['24', '20'], optionals: ['23', '22.4', '18'] },
			{ type: 'minors', notable: '^22.4 || ^18' },
		),
		{
			requireds: ['24', '22.5', '22.4', '20', '18.0'],
			optionals: ['23', '18'],
		},
		'notable versions are merged into requireds and removed from optionals',
	);

	t.deepEqual(
		await addNotable(
			{ requireds: ['22.5'], optionals: [] },
			{ type: 'minors', notable: '^22.5' },
		),
		{
			requireds: ['22.5'],
			optionals: [],
		},
		'duplicates are collapsed',
	);
});

test('getPreset', async (t) => {
	blockNetwork(t);
	await prime();

	/** @type {import('../../../node/matrix/versions.mjs').Type} */
	// @ts-expect-error the action passes an empty string when no `type` input is given
	const noType = '';

	t.deepEqual(
		await getPreset('0.x', noType, false),
		{ requireds: ['0.12', '0.10', '0.8'], optionals: ['0.11', '0.9'] },
		'0.x preset returns the fixed 0.x lists',
	);

	await getPreset('0.x', 'majors', false).then(
		() => t.fail('expected a rejection'),
		(e) => {
			t.ok(e instanceof TypeError, 'rejects with a TypeError');
			t.equal(e.message, 'the `0.x` preset is incompatible with `type`', 'with the right message');
		},
	);

	t.deepEqual(
		await getPreset('iojs', 'majors', false),
		{ requireds: ['3', '2', '1'], optionals: [] },
		'iojs preset, majors',
	);

	t.deepEqual(
		await getPreset('iojs', 'minors', true),
		{
			requireds: ['iojs-v3.3.0', 'iojs-v2.5.0', 'iojs-v1.8.0'],
			optionals: ['iojs-v3.0.0', 'iojs-v1.0.0'],
		},
		'iojs preset, minors, fullSemver',
	);

	t.deepEqual(
		await getPreset('>= 20', 'majors', false),
		{ requireds: ['24', '23', '22', '20'], optionals: [] },
		'a range preset uses the range for both requireds and optionals',
	);

	t.deepEqual(
		await getPreset('^24', 'minors', false),
		{ requireds: ['24.1'], optionals: ['24.0'] },
		'a range preset, minors',
	);
});
