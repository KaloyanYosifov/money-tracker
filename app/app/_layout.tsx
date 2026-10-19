import { useFonts } from "expo-font";
import { StyleSheet, Text, View } from "react-native";

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    DroidSansMono: require("../assets/fonts/DroidSansMono.ttf"),
  });

  if (!fontsLoaded && !fontError) {
    return null;
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Money Tracker</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#ece2d1",
  },
  title: {
    fontFamily: "DroidSansMono",
    fontSize: 24,
    color: "#2a2a2a",
  },
});
