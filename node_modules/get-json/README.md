## get-json

Cross-platform library for getting JSON documents. Wraps [request](http://npmjs.org/request) on Node, fallsback to [JSONP](http://github.com/webmodules/jsonp) on browsers.

```bash
$ npm install get-json
```

## Usage

```js
var getJSON = require('get-json')

getJSON('http://api.listenparadise.org', function(error, response){

    console.log(error);
    // undefined

    console.log(response);
    // ["Beth Orton &mdash; Stolen Car",
    // "Jack White &mdash; Temporary Ground",
    // "I Am Kloot &mdash; Loch",
    // "Portishead &mdash; Glory Box"]
});
```

Alternatively, you can use a [Promise](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Using_promises):

```js
var getJSON = require('get-json')

getJSON('http://api.listenparadise.org')
    .then(function(response) {
      console.log(response);
    }).catch(function(error) {
      console.log(error);
    });
```
