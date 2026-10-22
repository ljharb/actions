'use strict';

var hasOwn = require('hasown');
var hasPropertyDescriptors = require('has-property-descriptors');
var isArray = require('isarray');
var functionsHaveConfigurableNames = require('functions-have-names').functionsHaveConfigurableNames();
var gOPD = require('gopd');
var defineDataProperty = require('define-data-property');
var inspect = require('object-inspect');

var $TypeError = require('es-errors/type');
var $SyntaxError = require('es-errors/syntax');

var hasDescriptors = hasPropertyDescriptors();
var $defineProperty = hasDescriptors && Object.defineProperty;

var hasArrayLengthDefineBug = hasPropertyDescriptors.hasArrayLengthDefineBug();

/** @type {import('.')} */
module.exports = function mockProperty(obj, prop, options) {
	if (hasOwn(options, 'nonEnumerable') && typeof options.nonEnumerable !== 'boolean') {
		throw new $TypeError('`nonEnumerable` option, when present, must be a boolean');
	}
	if (hasOwn(options, 'nonWritable') && typeof options.nonWritable !== 'boolean') {
		throw new $TypeError('`nonEnumerable` option, when present, must be a boolean');
	}
	if (hasOwn(options, 'delete') && typeof options['delete'] !== 'boolean') {
		throw new $TypeError('`delete` option, when present, must be a boolean');
	}

	var wantsData = hasOwn(options, 'value') || hasOwn(options, 'nonWritable');
	var wantsAccessor = hasOwn(options, 'get') || hasOwn(options, 'set');

	if (options['delete'] && (wantsData || wantsAccessor || hasOwn(options, 'nonEnumerable'))) {
		throw new $TypeError('`delete` option must not be set to true when any of `value`, `get`, `set`, `nonWritable`, or `nonEnumerable` are provided');
	}

	if (wantsAccessor) {
		if (wantsData) {
			throw new $TypeError('`value` and `nonWritable` options are mutually exclusive with `get`/`set` options');
		}
		if (
			(hasOwn(options, 'get') && typeof options.get !== 'function' && typeof options.get !== 'undefined')
			|| (hasOwn(options, 'set') && typeof options.set !== 'function' && typeof options.set !== 'undefined')
		) {
			throw new $TypeError('`get` and `set` options, when present, must be functions or `undefined`');
		}
		if (!gOPD || !$defineProperty) {
			throw new $SyntaxError('the `get`/`set` options require native getter/setter support');
		}
	}

	var objIsArray = isArray(obj);
	var origDescriptor = gOPD
		? gOPD(/** @type {Record<PropertyKey, unknown>} */ (obj), prop)
		: hasOwn(obj, prop)
			? {
				configurable: typeof obj === 'function' && prop === 'name' ? functionsHaveConfigurableNames : true,
				enumerable: !(hasDescriptors && objIsArray && prop === 'length'),
				value: obj[prop],
				writable: true
			}
			: void undefined;

	var origConfigurable = origDescriptor ? !!origDescriptor.configurable : true;
	var origEnumerable = origDescriptor ? !!origDescriptor.enumerable : true;

	if (wantsAccessor) {
		var hasGetter = origDescriptor && typeof origDescriptor.get === 'function';
		var hasSetter = origDescriptor && typeof origDescriptor.set === 'function';
		var hasFutureGetter = hasOwn(options, 'get') ? typeof options.get === 'function' : hasGetter;
		var hasFutureSetter = hasOwn(options, 'set') ? typeof options.set === 'function' : hasSetter;
		if (!hasFutureGetter && !hasFutureSetter) {
			throw new $TypeError('when the `get` or `set` options are provided, the mocked object property must end up with at least one of a getter or a setter function');
		}
	}

	var isChangingEnumerability = hasOwn(options, 'nonEnumerable') ? !options.nonEnumerable !== origEnumerable : false;
	if (origDescriptor && !origDescriptor.configurable) {
		if (isChangingEnumerability) {
			throw new $TypeError('`' + inspect(prop) + '` is nonconfigurable, and can not be changed');
		}
		if (wantsAccessor) {
			if (hasOwn(origDescriptor, 'value')) {
				throw new $TypeError('`' + inspect(prop) + '` is a nonconfigurable data property, and can not be changed to an accessor');
			}

			var isChangingGetter = hasOwn(options, 'get') && hasOwn(origDescriptor, 'get') && options.get !== origDescriptor.get;
			var isChangingSetter = hasOwn(options, 'set') && hasOwn(origDescriptor, 'set') && options.set !== origDescriptor.set;

			if (isChangingGetter || isChangingSetter) {
				throw new $TypeError('`' + inspect(prop) + '` is nonconfigurable, and can not be changed');
			}
			return function restore() {};
		}
		if (hasOwn(origDescriptor, 'get') || hasOwn(origDescriptor, 'set')) {
			throw new $TypeError('`' + inspect(prop) + '` is a nonconfigurable accessor property, and can not be changed to a data property');
		}

		var isChangingValue = hasOwn(options, 'value') && hasOwn(origDescriptor, 'value') && options.value !== origDescriptor.value;
		var isChangingWriteability = hasOwn(options, 'nonWritable') && !options.nonWritable !== origDescriptor.writable;

		if ((!origDescriptor.writable && isChangingValue) || isChangingEnumerability || isChangingWriteability) {
			throw new $TypeError('`' + inspect(prop) + '` is nonconfigurable, and can not be changed');
		}
		if (!isChangingWriteability && !isChangingValue) {
			return function restore() {};
		}
	}

	if (options['delete']) {
		// @ts-expect-error TS can't handle indexing properly here
		delete obj[prop]; // eslint-disable-line no-param-reassign
	} else if (
		wantsData
		&& !isChangingEnumerability
		&& (!origDescriptor || origDescriptor.enumerable)
		&& (!hasOwn(options, 'nonWritable') || !options.nonWritable)
		&& (!origDescriptor || origDescriptor.writable)
		&& (!gOPD || !(prop in obj))
	) {
		// @ts-expect-error TS can't handle indexing properly here
		obj[prop] = options.value; // eslint-disable-line no-param-reassign
	} else {
		if (objIsArray && prop === 'length' && hasArrayLengthDefineBug) {
			throw new $SyntaxError('this environment does not support Define on an array’s length');
		}

		var newEnumerable = hasOwn(options, 'nonEnumerable') ? !options.nonEnumerable : origEnumerable;

		if (wantsData) {
			defineDataProperty(
				/** @type {Record<PropertyKey, unknown>} */ (obj),
				prop,
				hasOwn(options, 'value') ? options.value : origDescriptor && origDescriptor.value,
				!newEnumerable,
				hasOwn(options, 'nonWritable') ? options.nonWritable : origDescriptor && hasOwn(origDescriptor, 'writable') ? !origDescriptor.writable : false
			);
		} else if (wantsAccessor) {
			var getter = hasOwn(options, 'get') ? options.get : origDescriptor && origDescriptor.get;
			var setter = hasOwn(options, 'set') ? options.set : origDescriptor && origDescriptor.set;

			/** @type {Exclude<typeof $defineProperty, false>} */
			($defineProperty)(obj, prop, {
				configurable: origConfigurable,
				enumerable: newEnumerable,
				get: getter,
				set: setter
			});
		} else {
			defineDataProperty(
				/** @type {Record<PropertyKey, unknown>} */ (obj),
				prop,
				origDescriptor && origDescriptor.value,
				!newEnumerable
			);
		}
	}

	return function restore() {
		if (!origDescriptor) {
			// @ts-expect-error TS can't handle indexing properly here
			delete obj[prop]; // eslint-disable-line no-param-reassign
		} else if ($defineProperty) {
			if (hasOwn(origDescriptor, 'writable')) {
				defineDataProperty(
					/** @type {Record<PropertyKey, unknown>} */ (obj),
					prop,
					origDescriptor.value,
					!origDescriptor.enumerable,
					!origDescriptor.writable,
					!origDescriptor.configurable
				);
			} else {
				var oldGetter = origDescriptor && origDescriptor.get;
				var oldSetter = origDescriptor && origDescriptor.set;

				$defineProperty(obj, prop, {
					configurable: origDescriptor.configurable,
					enumerable: origDescriptor.enumerable,
					get: oldGetter,
					set: oldSetter
				});
			}
		} else {
			// @ts-expect-error TS can't handle indexing properly here
			obj[prop] = origDescriptor.value; // eslint-disable-line no-param-reassign
		}
	};
};
