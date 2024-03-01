'use strict';

const https = require('https');

/** @type {() => Promise<string>} */
module.exports = async function getLatestNVM() {
	return new Promise((resolve) => {
		https.get('https://github.com/nvm-sh/nvm/releases/latest', (res) => {
			if (res.statusCode === 302) {
				// eslint-disable-next-line no-extra-parens
				resolve(/** @type {NonNullable<typeof res.headers.location>} */ (res.headers.location).split('/').slice(-1)[0]);
			} else {
				throw res;
			}
		});
	});
};
