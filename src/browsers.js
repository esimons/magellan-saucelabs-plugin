var Q = require("q");
var _ = require("lodash");
var request = require("request");
var browsers = [];
var fs = require("fs");
var path = require("path");

var SauceBrowsers = {

  CAPABILITY_FIELDS: [
    "browserName",          // i.e.: "firefox", "chrome", but also (strangely) "android"
    "version",              // i.e.: "42.0"

    "platform",             // i.e.: "OS X 10.10"
                            // NOTE:
                            // We perform some transformations from the listing API to 
                            // sauce's device capabilities API, i.e.: "Mac 10.10" -> "OS X 10.10".

    "deviceName",           // i.e: "Samsung Galaxy S5 Device".
                            // NOTE:
                            // As with platform, we transform some strings from the listing API
                            // on their way to the device capabilities API. For example, if the saucelabs
                            // listing API specifies a device field but does NOT have the word "device"
                            // in it, it's assumed to be an simulator, and we perform a transformation,
                            // i.e.: "iphone" -> "iPhone Simulator", "Mac <version>" -> "OS X <version>", etc.

    "platformVersion",      // i.e.: "4.4"
    "platformName",         // i.e.: "Android"

    "screenResolution",     // i.e. "1024x768" or undefined. Generated by this module (if matched and requested)
    "deviceOrientation"     // i.e. "landscape" or undefined. Generated by this module (if matched and requested)
  ],

  INTERNAL_FIELDS: [
    "id",                   // Alias for a browser such as chrome_43_Windows_2012_R2_Desktop
    "family"                // For use in sorting or grouping browsers, i.e.: "IE", "Chrome", etc.
  ],

  // NOTE: The URL https://saucelabs.com/rest/v1/info/platforms/webdriver has this
  // information, but not the available resolutions. That's why we go to the endpoint 
  // with the much larger set of options (+ automation backends) and then filter down.
  SAUCE_URL: "https://saucelabs.com/rest/v1/info/platforms/all?resolutions=true",
  _haveCachedSauceBrowsers: false,

  filter: function (fn) {
    return browsers.filter(fn);
  },

  // Return a list of browser desiredCapabilities objects if they exist in our browser list.
  //
  // Match by:
  //
  // 1) id or family
  // 2) desiredCapabilities field values ( supported: browserName, version, platform, deviceName, platformVersion, platformName, screenResolution )
  //
  // Amend return object with:
  //
  // 1) A screenResolution, if specified, but only match browsers that support that screenResolution
  // 2) A deviceOrientation if specified, regardless of support.
  //
  // If wrapped is true, return a wrapper object within which a desiredCapabilities object can be found, along
  // with id, family, and a supported resolutions array (i.e. guacamole's raw internal representation)
  //
  get: function (specs, wrapped) {
    return browsers.filter(function (browser) {
      // Match specs. Ignore orientation, and special case screenResolution
      var matching = true;

      // Match by id (only if id has been specified)
      if (specs.id && browser.id !== specs.id) {
        matching = false;
      }

      // Match by family (only if family has been specified)
      if (specs.family && browser.family !== specs.family) {
        matching = false;
      }

      // If we've requested a screenResolution, disqualify this browser if it doesn't *explicitly* support it
      if (specs.screenResolution) {
        if (!browser.resolutions || browser.resolutions.indexOf(specs.screenResolution) === -1) {
          matching = false;
        }
      }

      // Match by properties from the desiredCapabilities object. Ignore certain field names.
      var ignoreFields = ["id", "family", "screenResolution", "deviceOrientation"];
      SauceBrowsers.CAPABILITY_FIELDS.forEach(function (field) {
        // Disqualify with a given field only if we've specified an explicit value for it
        if (ignoreFields.indexOf(field) === -1 && specs[field]) {
          if (browser.desiredCapabilities[field] !== specs[field].toString()) {
            matching = false;
          }
        }
      });

      return matching;
    }).map(function (browser) {
      var result;

      if (wrapped) {
        result = _.extend({}, browser);
      } else {
        result = _.extend({}, browser.desiredCapabilities);
      }

      if (specs.deviceOrientation) {
        if (wrapped) {
          result.desiredCapabilities.deviceOrientation = specs.deviceOrientation;
        } else {
          result.deviceOrientation = specs.deviceOrientation;
        }
      }

      if (specs.screenResolution) {
        if (wrapped) {
          result.desiredCapabilities.screenResolution = specs.screenResolution;
        } else {
          result.screenResolution = specs.screenResolution;
        }
      }

      return result;
    });
  },

  _normalize: function (data) {
    var result = data
      .filter(function (browser) {
        return browser.automation_backend === "webdriver";
      })
      .map(function (browser) {
        var name = browser.api_name;

        if (name === "internet explorer") {
          name = "IE";
        }

        var family;
        if (name === "IE") {
          family = "IE";
        } else if (name.indexOf("android") === 0) {
          family = "Webkit Android";
        } else if (name.indexOf("firefox") === 0) {
          family = "Firefox (Gecko)";
        } else if (name.indexOf("ipad") === 0) {
          family = "Webkit iPad";
        } else if (name.indexOf("iphone") === 0) {
          family = "Webkit iPhone";
        } else if (name.indexOf("opera") === 0) {
          family = "Opera";
        } else if (name.indexOf("safari") === 0) {
          family = "Webkit Safari";
        } else if (name.indexOf("chrome") === 0) {
          family = "Chrome";
        } else {
          family = "Other";
        }

        var clean = function (str) { return str.split(" ").join("_").split(".").join("_"); };

        var deviceName = (browser.device ? browser.device : "Desktop");
        var osName = browser.os;

        // For a real device, don't translate to a simulator devicename
        if (deviceName.toLowerCase().indexOf("device") === -1) {
          if (deviceName.toLowerCase() == "ipad") {
            deviceName = "iPad Simulator";
            osName = "iOS";
          }

          if(deviceName.toLowerCase() == "iphone") {
            deviceName = "iPhone Simulator";
            osName = "iOS";
          }

          if(deviceName.toLowerCase() == "android") {
            deviceName = "Android Simulator";
          }
        }

        if (osName.indexOf("Mac") === 0) {
          osName = osName.replace("Mac", "OS X");
        }

        var result = {
          // name , version, OS, device
          id: (
            clean(name)
            + "_" + clean(browser.short_version)
            + "_" + clean(osName)
            + "_" + clean(deviceName)
          ),
          browserName: browser.api_name,
          version: browser.short_version,
          platform: osName,
          family: family,
          resolutions: browser.resolutions
        };

        if (deviceName.toLowerCase().indexOf("android") > -1) {
          result.platformVersion = browser.short_version || browser.version;
          result.platformName = osName;
        }

        // Note: we only set the device property if we have a non-desktop device. This is because
        // SauceLabs doesn't actually have a "Desktop" device, we're just making one up for UX.
        if (deviceName !== "Desktop") {
          // this is a mobile device as opposed to a desktop browser.
          result.deviceName = deviceName;
        }

        return result;
      }).map(function (browser) {
        var result = {
          id: browser.id,
          family: browser.family,
          resolutions: browser.resolutions,
          desiredCapabilities: {}
        };

        SauceBrowsers.CAPABILITY_FIELDS.forEach(function (field) {
          if (browser[field]) {
            result.desiredCapabilities[field] = browser[field];
          }
        });

        return result;
      });

    return _.sortBy(result, function (browser) { return browser.id; });
  },

  // Fetch a raw list of browsers from the Sauce API
  _fetch: function () {
    var deferred = Q.defer();

    request(this.SAUCE_URL, function (err, data) {
      if (err) {
        deferred.reject(err);
      } else {
        try {
          data = JSON.parse(data.body);
        } catch (e) {
          deferred.reject(e);
          return;
        }
        deferred.resolve(data);
      }
    });

    return deferred.promise;
  },

  // Signal that we want to load a shrinkwrap file (i.e. cached sauce labs API result) and bypass the Sauce API
  useShrinkwrap: function (shrinkwrapFilepath) {
    shrinkwrapFilepath = path.resolve(shrinkwrapFilepath || "./guacamole-shrinkwrap.json");
    try {
      var data = JSON.parse(fs.readFileSync(shrinkwrapFilepath, "utf8"));
      if (data) {
        this._haveCachedSauceBrowsers = true;
        browsers = this._normalize(data);
      }
    } catch (e) {
      throw new Error("Could not read guacamole shrinkwrap file at : " + shrinkwrapFilepath);
    }
  },

  // Return a promise that we'll build a list of supported browsers
  initialize: function () {
    var deferred = Q.defer();
    var self = this;

    if (this._haveCachedSauceBrowsers) {
      deferred.resolve();
      return deferred.promise;
    }

    this._fetch()
      .then(function (data) {
        self._haveCachedSauceBrowsers = true;
        browsers = self._normalize(data);

        deferred.resolve();
      })
      .catch(function (err) {
        deferred.reject(err);
      });

    return deferred.promise;
  }
};

SauceBrowsers._normalize = SauceBrowsers._normalize.bind(SauceBrowsers);

module.exports = SauceBrowsers;