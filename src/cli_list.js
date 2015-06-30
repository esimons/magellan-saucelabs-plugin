var _ = require("lodash");
var Table = require("cli-table");
var clc = require("cli-color");
var SauceBrowsers = require("./browsers");

module.exports = function () {
  console.log("Available Sauce Browsers:");
  var browsers = SauceBrowsers.filter(function () { return true; });

  var families = _.groupBy(browsers, function (browser) {
    return browser.family;
  });

  var maxFamWidth = _.max(Object.keys(families), function (f) { return f.length; }).length + 5;
  var maxCLIWidth = _.max(_.pluck(browsers, "id"), function (b) { return b.length; }).length + 5;
  var maxBrowserWidth = _.max(_.pluck(browsers, "deviceCapabilities.browserName"), function (b) { return b.length; }).length + 5;
  var maxVersionWidth = _.max(_.pluck(browsers, "deviceCapabilities.version"), function (b) { return b.toString().length; }).length + 5;
  var maxOSWidth = _.max(_.pluck(browsers, "deviceCapabilities.platform"), function (b) { return b.length; }).length + 5;
  var maxDeviceWidth = _.max(_.map(browsers, function (b) {
    return b.deviceCapabilities.deviceName || "Desktop";
  }), function (b) { return b.length; }).length + 5;

  var table = new Table({
    head: ["Family", "Alias", "Browser", "Version", "OS", "Device"],
    colWidths: [maxFamWidth, maxCLIWidth, maxBrowserWidth, maxVersionWidth, maxOSWidth, maxDeviceWidth]
  });

  var count = 1;

  Object.keys(families).sort().forEach(function (family) {
    table.push([clc.red(family)]);
    families[family].forEach(function (b) {
      table.push([
        clc.blackBright(count + "."),
        b.id,
        b.deviceCapabilities.browserName,
        b.deviceCapabilities.version,
        b.deviceCapabilities.platform,
        (b.deviceCapabilities.deviceName ? clc.cyanBright(b.deviceCapabilities.deviceName) : "Desktop")
      ]);
      count++;
    });
  });

  console.log(table.toString());
};