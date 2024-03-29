'use strict';

const fs = require('fs');
const https = require('https');

/** @type {(url: string, dest: fs.PathLike) => Promise<void>} */
module.exports = async function downloadFile(url, dest) {
	const file = fs.createWriteStream(dest);
	return new Promise((resolve) => {
		https.get(url, (response) => {
			response.pipe(file);

			file.on('finish', () => {
				file.close();
				resolve();
			});
		});
	});
};
