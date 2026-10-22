// Preloaded via `node --import` into the `node/matrix` child process; inert unless `NODE_MATRIX_NOCK` is set, so tape can load it harmlessly.
import { readFileSync } from 'fs';

import nock from 'nock';

const mode = process.env.NODE_MATRIX_NOCK;

if (mode) {
	nock.disableNetConnect();

	/** @type {(name: string) => unknown} */
	const fixture = (name) => JSON.parse(readFileSync(new URL(`${name}.json`, import.meta.url), 'utf8'));

	const scope = nock('https://raw.githubusercontent.com');
	if (mode === 'fail') {
		scope.get('/ljharb/actions/nodejs/index.json').reply(500, 'nope');
		scope.get('/ljharb/actions/iojs/index.json').optionally().reply(500, 'nope');
	} else {
		scope.get('/ljharb/actions/nodejs/index.json').reply(200, fixture('nodejs'));
		scope.get('/ljharb/actions/iojs/index.json').reply(200, fixture('iojs'));
	}

	process.on('exit', () => {
		process.stderr.write(`NOCK_PENDING=${JSON.stringify(scope.pendingMocks())}\n`);
	});
}
