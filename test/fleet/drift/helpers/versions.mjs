import nock from 'nock';

/** @typedef {{ nodejs: string[], iojs: string[] }} VersionFixture */

/** @type {(major: number, minors: number) => string[]} */
function minorsOf(major, minors) {
	return Array.from({ length: minors }, (_, minor) => `v${major}.${minor}.0`);
}

/*
 * a synthetic release history, big enough that node tests need splitting into decade shards:
 * - io.js 1-3, one release each
 * - node 0.8, 0.10, 0.12
 * - node 4-35, 20 minors each (but `v22.5.0` is always dropped by `node/matrix`)
 * - node 100, 300 minors, so a shard name past `nineties` is needed
 */
/** @type {() => VersionFixture} */
export function versionFixture() {
	const nodejs = [
		...minorsOf(100, 300),
		...Array.from({ length: 32 }, (_, i) => minorsOf(35 - i, 20)).flat(),
		'v0.12.0',
		'v0.10.0',
		'v0.8.0',
	];
	return {
		nodejs,
		iojs: ['v3.0.0', 'v2.0.0', 'v1.0.0'],
	};
}

/** @type {(fixture: VersionFixture) => void} */
export function mockVersions(fixture) {
	nock('https://raw.githubusercontent.com')
		.persist()
		.get('/ljharb/actions/nodejs/index.json')
		.reply(200, fixture.nodejs.map((version) => ({ version })))
		.get('/ljharb/actions/iojs/index.json')
		.reply(200, fixture.iojs.map((version) => ({ version })));
}
