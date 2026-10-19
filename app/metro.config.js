const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// From the PowerSync "React Native Web" guide. Expo removes the react-native
// export condition on the web, and @powersync/web needs one to load its
// Metro build.
config.resolver.unstable_conditionsByPlatform.web.push("react-native-web");

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
