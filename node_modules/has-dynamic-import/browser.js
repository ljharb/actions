'use strict';

var callBound = require('call-bound');
var $then = callBound('Promise.prototype.then', true);

var pFalse = $then && Promise.resolve(false);
/** @type {() => false} */
var thunkFalse = function () {
	return false;
};
/** @type {() => true} */
var thunkTrue = function () {
	return true;
};

/** @type {() => PromiseLike<boolean>} */
module.exports = function hasDynamicImport() {
	if (!$then) {
		return {
			__proto__: null,
			// @ts-expect-error ts(2322) TODO: fixme
			then: function (resolve) {
				// @ts-expect-error ts(2723) TODO: fixme
				resolve(false);
			}
		};
	}

	try {
		var promise = Function('return import("data:text/javascript,")')(); // eslint-disable-line no-new-func

		return $then(promise, thunkTrue, thunkFalse);
	} catch (e) {
		// eslint-disable-next-line no-extra-parens
		return /** @type {NonNullable<typeof pFalse>} */ (pFalse);
	}
};
