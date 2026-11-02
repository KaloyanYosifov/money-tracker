module.exports = {
  preset: "jest-expo",
  // The first render in a test file loads React Native and Expo. In a full parallel run that alone can
  // take longer than the 5 second default.
  testTimeout: 20_000,
  // jest-expo's default list plus uuid and @powersync, which ship only ES modules.
  transformIgnorePatterns: [
    "/node_modules/(?!(.pnpm|react-native|@react-native|@react-native-community|expo|@expo|@expo-google-fonts|react-navigation|@react-navigation|@sentry/react-native|native-base|standard-navigation|uuid|@powersync))",
    "/node_modules/react-native-reanimated/plugin/",
    "/node_modules/@react-native/babel-preset/",
  ],
};
