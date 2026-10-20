import type { PressableStateCallbackType } from "react-native";

/** react-native-web adds `hovered` to the Pressable state. Native has no hover, so it is always false there. */
export function isHovered(state: PressableStateCallbackType): boolean {
  return (state as PressableStateCallbackType & { hovered?: boolean }).hovered === true;
}
