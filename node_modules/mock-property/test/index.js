'use strict';

var test = require('tape');
var hasPropertyDescriptors = require('has-property-descriptors')();
var v = require('es-value-fixtures');
var forEach = require('for-each');
var inspect = require('object-inspect');
var hasSymbols = require('has-symbols')();
var gOPD = /** @type {NonNullable<typeof import('gopd')>} */ (require('gopd'));

/** @import { Getter, Setter } from '../' */

var mockProperty = require('../');

var sentinel = { sentinel: true };
/** @type {Getter<unknown>} */
var getter = function () {};
/** @type {Setter<unknown>} */
var setter = function (value) { value; }; // eslint-disable-line no-unused-expressions

var props = /** @type {PropertyKey[]} */ ([]).concat(
	'string property',
	hasSymbols ? Symbol.iterator : []
);

test('mockProperty', function (t) {
	t.equal(typeof mockProperty, 'function', 'is a function');

	t.test('errors', function (st) {
		/** @type {Record<typeof p, unknown>} */
		var o = {};
		var p = 'property';

		forEach(v.nonBooleans, function (nonBoolean) {
			st['throws'](
				// @ts-expect-error
				function () { mockProperty(o, p, { nonEnumerable: nonBoolean }); },
				TypeError,
				'nonEnumerable: ' + inspect(nonBoolean) + ' is not a boolean'
			);
			st['throws'](
				// @ts-expect-error
				function () { mockProperty(o, p, { nonWritable: nonBoolean }); },
				TypeError,
				'nonWritable: ' + inspect(nonBoolean) + ' is not a boolean'
			);
			st['throws'](
				// @ts-expect-error
				function () { mockProperty(o, p, { 'delete': nonBoolean }); },
				TypeError,
				'delete: ' + inspect(nonBoolean) + ' is not a boolean'
			);
		});

		st['throws'](
			function () { mockProperty(o, p, { get: function () {}, value: undefined }); },
			TypeError,
			'get and value are mutually exclusive'
		);
		st['throws'](
			function () { mockProperty(o, p, { set: function () {}, value: undefined }); },
			TypeError,
			'set and value are mutually exclusive'
		);
		st['throws'](
			// @ts-expect-error
			function () { mockProperty(o, p, { get: function () {}, nonWritable: true }); },
			TypeError,
			'get and nonWritable are mutually exclusive'
		);
		st['throws'](
			// @ts-expect-error
			function () { mockProperty(o, p, { set: function () {}, nonWritable: true }); },
			TypeError,
			'set and nonWritable are mutually exclusive'
		);

		forEach(v.nonFunctions, function (nonFunction) {
			st['throws'](
				// @ts-expect-error
				function () { mockProperty(o, p, { get: nonFunction }); },
				TypeError,
				'get: ' + inspect(nonFunction) + ' is not a function'
			);
			st['throws'](
				// @ts-expect-error
				function () { mockProperty(o, p, { set: nonFunction }); },
				TypeError,
				'set: ' + inspect(nonFunction) + ' is not a function'
			);
		});

		// these lack ts-expect-error, because TS can't differentiate undefined and absent
		st['throws'](
			function () { mockProperty(o, p, { 'delete': true, get: undefined }); },
			TypeError,
			'delete and get are mutually exclusive'
		);
		st['throws'](
			function () { mockProperty(o, p, { 'delete': true, set: undefined }); },
			TypeError,
			'delete and set are mutually exclusive'
		);
		st['throws'](
			function () { mockProperty(o, p, { 'delete': true, value: undefined }); },
			TypeError,
			'delete and value are mutually exclusive'
		);
		st['throws'](
			function () { mockProperty(o, p, { 'delete': true, nonWritable: undefined }); },
			TypeError,
			'delete and nonWritable are mutually exclusive'
		);
		st['throws'](
			function () { mockProperty(o, p, { 'delete': true, nonEnumerable: undefined }); },
			TypeError,
			'delete and nonEnumerable are mutually exclusive'
		);

		st.end();
	});

	t.test('data -> data', function (st) {
		forEach(props, function (p) {
			/** @type {Record<typeof p, unknown>} */
			var obj = {};
			obj[p] = sentinel;

			st.comment('mockProperty(…): ' + inspect(p));
			var restore = mockProperty(obj, p, { value: obj });

			st.ok(p in obj, 'property still exists');
			st.equal(obj[p], obj, 'obj has expected value');

			st.comment('restore: ' + inspect(p));
			restore();

			st.ok(p in obj, 'property is restored');
			st.equal(obj[p], sentinel, 'data property holds sentinel');
		});

		st.end();
	});

	t.test('data: enumerable -> nonEnumerable', { skip: !hasPropertyDescriptors }, function (st) {
		forEach(props, function (p) {
			/** @type {Record<typeof p, unknown>} */
			var obj = {};
			obj[p] = sentinel;
			st.ok(Object.prototype.propertyIsEnumerable.call(obj, p), 'starts enumerable');

			st.comment('mockProperty(…): ' + inspect(p));
			var restore = mockProperty(obj, p, { nonEnumerable: true });

			st.ok(p in obj, 'property still exists');
			st.equal(obj[p], sentinel, 'data property still holds sentinel');
			st.notOk(Object.prototype.propertyIsEnumerable.call(obj, p), 'is not enumerable');

			st.comment('restore: ' + inspect(p));
			restore();

			st.ok(p in obj, 'property is restored');
			st.equal(obj[p], sentinel, 'data property again holds sentinel');
			st.ok(Object.prototype.propertyIsEnumerable.call(obj, p), 'ends enumerable');
		});

		st.end();
	});

	t.test('data -> absent', function (st) {
		forEach(props, function (p) {
			/** @type {Record<typeof p, unknown>} */
			var obj = {};
			obj[p] = sentinel;

			st.comment('mockProperty(…): ' + inspect(p));
			var restore = mockProperty(obj, p, { 'delete': true });

			st.notOk(p in obj, 'property is deleted');

			st.comment('restore: ' + inspect(p));
			restore();

			st.ok(p in obj, 'property is restored');
			st.equal(obj[p], sentinel, 'object value is restored to sentinel');
		});

		st.end();
	});

	t.test('absent -> data', function (st) {
		forEach(props, function (p) {
			/** @type {Record<typeof p, unknown>} */
			var obj = {};

			st.notOk(p in obj, 'property is initially absent');

			st.comment('mockProperty(…): ' + inspect(p));

			var restore = mockProperty(obj, p, { value: sentinel });

			st.ok(p in obj, 'property exists');
			st.equal(obj[p], sentinel, 'data property holds sentinel');

			st.comment('restore: ' + inspect(p));
			restore();

			st.notOk(p in obj, 'property is absent again');
		});

		st.end();
	});

	t.test('absent -> absent', function (st) {
		forEach(props, function (p) {
			/** @type {Record<typeof p, unknown>} */
			var obj = {};

			st.notOk(p in obj, 'property is initially absent');

			st.comment('mockProperty(…): ' + inspect(p));
			var restore = mockProperty(obj, p, { 'delete': true });

			st.notOk(p in obj, 'property still does not exist');

			st.comment('restore: ' + inspect(p));
			restore();

			st.notOk(p in obj, 'property remains absent');
		});

		st.end();
	});

	t.test('inherited -> data', function (st) {
		forEach(props, function (p) {
			/** @type {Record<typeof p, unknown>} */
			var proto = {};
			proto[p] = sentinel;
			/** @type {Record<typeof p, unknown>} */
			var obj = { __proto__: proto };

			st.ok(p in obj, 'property is initially present, via the prototype');
			st.notOk(Object.prototype.hasOwnProperty.call(obj, p), 'property is not initially an own property');

			st.comment('mockProperty(…): ' + inspect(p));
			var restore = mockProperty(obj, p, { value: obj });

			st.ok(p in obj, 'property still exists');
			st.equal(obj[p], obj, 'obj has the mocked value');
			st.equal(proto[p], sentinel, 'the prototype is untouched');

			st.deepEqual(
				hasPropertyDescriptors && gOPD(obj, p),
				{
					configurable: true,
					enumerable: true,
					value: obj,
					writable: true
				},
				'has the right descriptor',
				{ skip: !hasPropertyDescriptors }
			);

			st.comment('restore: ' + inspect(p));
			restore();

			st.ok(p in obj, 'property is restored, via the prototype');
			st.notOk(Object.prototype.hasOwnProperty.call(obj, p), 'mocked own property is removed on restore');
			st.equal(obj[p], sentinel, 'inherited value is visible again');
		});

		st.end();
	});

	t.test('getter', { skip: !hasPropertyDescriptors }, function (st) {
		st.test('data: nonconfigurable, nonwritable, change value', function (s2t) {
			forEach(props, function (p) {
				/** @type {Record<typeof p, unknown>} */
				var o = {};
				o[p] = sentinel;
				Object.defineProperty(o, p, { configurable: false, writable: false });
				s2t.deepEqual(
					gOPD(o, p),
					{
						configurable: false,
						enumerable: true,
						value: sentinel,
						writable: false
					},
					'precondition: expected descriptor: ' + inspect(p)
				);

				s2t['throws'](
					function () { mockProperty(o, p, { value: 42 }); },
					TypeError,
					'nonconfigurable property throws: ' + inspect(p)
				);
			});

			s2t.end();
		});

		st.test('data: nonconfigurable, nonwritable, same value', function (s2t) {
			forEach(props, function (p) {
				/** @type {Record<typeof p, unknown>} */
				var o = {};
				o[p] = sentinel;
				Object.defineProperty(o, p, { configurable: false, writable: false });
				s2t.deepEqual(
					gOPD(o, p),
					{
						configurable: false,
						enumerable: true,
						value: sentinel,
						writable: false
					},
					'precondition: expected descriptor: ' + inspect(p)
				);

				s2t.doesNotThrow(
					function () { mockProperty(o, p, { value: sentinel }); },
					'same value is a noop: ' + inspect(p)
				);
			});

			s2t.end();
		});

		st.test('data: nonconfigurable, writable, change value', function (s2t) {
			forEach(props, function (p) {
				/** @type {Record<typeof p, unknown>} */
				var o = {};
				o[p] = sentinel;
				Object.defineProperty(o, p, { configurable: false, writable: true });
				s2t.deepEqual(
					gOPD(o, p),
					{
						configurable: false,
						enumerable: true,
						value: sentinel,
						writable: true
					},
					'precondition: expected descriptor: ' + inspect(p)
				);

				s2t.doesNotThrow(
					function () { mockProperty(o, p, { value: { wrong: true } })(); },
					'writable property can change value: ' + inspect(p)
				);
				s2t.deepEqual(
					gOPD(o, p),
					{
						configurable: false,
						enumerable: true,
						value: sentinel,
						writable: true
					},
					'postcondition: expected descriptor: ' + inspect(p)
				);
			});

			s2t.end();
		});

		st.test('data: nonconfigurable, writable, change writability', function (s2t) {
			forEach(props, function (p) {
				/** @type {Record<typeof p, unknown>} */
				var o = {};
				o[p] = sentinel;
				Object.defineProperty(o, p, { configurable: false, writable: true });
				s2t.deepEqual(
					gOPD(o, p),
					{
						configurable: false,
						enumerable: true,
						value: sentinel,
						writable: true
					},
					'precondition: expected descriptor: ' + inspect(p)
				);

				s2t['throws'](
					function () { mockProperty(o, p, { nonWritable: true }); },
					TypeError,
					'nonconfigurable property throws: ' + inspect(p)
				);
			});

			s2t.end();
		});

		st.test('data: nonconfigurable, nonwritable, change writability', function (s2t) {
			forEach(props, function (p) {
				/** @type {Record<typeof p, unknown>} */
				var o = {};
				o[p] = sentinel;
				Object.defineProperty(o, p, { configurable: false, writable: false });
				s2t.deepEqual(
					gOPD(o, p),
					{
						configurable: false,
						enumerable: true,
						value: sentinel,
						writable: false
					},
					'precondition: expected descriptor: ' + inspect(p)
				);

				s2t['throws'](
					function () { mockProperty(o, p, { nonWritable: false }); },
					TypeError,
					'nonconfigurable property throws: ' + inspect(p)
				);
			});

			s2t.end();
		});

		st.test('data: nonconfigurable, writable, nonenumerable', function (s2t) {
			forEach(props, function (p) {
				/** @type {Record<typeof p, unknown>} */
				var o = {};
				o[p] = sentinel;
				Object.defineProperty(o, p, { configurable: false, enumerable: false, writable: true });
				s2t.deepEqual(
					gOPD(o, p),
					{
						configurable: false,
						enumerable: false,
						value: sentinel,
						writable: true
					},
					'precondition: expected descriptor: ' + inspect(p)
				);

				s2t.doesNotThrow(
					function () { mockProperty(o, p, { nonEnumerable: true })(); },
					'nonconfigurable nonenumerable, to nonenumerable, is a noop: ' + inspect(p)
				);

				s2t['throws'](
					function () { mockProperty(o, p, { nonEnumerable: false })(); },
					TypeError,
					'nonconfigurable nonenumerable, to enumerable, throws: ' + inspect(p)
				);
			});

			s2t.end();
		});

		st.test('data: nonconfigurable, writable, enumerable', function (s2t) {
			forEach(props, function (p) {
				/** @type {Record<typeof p, unknown>} */
				var o = {};
				o[p] = sentinel;
				Object.defineProperty(o, p, { configurable: false, enumerable: true, writable: true });
				s2t.deepEqual(
					gOPD(o, p),
					{
						configurable: false,
						enumerable: true,
						value: sentinel,
						writable: true
					},
					'precondition: expected descriptor: ' + inspect(p)
				);

				s2t.doesNotThrow(
					function () { mockProperty(o, p, { nonEnumerable: false })(); },
					'nonconfigurable enumerable, to enumerable, is a noop: ' + inspect(p)
				);

				s2t['throws'](
					function () { mockProperty(o, p, { nonEnumerable: true }); },
					TypeError,
					'nonconfigurable enumerable, to nonenumerable, throws: ' + inspect(p)
				);
			});

			s2t.end();
		});

		st.test('nonconfigurable data -> accessor', function (s2t) {
			forEach(props, function (p) {
				/** @type {Record<typeof p, unknown>} */
				var o = {};
				o[p] = sentinel;
				Object.defineProperty(o, p, { configurable: false });
				s2t.deepEqual(
					gOPD(o, p),
					{
						configurable: false,
						enumerable: true,
						value: sentinel,
						writable: true
					},
					'precondition: expected descriptor: ' + inspect(p)
				);

				s2t['throws'](
					function () { mockProperty(o, p, { get: getter }); },
					TypeError,
					'nonconfigurable data, with getter, throws: ' + inspect(p)
				);

				s2t['throws'](
					function () { mockProperty(o, p, { set: setter }); },
					TypeError,
					'nonconfigurable data, with getter, throws: ' + inspect(p)
				);

				s2t['throws'](
					function () { mockProperty(o, p, { get: getter, set: setter }); },
					TypeError,
					'nonconfigurable data, with both, throws: ' + inspect(p)
				);
			});

			s2t.end();
		});

		st.test('nonconfigurable accessor -> data', function (s2t) {
			forEach(props, function (p) {
				/** @type {Record<typeof p, unknown>} */
				var o = {};
				o[p] = sentinel;
				Object.defineProperty(o, p, { configurable: false, get: getter, set: setter });
				s2t.deepEqual(
					gOPD(o, p),
					{
						configurable: false,
						enumerable: true,
						get: getter,
						set: setter
					},
					'precondition: expected descriptor: ' + inspect(p)
				);

				s2t['throws'](
					function () { mockProperty(o, p, { value: sentinel }); },
					TypeError,
					'nonconfigurable both, with data, throws: ' + inspect(p)
				);
			});

			s2t.end();
		});

		st.test('accessor: nonconfigurable', function (s2t) {
			forEach(props, function (p) {
				/** @type {Record<typeof p, unknown>} */
				var o = {};
				o[p] = sentinel;
				Object.defineProperty(o, p, { configurable: false, get: getter, set: setter });
				s2t.deepEqual(
					gOPD(o, p),
					{
						configurable: false,
						enumerable: true,
						get: getter,
						set: setter
					},
					'precondition: expected descriptor: ' + inspect(p)
				);

				s2t.doesNotThrow(
					function () { mockProperty(o, p, { get: getter })(); },
					'same getter is a noop: ' + inspect(p)
				);

				s2t.doesNotThrow(
					function () { mockProperty(o, p, { set: setter })(); },
					'same setter is a noop: ' + inspect(p)
				);

				s2t['throws'](
					function () { mockProperty(o, p, { get: function () {} }); },
					TypeError,
					'nonconfigurable both, changing getter, throws: ' + inspect(p)
				);

				s2t['throws'](
					function () { mockProperty(o, p, { set: function (value) { value; } }); }, // eslint-disable-line no-unused-expressions
					TypeError,
					'nonconfigurable both, changing setter, throws: ' + inspect(p)
				);

				s2t['throws'](
					function () { mockProperty(o, p, { nonEnumerable: true }); },
					TypeError,
					'nonconfigurable both, changing setter, throws: ' + inspect(p)
				);
			});

			s2t.end();
		});

		st.test('getter -> getter', function (s2t) {
			forEach(props, function (p) {
				var calls = 0;
				/** @type {Record<typeof p, unknown>} */
				var obj = {};
				obj[p] = 1;
				Object.defineProperty(obj, p, {
					get: function () {
						calls += 1;
						return 'calls: ' + calls;
					}
				});

				s2t.ok(p in obj, 'property ' + inspect(p) + ' exists');
				s2t.equal(obj[p], 'calls: 1', 'getter returns 1 call');

				s2t.comment('mockProperty(…): ' + inspect(p));
				var restore = mockProperty(obj, p, {
					get: function () {
						calls += 100;
						return 'calls: ' + calls;
					}
				});

				s2t.ok(p in obj, 'property ' + inspect(p) + ' still exists');
				s2t.equal(obj[p], 'calls: 101', 'getter returns 101 calls');

				s2t.comment('restore: ' + inspect(p));
				restore();

				s2t.ok(p in obj, 'property ' + inspect(p) + ' still exists');
				s2t.equal(obj[p], 'calls: 102', 'getter returns 102 calls');
			});

			s2t.end();
		});

		st.test('getter -> setter', function (s2t) {
			forEach(props, function (p) {
				var calls = 0;
				/** @type {Record<typeof p, unknown>} */
				var obj = {};
				obj[p] = 1;
				Object.defineProperty(obj, p, {
					get: function () {
						calls += 1;
						return 'calls: ' + calls;
					}
				});

				s2t.ok(p in obj, 'property ' + inspect(p) + ' exists');
				s2t.equal(obj[p], 'calls: 1', 'getter returns 1 call');

				var holder;
				s2t.comment('mockProperty(…): ' + inspect(p));
				var restore = mockProperty(obj, p, {
					get: undefined,
					set: function (value) {
						holder = 'holder mocked: ' + value;
					}
				});

				s2t.ok(p in obj, 'property ' + inspect(p) + ' still exists');
				obj[p] = 'second';
				s2t.equal(holder, 'holder mocked: second', 'setter was invoked ("second")');
				s2t.equal(obj[p], undefined, 'getter returns undefined');

				s2t.comment('restore: ' + inspect(p));
				restore();

				s2t.ok(p in obj, 'property ' + inspect(p) + ' still exists');
				s2t.equal(obj[p], 'calls: 2', 'getter returns 2 calls');
			});

			s2t.end();
		});

		st.test('getter -> both', function (s2t) {
			forEach(props, function (p) {
				var calls = 0;
				/** @type {Record<typeof p, unknown>} */
				var obj = {};
				obj[p] = 1;
				Object.defineProperty(obj, p, {
					get: function () {
						calls += 1;
						return 'calls: ' + calls;
					}
				});

				s2t.ok(p in obj, 'property ' + inspect(p) + ' exists');
				s2t.equal(obj[p], 'calls: 1', 'getter returns 1 call');

				var holder;

				s2t.comment('mockProperty(…): ' + inspect(p));
				var restore = mockProperty(obj, p, {
					set: function (value) {
						holder = 'holder mocked: ' + value;
					}
				});

				s2t.ok(p in obj, 'property ' + inspect(p) + ' still exists');
				obj[p] = 'second';
				s2t.equal(holder, 'holder mocked: second', 'setter was invoked ("second")');
				s2t.equal(obj[p], 'calls: 2', 'getter returns 2 calls');

				s2t.comment('restore: ' + inspect(p));
				restore();

				s2t.ok(p in obj, 'property ' + inspect(p) + ' still exists');
				s2t.equal(holder, 'holder mocked: second', 'setter was not invoked ("third")');
				s2t.equal(obj[p], 'calls: 3', 'getter returns 3 calls');
			});

			s2t.end();
		});

		st.test('getter -> data', function (s2t) {
			forEach(props, function (p) {
				var calls = 0;
				/** @type {Record<typeof p, unknown>} */
				var obj = {};
				obj[p] = 1;
				Object.defineProperty(obj, p, {
					get: function () {
						calls += 1;
						return 'calls: ' + calls;
					}
				});

				s2t.ok(p in obj, 'property ' + inspect(p) + ' exists');
				s2t.equal(obj[p], 'calls: 1', 'getter returns 1 call');

				s2t.comment('mockProperty(…): ' + inspect(p));
				var restore = mockProperty(obj, p, { value: sentinel });

				s2t.ok(p in obj, 'property ' + inspect(p) + ' still exists');
				s2t.equal(obj[p], sentinel, 'data property holds sentinel');

				s2t.comment('restore: ' + inspect(p));
				restore();

				s2t.ok(p in obj, 'property ' + inspect(p) + ' still exists');
				s2t.equal(obj[p], 'calls: 2', 'getter returns 2 calls');
			});

			s2t.end();
		});

		st.test('getter -> absent', function (s2t) {
			forEach(props, function (p) {
				var calls = 0;
				/** @type {Record<typeof p, unknown>} */
				var obj = {};
				obj[p] = 1;
				Object.defineProperty(obj, p, {
					get: function () {
						calls += 1;
						return 'calls: ' + calls;
					}
				});

				s2t.ok(p in obj, 'property ' + inspect(p) + ' exists');
				s2t.equal(obj[p], 'calls: 1', 'getter returns 1 call');

				s2t.comment('mockProperty(…): ' + inspect(p));
				var restore = mockProperty(obj, p, { 'delete': true });

				s2t.notOk(p in obj, 'property ' + inspect(p) + ' is deleted');

				s2t.comment('restore: ' + inspect(p));
				restore();

				s2t.ok(p in obj, 'property ' + inspect(p) + ' still exists');
				s2t.equal(obj[p], 'calls: 2', 'getter returns 2 calls');
			});

			s2t.end();
		});

		st.test('setter -> getter', function (s2t) {
			forEach(props, function (p) {
				var calls = 0;
				var holder;
				/** @type {Record<typeof p, unknown>} */
				var obj = {};
				obj[p] = 1;
				Object.defineProperty(obj, p, {
					set: function (value) {
						holder = 'holder: ' + value;
					}
				});

				s2t.ok(p in obj, 'property ' + inspect(p) + ' exists');
				obj[p] = 'first';
				s2t.equal(holder, 'holder: first', 'setter was invoked ("first")');
				s2t.equal(obj[p], undefined, 'getter returns undefined');

				s2t.comment('mockProperty(…): ' + inspect(p));
				var restore = mockProperty(obj, p, {
					get: function () {
						calls += 1;
						return 'calls: ' + calls;
					},
					set: undefined
				});

				s2t.ok(p in obj, 'property ' + inspect(p) + ' still exists');
				s2t.equal(obj[p], 'calls: 1', 'getter returns 1 calls');
				s2t['throws'](
					function () { obj[p] = 42; },
					TypeError,
					'no setter, throws'
				);

				s2t.comment('restore: ' + inspect(p));
				restore();

				s2t.ok(p in obj, 'property ' + inspect(p) + ' still exists');
				obj[p] = 'third';
				s2t.equal(holder, 'holder: third', 'setter was invoked ("third")');
				s2t.equal(obj[p], undefined, 'getter returns undefined');
			});

			s2t.end();
		});

		st.test('setter -> both', function (s2t) {
			forEach(props, function (p) {
				var calls = 0;
				var holder;
				/** @type {Record<typeof p, unknown>} */
				var obj = {};
				obj[p] = 1;
				Object.defineProperty(obj, p, {
					set: function (value) {
						holder = 'holder: ' + value;
					}
				});

				s2t.ok(p in obj, 'property ' + inspect(p) + ' exists');
				obj[p] = 'first';
				s2t.equal(holder, 'holder: first', 'setter was invoked ("first")');
				s2t.equal(obj[p], undefined, 'no getter, undefined');

				s2t.comment('mockProperty(…): ' + inspect(p));
				var restore = mockProperty(obj, p, {
					get: function () {
						calls += 1;
						return 'calls: ' + calls;
					}
				});

				s2t.ok(p in obj, 'property ' + inspect(p) + ' still exists');
				obj[p] = 'second';
				s2t.equal(holder, 'holder: second', 'setter was invoked ("second")');
				s2t.equal(obj[p], 'calls: 1', 'getter returns 1 calls');

				s2t.comment('restore: ' + inspect(p));
				restore();

				s2t.ok(p in obj, 'property ' + inspect(p) + ' still exists');
				obj[p] = 'third';
				s2t.equal(holder, 'holder: third', 'setter was invoked ("third")');
				s2t.equal(obj[p], undefined, 'no getter, undefined');
			});

			s2t.end();
		});

		st.test('setter -> setter', function (s2t) {
			forEach(props, function (p) {
				/** @type {Record<typeof p, unknown>} */
				var obj = {};
				obj[p] = 1;
				var holder;
				Object.defineProperty(obj, p, {
					set: function (value) {
						holder = 'holder: ' + value;
					}
				});

				s2t.ok(p in obj, 'property ' + inspect(p) + ' exists');
				obj[p] = 'first';
				s2t.equal(holder, 'holder: first', 'setter was invoked ("first")');

				s2t.comment('mockProperty(…): ' + inspect(p));
				var restore = mockProperty(obj, p, {
					set: function (value) {
						holder = 'holder mocked: ' + value;
					}
				});

				s2t.ok(p in obj, 'property ' + inspect(p) + ' exists');
				obj[p] = 'second';
				s2t.equal(holder, 'holder mocked: second', 'setter was invoked ("second")');

				s2t.comment('restore: ' + inspect(p));
				restore();

				s2t.ok(p in obj, 'property ' + inspect(p) + ' exists');
				obj[p] = 'third';
				s2t.equal(holder, 'holder: third', 'setter was invoked ("third")');
			});

			s2t.end();
		});

		st.test('setter -> data', function (s2t) {
			forEach(props, function (p) {
				/** @type {Record<typeof p, unknown>} */
				var obj = {};
				obj[p] = 1;
				var holder;
				Object.defineProperty(obj, p, {
					set: function (value) {
						holder = 'holder: ' + value;
					}
				});

				s2t.ok(p in obj, 'property ' + inspect(p) + ' exists');
				s2t.equal(obj[p], undefined, 'no getter, undefined');
				obj[p] = 'first';
				s2t.equal(holder, 'holder: first', 'setter was invoked ("first")');

				s2t.comment('mockProperty(…): ' + inspect(p));
				var restore = mockProperty(obj, p, {
					value: sentinel
				});

				s2t.ok(p in obj, 'property ' + inspect(p) + ' exists');
				s2t.equal(obj[p], sentinel, 'data property holds sentinel');
				obj[p] = 'second';
				s2t.equal(holder, 'holder: first', 'setter was not invoked ("second")');
				s2t.notEqual(obj[p], sentinel, 'data property no longer holds sentinel');

				s2t.comment('restore: ' + inspect(p));
				restore();

				s2t.ok(p in obj, 'property ' + inspect(p) + ' exists');
				s2t.equal(obj[p], undefined, 'no getter, undefined');
				obj[p] = 'third';
				s2t.equal(holder, 'holder: third', 'setter was invoked ("third")');
			});

			s2t.end();
		});

		st.test('setter -> absent', function (s2t) {
			forEach(props, function (p) {
				/** @type {Record<typeof p, unknown>} */
				var obj = {};
				obj[p] = 1;
				var holder;
				Object.defineProperty(obj, p, {
					set: function (value) {
						holder = 'holder: ' + value;
					}
				});

				s2t.ok(p in obj, 'property ' + inspect(p) + ' exists');
				obj[p] = 'first';
				s2t.equal(holder, 'holder: first', 'setter was invoked ("first")');

				s2t.comment('mockProperty(…): ' + inspect(p));
				var restore = mockProperty(obj, p, {
					'delete': true
				});

				s2t.notOk(p in obj, 'property ' + inspect(p) + ' no longer exists');

				s2t.comment('restore: ' + inspect(p));
				restore();

				s2t.ok(p in obj, 'property ' + inspect(p) + ' exists');
				obj[p] = 'third';
				s2t.equal(holder, 'holder: third', 'setter was invoked ("third")');
			});

			s2t.end();
		});

		st.test('data -> getter', function (s2t) {
			forEach(props, function (p) {
				var calls = 0;
				/** @type {Record<typeof p, unknown>} */
				var obj = {};
				obj[p] = sentinel;

				s2t.ok(p in obj, 'property ' + inspect(p) + ' exists');
				s2t.equal(obj[p], sentinel, 'data property holds sentinel');

				s2t.comment('mockProperty(…): ' + inspect(p));
				var restore = mockProperty(obj, p, {
					get: function () {
						calls += 100;
						return 'calls: ' + calls;
					}
				});

				s2t.ok(p in obj, 'property ' + inspect(p) + ' still exists');
				s2t.equal(obj[p], 'calls: 100', 'getter returns 100 calls');
				s2t['throws'](
					function () { obj[p] = 42; },
					TypeError,
					'no setter, throws'
				);

				s2t.comment('restore: ' + inspect(p));
				restore();

				s2t.ok(p in obj, 'property ' + inspect(p) + ' still exists');
				s2t.equal(obj[p], sentinel, 'data property holds sentinel');
			});

			s2t.end();
		});

		st.test('data -> setter', function (s2t) {
			forEach(props, function (p) {
				/** @type {Record<typeof p, unknown>} */
				var obj = {};
				obj[p] = sentinel;

				s2t.ok(p in obj, 'property ' + inspect(p) + ' exists');
				s2t.equal(obj[p], sentinel, 'data property holds sentinel');

				var holder;
				s2t.comment('mockProperty(…)');
				var restore = mockProperty(obj, p, {
					set: function (value) {
						holder = 'holder mocked: ' + value;
					}
				});

				s2t.ok(p in obj, 'property ' + inspect(p) + ' still exists');
				obj[p] = 'second';
				s2t.equal(holder, 'holder mocked: second', 'setter was invoked ("second")');
				s2t.equal(obj[p], undefined, 'no getter, undefined');

				s2t.comment('restore');
				restore();

				s2t.ok(p in obj, 'property ' + inspect(p) + ' still exists');
				s2t.equal(obj[p], sentinel, 'data property holds sentinel');
				s2t.equal(holder, 'holder mocked: second', 'setter was not invoked ("second")');
			});

			s2t.end();
		});

		st.test('data -> both', function (s2t) {
			forEach(props, function (p) {
				var calls = 0;
				/** @type {Record<typeof p, unknown>} */
				var obj = {};
				obj[p] = sentinel;

				s2t.ok(p in obj, 'property ' + inspect(p) + ' exists');
				s2t.equal(obj[p], sentinel, 'data property holds sentinel');

				var holder;
				s2t.comment('mockProperty(…): ' + inspect(p));
				var restore = mockProperty(obj, p, {
					get: function () {
						calls += 100;
						return 'calls: ' + calls;
					},
					set: function (value) {
						holder = 'holder mocked: ' + value;
					}
				});

				s2t.ok(p in obj, 'property ' + inspect(p) + ' still exists');
				obj[p] = 'second';
				s2t.equal(holder, 'holder mocked: second', 'setter was invoked ("second")');
				s2t.equal(obj[p], 'calls: 100', 'getter returns 100 calls');

				s2t.comment('restore: ' + inspect(p));
				restore();

				s2t.ok(p in obj, 'property ' + inspect(p) + ' still exists');
				s2t.equal(obj[p], sentinel, 'data property holds sentinel');
				s2t.equal(holder, 'holder mocked: second', 'setter was not invoked ("second")');
			});

			s2t.end();
		});

		st.test('absent -> getter', function (s2t) {
			forEach(props, function (p) {
				var calls = 0;
				/** @type {Record<typeof p, unknown>} */
				var obj = {};

				s2t.notOk(p in obj, 'property ' + inspect(p) + ' does not exist');

				s2t.comment('mockProperty(…): ' + inspect(p));
				var restore = mockProperty(obj, p, {
					get: function () {
						calls += 100;
						return 'calls: ' + calls;
					}
				});

				s2t.ok(p in obj, 'property ' + inspect(p) + ' exists');
				s2t.equal(obj[p], 'calls: 100', 'getter returns 100 calls');

				s2t.comment('restore: ' + inspect(p));
				restore();

				s2t.notOk(p in obj, 'property ' + inspect(p) + ' no longer exists');
			});

			s2t.end();
		});

		st.test('absent -> setter', function (s2t) {
			forEach(props, function (p) {
				/** @type {Record<typeof p, unknown>} */
				var obj = {};

				s2t.notOk(p in obj, 'property ' + inspect(p) + ' does not exist');

				var holder;
				s2t.comment('mockProperty(…): ' + inspect(p));
				var restore = mockProperty(obj, p, {
					set: function (value) {
						holder = 'holder mocked: ' + value;
					}
				});

				s2t.ok(p in obj, 'property ' + inspect(p) + ' still exists');
				obj[p] = 'second';
				s2t.equal(holder, 'holder mocked: second', 'setter was invoked ("second")');
				s2t.equal(obj[p], undefined, 'no getter, undefined');

				s2t.comment('restore: ' + inspect(p));
				restore();

				s2t.notOk(p in obj, 'property ' + inspect(p) + ' no longer exists');
			});

			s2t.end();
		});

		st.test('absent -> both', function (s2t) {
			forEach(props, function (p) {
				var calls = 0;
				/** @type {Record<typeof p, unknown>} */
				var obj = {};

				s2t.notOk(p in obj, 'property ' + inspect(p) + ' does not exist');

				var holder;
				s2t.comment('mockProperty(…): ' + inspect(p));
				var restore = mockProperty(obj, p, {
					get: function () {
						calls += 100;
						return 'calls: ' + calls;
					},
					set: function (value) {
						holder = 'holder mocked: ' + value;
					}
				});

				s2t.ok(p in obj, 'property ' + inspect(p) + ' still exists');
				obj[p] = 'second';
				s2t.equal(holder, 'holder mocked: second', 'setter was invoked ("second")');
				s2t.equal(obj[p], 'calls: 100', 'getter returns 100 calls');

				s2t.comment('restore: ' + inspect(p));
				restore();

				s2t.notOk(p in obj, 'property ' + inspect(p) + ' no longer exists');
			});

			s2t.end();
		});

		st.test('both -> absent', function (s2t) {
			forEach(props, function (p) {
				var calls = 0;
				var holder;
				/** @type {Record<typeof p, unknown>} */
				var obj = {};
				obj[p] = 1;
				Object.defineProperty(obj, p, {
					get: function () {
						calls += 1;
						return 'calls: ' + calls;
					},
					set: function (value) {
						holder = 'holder: ' + value;
					}
				});

				s2t.ok(p in obj, 'property ' + inspect(p) + ' exists');
				s2t.equal(obj[p], 'calls: 1', 'getter returns 1 calls');
				obj[p] = 'first';
				s2t.equal(holder, 'holder: first', 'setter was invoked ("first")');
				s2t.equal(obj[p], 'calls: 2', 'getter returns 2 calls');

				s2t.comment('mockProperty(…): ' + inspect(p));
				var restore = mockProperty(obj, p, { 'delete': true });

				s2t.notOk(p in obj, 'property ' + inspect(p) + ' is deleted');

				s2t.comment('restore: ' + inspect(p));
				restore();

				s2t.ok(p in obj, 'property ' + inspect(p) + ' still exists');
				s2t.equal(obj[p], 'calls: 3', 'getter returns 3 calls');
				obj[p] = 'third';
				s2t.equal(holder, 'holder: third', 'setter was invoked ("third")');
				s2t.equal(obj[p], 'calls: 4', 'getter returns 4 calls');
			});

			s2t.end();
		});

		st.test('both -> getter', function (s2t) {
			forEach(props, function (p) {
				var calls = 0;
				var holder;
				/** @type {Record<typeof p, unknown>} */
				var obj = {};
				obj[p] = sentinel;
				Object.defineProperty(obj, p, {
					get: function () {
						calls += 1;
						return 'calls: ' + calls;
					},
					set: function (value) {
						holder = 'holder: ' + value;
					}
				});

				s2t.ok(p in obj, 'property ' + inspect(p) + ' exists');
				s2t.equal(obj[p], 'calls: 1', 'getter returns 1 calls');
				obj[p] = 'first';
				s2t.equal(holder, 'holder: first', 'setter was invoked ("first")');
				s2t.equal(obj[p], 'calls: 2', 'getter returns 2 calls');

				s2t.comment('mockProperty(…): ' + inspect(p));
				var restore = mockProperty(obj, p, { set: undefined });

				s2t.ok(p in obj, 'property ' + inspect(p) + ' still exists');
				s2t.equal(obj[p], 'calls: 3', 'getter returns 3 calls');
				s2t['throws'](
					function () { obj[p] = 'second'; },
					TypeError,
					'no setter, throws'
				);
				s2t.equal(obj[p], 'calls: 4', 'getter returns 4 calls');

				s2t.comment('restore: ' + inspect(p));
				restore();

				s2t.ok(p in obj, 'property ' + inspect(p) + ' still exists');
				s2t.equal(obj[p], 'calls: 5', 'getter returns 5 calls');
				obj[p] = 'third';
				s2t.equal(holder, 'holder: third', 'setter was invoked ("third")');
				s2t.equal(obj[p], 'calls: 6', 'getter returns 6 calls');
			});

			s2t.end();
		});

		st.test('both -> setter', function (s2t) {
			forEach(props, function (p) {
				var calls = 0;
				var holder;
				/** @type {Record<typeof p, unknown>} */
				var obj = {};
				obj[p] = 1;
				Object.defineProperty(obj, p, {
					get: function () {
						calls += 1;
						return 'calls: ' + calls;
					},
					set: function (value) {
						holder = 'holder: ' + value;
					}
				});

				s2t.ok(p in obj, 'property ' + inspect(p) + ' exists');
				s2t.equal(obj[p], 'calls: 1', 'getter returns 1 calls');
				obj[p] = 'first';
				s2t.equal(holder, 'holder: first', 'setter was invoked ("first")');
				s2t.equal(obj[p], 'calls: 2', 'getter returns 2 calls');

				s2t.comment('mockProperty(…): ' + inspect(p));
				var restore = mockProperty(obj, p, { get: undefined });

				s2t.ok(p in obj, 'property ' + inspect(p) + ' still exists');
				s2t.equal(obj[p], undefined, 'no getter, undefined');
				obj[p] = 'second';
				s2t.equal(holder, 'holder: second', 'setter was invoked ("second")');
				s2t.equal(obj[p], undefined, 'no getter, undefined');

				s2t.comment('restore: ' + inspect(p));
				restore();

				s2t.ok(p in obj, 'property ' + inspect(p) + ' still exists');
				s2t.equal(obj[p], 'calls: 3', 'getter returns 3 calls');
				obj[p] = 'third';
				s2t.equal(holder, 'holder: third', 'setter was invoked ("third")');
				s2t.equal(obj[p], 'calls: 4', 'getter returns 4 calls');
			});

			s2t.end();
		});

		st.end();
	});

	t.test('array length bug', function (st) {
		var a = [1, , 3]; // eslint-disable-line no-sparse-arrays
		st.equal(a.length, 3, 'length starts at 3');

		mockProperty(a, 'length', { value: 5 });

		st.equal(a.length, 5, 'length ends at 5');

		st.end();
	});

	t.test('mocking a nonexistent data property, nonenumerable, with no value', function (st) {
		/** @type {Record<string, unknown>} */ var obj = {};

		mockProperty(obj, 'foo', { nonEnumerable: true, nonWritable: false });
		mockProperty(obj, 'bar', { nonEnumerable: true });

		st.ok('foo' in obj, 'property "foo" exists');
		st.ok('bar' in obj, 'property "bar" exists');

		st.end();
	});

	t.end();
});
