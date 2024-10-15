'use strict';

var jsonp = require('jsonp');

module.exports = function getJSON(url, callback) {
	return new Promise(function (resolve, reject) {
		if (typeof url !== 'string') {
			throw new TypeError('`url` is not a string');
		}

		jsonp(url, function (error, body) {
			if (error) {
				reject(error);
				if (callback) {
					callback(error);
				}
			} else {
				resolve(body);
				if (callback) {
					callback(null, body);
				}
			}
		});
	});
};
