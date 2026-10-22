'use strict';

/** @type {() => Promise<void>} */
module.exports = function () {
	// @ts-expect-error ts(2307) this is a data URI
	const promise = import('data:text/javascript,');
	promise.catch(() => {});
	return promise;
};
