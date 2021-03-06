/* eslint no-trailing-spaces: 0, no-magic-numbers: 0, max-len: 0,
  no-lonely-if: 0, complexity: 0, prefer-template: 0 */
"use strict";
const Q = require("q");
const _ = require("lodash");

let request = require("request");

if (process.env.SAUCE_OUTBOUND_PROXY) {
  // NOTE: It doesn't appear that syncRequest supports a proxy setting,
  // so only asynchronous access to guacamole will support SAUCE_OUTBOUND_PROXY
  request = request.defaults({
    strictSSL: false,
    proxy: process.env.SAUCE_OUTBOUND_PROXY
  });
}

const syncRequest = require("sync-request");
let browsers = [];
const latest = {};
const fs = require("fs");
const path = require("path");

const cleanPlatformName = (str) => str.split(" ").join("_").split(".").join("_");

// SauceLabs leaves certain OSes out of its REST API, but these
// are configurable via the web-based platform configurator. The
// following are SauceLabs's internal substitutions for Windows OSes.
const OS_TRANSLATIONS = {
  "Windows XP": "Windows 2003",     // Windows 2003 R2
  "Windows 7": "Windows 2008",     // Windows 2008 R2
  "Windows 8": "Windows 2012",     // Windows Server 2012
  "Windows 8.1": "Windows 2012 R2"   // Windows Server 2012 R2
};

const OS_TRANSLATIONS_FROM_ID = {};
Object.keys(OS_TRANSLATIONS).forEach((name) => {
  OS_TRANSLATIONS_FROM_ID[cleanPlatformName(name)] = OS_TRANSLATIONS[name];
});

