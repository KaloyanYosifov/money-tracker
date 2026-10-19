import type { ReactNode } from "react";
import { ImageBackground, type StyleProp, type ViewStyle } from "react-native";

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
    <ImageBackground source={sources[kind]} resizeMode="repeat" style={style}>
      {children}
    </ImageBackground>
  );
}
