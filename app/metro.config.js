const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// From the PowerSync "React Native Web" guide. Expo removes the react-native
// export condition on the web, and @powersync/web needs one to load its
// Metro build.
config.resolver.unstable_conditionsByPlatform.web.push("react-native-web");

// Expo Router turns every file in app/app into a route. Keep the Jest test
// files there out of the bundle.
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
config.resolver.blockList = [
  ...[].concat(config.resolver.blockList ?? []),
  new RegExp(`^${escapeRegExp(path.join(__dirname, "app"))}[\\\\/].*\\.test\\.[jt]sx?$`),
];

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (platform === "web") {
    if (moduleName === "@powersync/react-native") {
      return { type: "empty" };
    }
  } else if (moduleName === "@powersync/web") {
    return { type: "empty" };
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