const SauceBrowsers = {

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
    // Some devices, like ones using android, have to use the long_name property

    "platformVersion",      // i.e.: "4.4"
    "platformName",         // i.e.: "Android"

    "screenResolution",     // i.e. "1024x768" or undefined. Generated by this module (if matched and requested)
    "deviceOrientation",    // i.e. "landscape" or undefined. Generated by this module (if matched and requested)
    "appiumVersion"
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

  filter: (fn) => browsers.filter(fn),

  latest,

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
  get: (specs, wrapped) => {

    if (specs.id && specs.id.indexOf("latest") > -1) {
      const splitId = specs.id.split("latest");
      if (splitId.length === 2) {
        const browserId = splitId[0].replace("_", "");
        const osId = splitId[1].replace("_", "");
        if (latest[browserId] && latest[browserId][osId]) {
          const latestVersion = latest[browserId][osId];
          const newId = splitId[0] + latestVersion + splitId[1];
          specs.id = newId;
        }
      }
    }

    return browsers.filter((browser) => {
      // Match specs. Ignore orientation, and special case screenResolution
      let matching = true;
      // Match by id (only if id has been specified)
      if (specs.id && browser.id !== specs.id) {
        let matchesTranslated = false;
        // Check if we've asked for a browser that isn't in the matrix, but would be if
        // SauceLabs had any of the OSes in OS_TRANSLATIONS.
        Object.keys(OS_TRANSLATIONS_FROM_ID).forEach((otherPlatformId) => {
          // Check if the translated specs.id matches this browser
          const translatedPlatformName = OS_TRANSLATIONS_FROM_ID[otherPlatformId];
          if (browser.id === specs.id.replace(cleanPlatformName(otherPlatformId), cleanPlatformName(translatedPlatformName))) {
            matchesTranslated = true;
          }
        });
        if (matchesTranslated) {
          // pass through!
        } else {
          matching = false;
        }
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
      const ignoreFields = ["id", "family", "screenResolution", "deviceOrientation"];
      SauceBrowsers.CAPABILITY_FIELDS.forEach((field) => {
        // Disqualify with a given field only if we've specified an explicit value for it
        if (ignoreFields.indexOf(field) === -1 && specs[field]) {
          // Special case: if we've specified platform, we check against the asked-for value,
          // but we also check against a translated value.
          if (field === "platform") {
            // If we're looking for an OS that has a weird name translation API-side,
            // allow a match to the translated version
            const translation = OS_TRANSLATIONS[specs[field]];
            if (browser.desiredCapabilities.platform !== translation
              && browser.desiredCapabilities.platform !== specs[field]) {
              matching = false;
            }
          } else {
            if (browser.desiredCapabilities[field] !== specs[field].toString()) {
              matching = false;
            }
          }
        }
      });

      return matching;
    }).map((browser) => {
      let result;

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

      // clean up capabilities here, only deal with saucelabs wrap here
      if (wrapped) {
        if (result.desiredCapabilities.appiumVersion) {
          // if using appium, use safari as browser for iOS
          if (result.desiredCapabilities.platformName === "iOS") {
            result.desiredCapabilities.browserName = "Safari";
          }
        } else {
          if (result.desiredCapabilities.platform === "iOS") {
            // iOS is not platform name, use OS X 10.10 instead
            result.desiredCapabilities.platform = "OS X 10.10";
          } else if (result.desiredCapabilities.platform === "Android") {
            // Android is not platform name, use linux instead
            result.desiredCapabilities.platform = "Linux";
          }
        }
      }

      return result;
    });
  },

  _normalize: (data) => {
    const overallResult = data
      .filter((browser) =>
        browser.automation_backend === "webdriver" || browser.automation_backend === "appium"
      )
      .map((browser) => {
        // Name and Family
        let name;
        let family;

        if (browser.automation_backend === "appium") {
          if (browser.device.toLowerCase().indexOf("android") > -1) {
            name = "Android";
          } else if (browser.device.toLowerCase().indexOf("ipad") > -1) {
            name = "iOS";
          } else if (browser.device.toLowerCase().indexOf("iphone") > -1) {
            name = "iOS";
          } else {
            name = "Android";
          }

          if (browser.api_name.indexOf("android") > -1) {
            family = "Appium - Android";
          } else if (browser.api_name.indexOf("ipad") > -1) {
            family = "Appium - iPad";
          } else if (browser.api_name.indexOf("iphone") > -1) {
            family = "Appium - iPhone";
          } else {
            family = "Appium - Other";
          }
        } else {
          name = browser.api_name;

          if (name === "internet explorer") {
            name = "IE";
          }

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
        }

        let deviceName;
        let osName;
        let hostOSName;

        // Device name, OS name, and the name of the "host" OS (i.e. a host OS for simulators)

        if (browser.automation_backend === "appium") {
          hostOSName = browser.os;
          deviceName = browser.long_name;

          if (browser.device.toLowerCase().indexOf("android") > -1) {
            osName = "Android";
            hostOSName = "Android";
          } else if (browser.device.toLowerCase().indexOf("ipad") > -1) {
            osName = "iOS";
          } else if (browser.device.toLowerCase().indexOf("iphone") > -1) {
            osName = "iOS";
          } else {
            osName = "Android"; // some devices are named stuff like "Droid4", etc
          }

          if (hostOSName.indexOf("Mac") === 0) {
            hostOSName = hostOSName.replace("Mac", "OS X");
          }
        } else {
          // eg: device: "Nexus7C", long_name: "Google Nexus 7C Emulator"
          deviceName = browser.device ? browser.long_name : "Desktop";
          osName = browser.os;

          // note: name comes from api_name
          if (name === "ipad") {
            osName = "iOS";
          } else if (name === "iphone") {
            osName = "iOS";
          } else if (name === "android") {
            osName = "Android";
          }

          if (osName.indexOf("Mac") === 0) {
            osName = osName.replace("Mac", "OS X");
          }
        }

        let guacamoleId;

        if (browser.automation_backend === "appium") {
          guacamoleId = cleanPlatformName(deviceName)
            + "_" + cleanPlatformName(osName)
            + "_" + cleanPlatformName(browser.short_version)
            + "_" + cleanPlatformName(hostOSName);
        } else {
          const osKey = cleanPlatformName(osName) + "_" + cleanPlatformName(deviceName);
          guacamoleId = cleanPlatformName(name)
            + "_" + cleanPlatformName(browser.short_version)
            + "_" + osKey;

          if (!latest[browser.api_name]) {
            latest[browser.api_name] = {};
          }

          if (!latest[browser.api_name][osKey] || latest[browser.api_name][osKey] < browser.short_version) {
            latest[browser.api_name][osKey] = parseInt(browser.short_version, 10);
          }
        }

        const result = {
          // name , version, OS, device
          id: guacamoleId,
          family,
          resolutions: browser.resolutions
        };

        if (browser.automation_backend === "appium") {
          result.appiumVersion = browser.recommended_backend_version;
          result.platformVersion = browser.short_version;
          result.platformName = osName;
        } else {
          result.platform = osName;
          result.browserName = browser.api_name;
          result.version = browser.short_version;

          if (deviceName.toLowerCase().indexOf("android") > -1) {
            result.platformVersion = browser.short_version || browser.version;
            result.platformName = osName;
          }

          // For Android Emulator, we need to set browserName to either Chrome or Browser depending on version
          if (deviceName === "Android Emulator" && result.platformVersion) {
            let version;
            try {
              version = parseFloat(result.platformVersion);
            } catch (e) {
              throw new Error("Expected platform version to be a number, but was " + result.platformVersion);
            }
            if (version) {
              if (version >= 6.0) {
                result.browserName = "Chrome";
              } else {
                result.browserName = "Browser";
              }
            }
          }
        }

        // Note: we only set the device property if we have a non-desktop device. This is because
        // SauceLabs doesn't actually have a "Desktop" device, we're just making one up for UX.
        if (deviceName !== "Desktop") {
          // this is a mobile device as opposed to a desktop browser.
          result.deviceName = deviceName;
        }

        return result;
      }).map((browser) => {
        const result = {
          id: browser.id,
          family: browser.family,
          resolutions: browser.resolutions,
          desiredCapabilities: {}
        };

        SauceBrowsers.CAPABILITY_FIELDS.forEach((field) => {
          if (browser[field]) {
            result.desiredCapabilities[field] = browser[field];
          }
        });

        return result;
      });

    return _.sortBy(overallResult, (browser) => browser.id);
  },

  // Fetch a raw list of browsers from the Sauce API
  _fetch: () => {
    const deferred = Q.defer();

    request(SauceBrowsers.SAUCE_URL, (err, data) => {
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

  _fetchSync: () => {
    const res = syncRequest("GET", SauceBrowsers.SAUCE_URL);
    let data;
    try {
      data = JSON.parse(res.getBody("utf8"));
    } catch (e) {
      throw new Error("Could not fetch saucelabs browsers from " + SauceBrowsers.SAUCE_URL);
    }
    return data;
  },

  // Signal that we want to load a shrinkwrap file (i.e. cached sauce labs API result) and bypass the Sauce API
  useShrinkwrap: (shrinkwrapFilepath) => {
    shrinkwrapFilepath = path.resolve(shrinkwrapFilepath || "./guacamole-shrinkwrap.json");
    try {
      const data = JSON.parse(fs.readFileSync(shrinkwrapFilepath, "utf8"));
      if (data) {
        SauceBrowsers._haveCachedSauceBrowsers = true;
        browsers = SauceBrowsers._normalize(data);
      }
    } catch (e) {
      throw new Error("Could not read guacamole shrinkwrap file at : " + shrinkwrapFilepath);
    }
  },

  useServiceSync: () => {
    const data = SauceBrowsers._fetchSync();
    if (data) {
      SauceBrowsers._haveCachedSauceBrowsers = true;
      browsers = SauceBrowsers._normalize(data);
    }
  },

  addNormalizedBrowsersFromFile: (filePath) => {
    filePath = path.resolve(filePath);
    try {
      const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (_.isArray(data)) {
        data.forEach((normalizedBrowser) => browsers.push(normalizedBrowser));
      }
    } catch (e) {
      throw new Error("Could not read file for additional devices/browsers at : " + filePath);
    }
  },

  // Return a promise that we'll build a list of supported browsers
  initialize: () => {
    const deferred = Q.defer();

    if (SauceBrowsers._haveCachedSauceBrowsers) {
      deferred.resolve();
      return deferred.promise;
    }

    SauceBrowsers._fetch()
      .then((data) => {
        SauceBrowsers._haveCachedSauceBrowsers = true;
        browsers = SauceBrowsers._normalize(data);

        deferred.resolve();
      })
      .catch((err) => {
        deferred.reject(err);
      });

    return deferred.promise;
  }
};

SauceBrowsers._normalize = SauceBrowsers._normalize.bind(SauceBrowsers);

module.exports = SauceBrowsers;
