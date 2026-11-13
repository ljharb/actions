import https from 'https';

/** @type {() => Promise<string>} */
export default async function getLatestNVM() {
	return new Promise((resolve) => {
		https.get('https://github.com/nvm-sh/nvm/releases/latest', (res) => {
			const { location } = res.headers;
			if (res.statusCode === 302 && typeof location === 'string') {
				resolve(location.split('/').slice(-1)[0]);
			} else {
				throw res;
			}
		});
	});
}
