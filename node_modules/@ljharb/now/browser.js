'use strict';

var callBind = require('call-bind-apply-helpers');
var callBound = require('call-bound');
var GetIntrinsic = require('get-intrinsic');

var $getTime = callBound('Date.prototype.getTime');
var $Date = GetIntrinsic('%Date%');
var $now = GetIntrinsic('%Date.now%', true);

/** @type {import('./browser')} */
module.exports = (function () {
	if (
		typeof performance !== 'undefined'
		&& performance
		&& typeof performance.now === 'function'
	) {
		return callBind([performance.now, performance]);
	}

	return $now || function now() {
		return $getTime(new $Date());
	};
}());
