var phin = require("phin");

module.exports = getJSON;

function getJSON (url, callback) {
  if(!callback) callback = function () {};
  return new Promise(function(resolve, reject) {
    _getJSON(url, function (error, body) {
      if(error){
        reject(error);
        callback(error);
        return;
      }
      resolve(body);
      callback(null, body);
    });
  });
}

function _getJSON (url, callback) {
  phin({url: url}, function (error, response) {
    if(error) {
      callback(error);
      return;
    }

    var body;
    try {
      body = JSON.parse(response.body);
    }
    catch (parseError) {
      callback("Parse error: " + parseError);
      return;
    }

    if(response.statusCode != 200) {
      callback("Unexpected response code.");
      return;
    }

    callback(null, body);
  });
}
