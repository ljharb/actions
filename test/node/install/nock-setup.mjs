// Preloaded via `node --import` into child processes; it does nothing unless `NOCK_SETUP_REPORT` is set.
import fs from 'fs';

import nock from 'nock';

export const NVM_TAG = 'v0.40.3';
export const CACHE_URL = 'https://cache.example.test/';
export const ARCHIVE_URL = 'https://archive.example.test/cache.tgz';

const reportFile = process.env.NOCK_SETUP_REPORT;

if (reportFile) {
	nock.disableNetConnect();

	/** @type {{ method: string, url: string, body: string }[]} */
	const requests = [];
	/** @type {string[]} */
	const unmatched = [];

	nock.emitter.on('no match', (/** @type {Request} */ req) => {
		unmatched.push(`${req.method} ${req.url}`);
	});

	/** @type {(scope: nock.Scope) => nock.Scope} */
	const record = (scope) => scope.on('request', (/** @type {Request} */ req, /** @type {unknown} */ _interceptor, /** @type {string} */ body) => {
		requests.push({
			method: req.method,
			url: req.url,
			body,
		});
	});

	const latestStatus = Number(process.env.NOCK_SETUP_LATEST_STATUS || 302);
	record(nock('https://github.com'))
		.get('/nvm-sh/nvm/releases/latest')
		.reply(latestStatus, '', latestStatus === 302 ? { location: `https://github.com/nvm-sh/nvm/releases/tag/${NVM_TAG}` } : {});

	if (latestStatus === 302) {
		record(nock('https://raw.githubusercontent.com'))
			.get(`/nvm-sh/nvm/${NVM_TAG}/nvm.sh`)
			.reply(200, '# fake nvm.sh\n')
			.get(`/nvm-sh/nvm/${NVM_TAG}/nvm-exec`)
			.reply(200, '# fake nvm-exec\n');
	}

	const cacheMode = process.env.NOCK_SETUP_CACHE;
	if (cacheMode === 'miss') {
		record(nock(CACHE_URL))
			.get('/_apis/artifactcache/cache')
			.query(true)
			.reply(204);
	} else if (cacheMode === 'hit') {
		record(nock(CACHE_URL))
			.get('/_apis/artifactcache/cache')
			.query(true)
			.reply(200, {
				archiveLocation: ARCHIVE_URL,
				cacheKey: process.env.NOCK_SETUP_RESTORED_KEY,
			})
			.post('/_apis/artifactcache/caches')
			.reply(201, { cacheId: 42 })
			.patch('/_apis/artifactcache/caches/42')
			.reply(204)
			.post('/_apis/artifactcache/caches/42')
			.reply(204);
		record(nock('https://archive.example.test'))
			.get('/cache.tgz')
			.reply(200, 'fake archive');
	}

	process.on('exit', () => {
		fs.writeFileSync(reportFile, JSON.stringify({
			pending: nock.pendingMocks(),
			requests,
			unmatched,
		}));
	});
}
