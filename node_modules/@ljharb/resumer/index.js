'use strict';

var through = require('@ljharb/through');

var nextTick = typeof setImmediate === 'undefined'
	? process.nextTick
	: setImmediate;

var callBind = require('call-bind');

/** @type {import('.')} */
module.exports = function resumer(write, end) {
	var tr = through(write, end);
	tr.pause();
	var resume = callBind.apply(tr.resume);
	var pause = callBind.apply(tr.pause);
	var paused = false;

	tr.pause = function () {
		paused = true;
		// @ts-expect-error https://github.com/microsoft/TypeScript/issues/57164
		return pause(this, arguments);
	};

	tr.resume = function () {
		paused = false;
		// @ts-expect-error https://github.com/microsoft/TypeScript/issues/57164
		return resume(this, arguments);
	};

	nextTick(function () {
		if (!paused) { tr.resume(); }
	});

	return tr;
};
