import fs from 'fs';
import https from 'https';

/** @type {(url: string, dest: fs.PathLike) => Promise<void>} */
export default async function downloadFile(url, dest) {
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
}
