# @ljharb/now <sup>[![Version Badge][npm-version-svg]][package-url]</sup>

[![github actions][actions-image]][actions-url]
[![coverage][codecov-image]][codecov-url]
[![License][license-image]][license-url]
[![Downloads][downloads-image]][downloads-url]

[![npm badge][npm-badge-png]][package-url]

The current time, in milliseconds, from the most precise monotonic clock available - `performance.now()`, then `process.hrtime()`, then `Date.now()`, then `new Date().getTime()` (for ES3). Works in browsers and node, all the way back to ES3.

The returned value has an arbitrary origin and is only meaningful relative to another call:
subtract two readings to get an elapsed duration, in milliseconds.
Where the platform provides a monotonic clock (the first two tiers),
it is unaffected by system clock changes.

## Usage / Example

```javascript
var now = require('@ljharb/now');
var assert = require('assert');

assert.equal(typeof now(), 'number');

var start = now();
// ... do some work ...
var elapsed = now() - start;

assert.equal(typeof elapsed, 'number');
assert.ok(elapsed >= 0);
```

[package-url]: https://npmjs.org/package/@ljharb/now
[npm-version-svg]: https://versionbadg.es/ljharb/now.svg
[npm-badge-png]: https://nodei.co/npm/@ljharb/now.png?downloads=true&stars=true
[license-image]: https://img.shields.io/npm/l/@ljharb/now.svg
[license-url]: LICENSE
[downloads-image]: https://img.shields.io/npm/dm/@ljharb/now.svg
[downloads-url]: https://npm-stat.com/charts.html?package=@ljharb/now
[codecov-image]: https://codecov.io/gh/ljharb/now/branch/main/graphs/badge.svg
[codecov-url]: https://app.codecov.io/gh/ljharb/now/
[actions-image]: https://img.shields.io/endpoint?url=https://github-actions-badge-u3jn4tfpocch.runkit.sh/ljharb/now
[actions-url]: https://github.com/ljharb/now/actions
