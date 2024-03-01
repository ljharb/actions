'use strict';

const https = require('https');

module.exports = async function getLatestNVM() {
	return new Promise((resolve) => {
		https.get('https://github.com/nvm-sh/nvm/releases/latest', (res) => {
			if (res.statusCode === 302) {
				resolve(res.headers.location.split('/').slice(-1)[0]);
			} else {
				throw res;
			}
		});
	});
};
