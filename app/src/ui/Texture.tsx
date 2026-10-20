import type { ReactNode } from "react";
import { ImageBackground, StyleSheet, type StyleProp, type ViewStyle } from "react-native";

const sources = {
  paper: require("../../assets/textures/paper.png"),
  chalk: require("../../assets/textures/chalk.png"),
};

type Props = {
  kind: keyof typeof sources;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
};

/** Tiles the paper or chalk texture behind its children. */
export function Texture({ kind, style, children }: Props) {
  return (
    <ImageBackground source={sources[kind]} resizeMode="repeat" style={style} imageStyle={styles.image}>
      {children}
    </ImageBackground>
  );
}

const styles = StyleSheet.create({
  // Without a size, react-native-web gives the image the size of the asset (one tile).
  image: {
    width: "100%",
    height: "100%",
  },
});
