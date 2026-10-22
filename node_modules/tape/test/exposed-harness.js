'use strict';

var tape = require('../');
var tap = require('tap');

tap.test('main harness object is exposed', function (tt) {
	tt.equal(typeof tape.getHarness, 'function', 'tape.getHarness is a function');

	tt.equal(typeof tape.run, 'function', 'tape.run is a function');

	tt.equal(tape.getHarness()._results.pass, 0);

	tt.equal(tape.getHarness().run, undefined, 'tape.getHarness().run is undefined (wait not called)');

	tt.end();
});
