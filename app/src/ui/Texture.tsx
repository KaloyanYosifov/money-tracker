import { useState, type ReactNode } from "react";
import { Image, Platform, StyleSheet, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from "react-native";

const sources = {
  paper: require("../../assets/textures/paper.png"),
  chalk: require("../../assets/textures/chalk.png"),
};

/** The texture PNGs are 256 by 256. */
const TILE = 256;

type Props = {
  kind: keyof typeof sources;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
};

/** Tiles the paper or chalk texture behind its children. */
export function Texture({ kind, style, children }: Props) {
  return (
    <View style={style}>
      {Platform.OS === "web" ? (
        <Image source={sources[kind]} resizeMode="repeat" style={[styles.fill, styles.webSize]} />
      ) : (
        <NativeTiles source={sources[kind]} />
      )}
      {children}
    </View>
  );
}

/** resizeMode "repeat" draws only one tile on iOS, so this lays the tiles out itself. */
function NativeTiles({ source }: { source: number }) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const onLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    if (width !== size.width || height !== size.height) setSize({ width, height });
  };
  const columns = Math.ceil(size.width / TILE);
  const rows = Math.ceil(size.height / TILE);
  return (
    <View pointerEvents="none" onLayout={onLayout} style={[styles.fill, styles.clip]}>
      {Array.from({ length: rows }, (_, row) => (
        <View key={row} style={styles.row}>
          {Array.from({ length: columns }, (_, column) => (
            <Image key={column} source={source} style={styles.tile} />
          ))}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  // Without a size, react-native-web gives the image the size of the asset (one tile).
  webSize: {
    width: "100%",
    height: "100%",
  },
  clip: {
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
  },
  tile: {
    width: TILE,
    height: TILE,
  },
});
