// Loaded via `node --import` into action child processes. It is a no-op unless
// `TEST_PRELOAD_CONFIG` is set, so tape importing it via the test glob is harmless.
import fs from 'fs';

import nock from 'nock';

/**
 * @typedef {{
 *   report: string,
 *   nvmVersion?: string,
 *   cache?: {
 *     url: string,
 *     mode: 'hit' | 'miss',
 *     key?: string,
 *     archive?: string,
 *     cacheId?: number,
 *   },
 * }} PreloadConfig
 */

/** @typedef {{ method: string, url: string, body: string }} RecordedRequest */

const rawConfig = process.env.TEST_PRELOAD_CONFIG;

if (rawConfig) {
	/** @type {PreloadConfig} */
	const config = JSON.parse(rawConfig);

	nock.disableNetConnect();

	/** @type {RecordedRequest[]} */
	const requests = [];

	/** @type {string[]} */
	const unmatched = [];

	nock.emitter.on('no match', (/** @type {Request} */ req) => {
		unmatched.push(`${req.method} ${req.url}`);
	});

	/** @type {(scope: nock.Scope) => nock.Scope} */
	const record = (scope) => scope.on('request', (req, _interceptor, body) => {
		requests.push({
			method: req.method,
			url: req.url,
			body: typeof body === 'string' ? body : String(body ?? ''),
		});
	});

	if (config.nvmVersion) {
		const tag = config.nvmVersion;
		record(nock('https://github.com'))
			.get('/nvm-sh/nvm/releases/latest')
			.reply(302, '', { location: `https://github.com/nvm-sh/nvm/releases/tag/${tag}` });
		record(nock('https://raw.githubusercontent.com'))
			.get(`/nvm-sh/nvm/${tag}/nvm.sh`)
			.reply(200, `# fake nvm.sh ${tag}\n`)
			.get(`/nvm-sh/nvm/${tag}/nvm-exec`)
			.reply(200, `# fake nvm-exec ${tag}\n`);
	}

	if (config.cache) {
		const { cache } = config;
		const scope = record(nock(cache.url));
		if (cache.mode === 'miss') {
			scope
				.get('/_apis/artifactcache/cache')
				.query(true)
				.reply(204);
		} else {
			scope
				.get('/_apis/artifactcache/cache')
				.query(true)
				.reply(200, {
					cacheKey: cache.key,
					scope: 'refs/heads/main',
					archiveLocation: `${cache.url}archive.tgz`,
				})
				.get('/archive.tgz')
				// eslint-disable-next-line no-extra-parens
				.reply(200, () => fs.readFileSync(/** @type {string} */ (cache.archive)))
				.post('/_apis/artifactcache/caches')
				.optionally()
				.reply(201, { cacheId: cache.cacheId })
				.patch(`/_apis/artifactcache/caches/${cache.cacheId}`)
				.optionally()
				.reply(204)
				.post(`/_apis/artifactcache/caches/${cache.cacheId}`)
				.optionally()
				.reply(204);
		}
	}

	process.on('exit', () => {
		fs.writeFileSync(config.report, JSON.stringify({
			requests,
			unmatched,
			pending: nock.pendingMocks(),
		}));
	});
}
