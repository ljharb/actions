'use strict';

/* eslint max-lines-per-function: 0, max-statements: 0, sort-keys: 0 */

var parse = require('url').parse;
var http = require('http');
var https = require('https');
var Buffer = require('safe-buffer').Buffer;
var regexTester = require('safe-regex-test');

var isHTTPx = regexTester(/^https?:/i);
var isHTTPS = regexTester(/^https:/i);

var phinish = function (addr, cb) {
	var protocolIsHTTPS = isHTTPS(addr.protocol);

	var options = {
		hostname: addr.hostname,
		port: addr.port || (protocolIsHTTPS ? 443 : 80),
		path: addr.path,
		method: 'GET',
		headers: {},
		auth: addr.auth || null,
		parse: 'none',
		stream: false
	};

	var resHandler = function (res) {
		/* eslint no-param-reassign: 0 */
		res.body = Buffer.from([]);
		res.on('data', function (chunk) {
			res.body = Buffer.concat([res.body, chunk]);
		});
		res.on('end', function () {
			cb(null, res);
		});
	};

	var req = (protocolIsHTTPS ? https : http).request(options, resHandler);

	req.on('error', function (err) {
		cb(err, null);
	});

	req.end();
};

module.exports = function getJSON(url, callback) {
	return new Promise(function (resolve, reject) {
		if (typeof url !== 'string') {
			throw new TypeError('`url` is not a string');
		}

		var addr = parse(url);

		if (!isHTTPx(addr.protocol)) {
			reject(new Error('Invalid / unknown URL protocol. Expected HTTP or HTTPS, got `' + addr.protocol + '`'), null);
			return;
		}

		phinish(addr, function (error, response) {
			if (error) {
				reject(error);
				if (callback) {
					callback(error);
				}
			} else {
				try {
					var body = JSON.parse(response.body);

					if (response.statusCode == 200) {
						resolve(body);
						if (callback) {
							callback(null, body);
						}
					} else {
						reject('Unexpected response code ' + response.statusCode);
					}
				} catch (parseError) {
					reject('Parse error: ' + parseError);
				}
			}
		});
	});
};
