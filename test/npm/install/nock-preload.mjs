// Preloaded (via `node --import`) into the action child processes spawned by the install tests.
// It does nothing unless `TEST_NOCK_REPORT` is set, so it is inert when tape imports it.

import { writeFileSync } from 'fs';

import nock from 'nock';

const reportPath = process.env.TEST_NOCK_REPORT;

if (reportPath) {
	nock.disableNetConnect();

	/** @type {{ method: string, path: string, body: string, authorization: string | null }[]} */
	const requests = [];

	const scenario = process.env.TEST_NOCK_SCENARIO || 'none';
	const archiveBody = process.env.TEST_NOCK_ARCHIVE_BODY || '';

	const cacheScope = nock('https://cache.example.com');

	cacheScope.on('request', (/** @type {Request} */ req, /** @type {unknown} */ _, /** @type {string} */ body) => {
		const url = new URL(req.url);
		requests.push({
			method: req.method,
			path: url.pathname + url.search,
			body,
			authorization: req.headers.get('authorization'),
		});
	});

	if (scenario === 'miss') {
		cacheScope
			.get('/_apis/artifactcache/cache')
			.query(true)
			.reply(204);
	}

	if (scenario === 'hit') {
		cacheScope
			.get('/_apis/artifactcache/cache')
			.query(true)
			.reply(200, {
				cacheKey: process.env.TEST_NOCK_HIT_KEY,
				archiveLocation: 'https://cache.example.com/archive/cache.tgz',
			})
			.get('/archive/cache.tgz')
			.reply(200, archiveBody, { 'Content-Length': String(Buffer.byteLength(archiveBody)) });
	}

	if (process.env.TEST_NOCK_EXPECT_SAVE === 'true') {
		cacheScope
			.post('/_apis/artifactcache/caches')
			.reply(201, { cacheId: 42 })
			.patch('/_apis/artifactcache/caches/42')
			.reply(204)
			.post('/_apis/artifactcache/caches/42')
			.reply(204);
	}

	process.on('exit', () => {
		writeFileSync(reportPath, JSON.stringify({
			pending: nock.pendingMocks(),
			requests,
		}));
	});
}
