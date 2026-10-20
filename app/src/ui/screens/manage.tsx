import { useQuery } from "@powersync/react";
import { useRef, useState, type ReactNode } from "react";
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useColorScheme,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
} from "react-native";
import Svg, { Circle, Path } from "react-native-svg";

import type { UserSettings } from "../../generated/schema";
import { ListRow } from "../components/ListRow";
import { colors, resolveTheme, type ThemeColors } from "../theme";

// Shared parts of the Categories and Accounts screens and their forms.

export type ScreenPlatform = "ios" | "web";

export function defaultPlatform(): ScreenPlatform {
  return Platform.OS === "web" ? "web" : "ios";
}

export function useScreenSettings(): { settings: UserSettings | undefined; theme: ThemeColors } {
  const { data } = useQuery<UserSettings>("SELECT * FROM user_settings LIMIT 1");
  const scheme = useColorScheme();
  const settings = data[0];
  return { settings, theme: colors[resolveTheme(settings?.theme ?? "system", scheme ?? "light")] };
}

/** The 12 colours of the category and account forms. */
export const PALETTE: readonly { hex: string; label: string }[] = [
  { hex: "#e8743b", label: "Orange" },
  { hex: "#f2a33a", label: "Amber" },
  { hex: "#c9a227", label: "Gold" },
  { hex: "#5aa454", label: "Green" },
  { hex: "#3aa6a0", label: "Teal" },
  { hex: "#2f8fd8", label: "Blue" },
  { hex: "#1d4f9a", label: "Navy" },
  { hex: "#8e5cc4", label: "Purple" },
  { hex: "#d6457a", label: "Pink" },
  { hex: "#e35d6a", label: "Red" },
  { hex: "#8a5a44", label: "Brown" },
  { hex: "#8a8a8a", label: "Grey" },
];

export function ColorPalette({
  value,
  onChange,
  theme,
}: {
  value: string;
  onChange: (color: string) => void;
  theme: ThemeColors;
}) {
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel="Colour" style={styles.grid}>
      {PALETTE.map((option) => {
        const selected = option.hex.toLowerCase() === value.toLowerCase();
        return (
          <Pressable
            key={option.hex}
            accessibilityRole="radio"
            accessibilityLabel={option.label}
            accessibilityState={{ checked: selected }}
            onPress={() => onChange(option.hex)}
            style={[styles.swatch, { backgroundColor: option.hex, borderColor: selected ? theme.ink : "transparent" }]}
          />
        );
      })}
    </View>
  );
}

/** The person glyph of the Accounts list, painted in the account colour. */
export function PersonIcon({ color, size = 30, testID }: { color: string; size?: number; testID?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 32 32" color={color} testID={testID}>
      <Circle cx={16} cy={11} r={7} fill={color} />
      <Path d="M3 29c0-7 6-11 13-11s13 4 13 11Z" fill={color} />
    </Svg>
  );
}

export type ListItem = { id: string; name: string };

const DEFAULT_ROW_HEIGHT = 50;

type ReorderListProps<T extends ListItem> = {
  items: T[];
  archived: T[];
  platform: ScreenPlatform;
  theme: ThemeColors;
  icon: (item: T) => ReactNode;
  onOpen: (id: string) => void;
  /** Gets all active IDs in the new order. */
  onReorder: (ids: string[]) => void;
  onRestore: (id: string) => void;
  footer?: ReactNode;
};

/**
 * The active items, which a long-press (iOS) or a drag handle (web) moves,
 * and below them the collapsed "Archived" section.
 */
export function ReorderList<T extends ListItem>({
  items,
  archived,
  platform,
  theme,
  icon,
  onOpen,
  onReorder,
  onRestore,
  footer,
}: ReorderListProps<T>) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [archivedOpen, setArchivedOpen] = useState(false);

  function move(from: number, steps: number) {
    const to = Math.min(items.length - 1, Math.max(0, from + steps));
    if (to === from) return;
    const ids = items.map((item) => item.id);
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved);
    onReorder(ids);
  }

  return (
    <ScrollView scrollEnabled={draggingId === null} contentContainerStyle={styles.listContent}>
      <View testID="active-list">
        {items.map((item, index) => (
          <ReorderItem
            key={item.id}
            item={item}
            platform={platform}
            theme={theme}
            icon={icon(item)}
            dragging={draggingId === item.id}
            onStartDrag={() => setDraggingId(item.id)}
            onEndDrag={(steps) => {
              setDraggingId(null);
              move(index, steps);
            }}
            onOpen={() => onOpen(item.id)}
          />
        ))}
      </View>
      {archived.length > 0 ? (
        <View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Archived (${archived.length})`}
            accessibilityState={{ expanded: archivedOpen }}
            onPress={() => setArchivedOpen((open) => !open)}
            style={[styles.archivedHeader, { borderColor: theme.line }]}
          >
            <Text allowFontScaling style={[styles.archivedTitle, { color: theme.ink }]}>
              {archivedOpen ? "▾" : "▸"} Archived ({archived.length})
            </Text>
          </Pressable>
          {archivedOpen
            ? archived.map((item) => (
                <RowWithAction
                  key={item.id}
                  theme={theme}
                  row={<ListRow title={item.name} icon={icon(item)} onPress={() => onOpen(item.id)} theme={theme} />}
                  action={
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Restore ${item.name}`}
                      onPress={() => onRestore(item.id)}
                      hitSlop={8}
                    >
                      <Text allowFontScaling style={[styles.restore, { color: theme.accent }]}>
                        Restore
                      </Text>
                    </Pressable>
                  }
                />
              ))
            : null}
        </View>
      ) : null}
      {footer}
    </ScrollView>
  );
}

type ReorderItemProps = {
  item: ListItem;
  platform: ScreenPlatform;
  theme: ThemeColors;
  icon: ReactNode;
  dragging: boolean;
  onStartDrag: () => void;
  /** steps is the number of rows the item moved, negative for up. */
  onEndDrag: (steps: number) => void;
  onOpen: () => void;
};

function ReorderItem({ item, platform, theme, icon, dragging, onStartDrag, onEndDrag, onOpen }: ReorderItemProps) {
  const startY = useRef<number | null>(null);
  const rowHeight = useRef(DEFAULT_ROW_HEIGHT);
  const [offset, setOffset] = useState(0);

  function reset() {
    startY.current = null;
    setOffset(0);
  }

  const responder = {
    onResponderGrant: (event: GestureResponderEvent) => {
      startY.current = event.nativeEvent.pageY;
      onStartDrag();
    },
    onResponderMove: (event: GestureResponderEvent) => {
      if (startY.current !== null) setOffset(event.nativeEvent.pageY - startY.current);
    },
    onResponderRelease: (event: GestureResponderEvent) => {
      const dy = startY.current === null ? 0 : event.nativeEvent.pageY - startY.current;
      reset();
      onEndDrag(Math.round(dy / rowHeight.current));
    },
    onResponderTerminate: () => {
      reset();
      onEndDrag(0);
    },
  };

  const web = platform === "web";
  return (
    <View
      testID={`reorder-${item.id}`}
      onLayout={(event: LayoutChangeEvent) => {
        if (event.nativeEvent.layout.height > 0) rowHeight.current = event.nativeEvent.layout.height;
      }}
      // On iOS a long-press picks the row up. The next move takes the touch from the row.
      onMoveShouldSetResponderCapture={() => !web && dragging}
      {...(web ? {} : responder)}
      // A long-press that ends without a move puts the row down again.
      onTouchEnd={() => {
        if (!web && dragging && startY.current === null) onEndDrag(0);
      }}
      style={dragging ? [styles.dragging, { transform: [{ translateY: offset }] }] : undefined}
    >
      <RowWithAction
        theme={theme}
        row={<ListRow title={item.name} icon={icon} onPress={onOpen} onLongPress={web ? undefined : onStartDrag} theme={theme} />}
        action={
          web ? (
            <View
              accessible
              accessibilityRole="button"
              accessibilityLabel={`Drag ${item.name}`}
              onStartShouldSetResponder={() => true}
              {...responder}
              style={styles.handle}
            >
              <Text style={[styles.handleText, { color: theme.accent }]}>≡</Text>
            </View>
          ) : null
        }
      />
    </View>
  );
}

/** A list row with a control on its right. The control is a sibling of the row, so the web does not nest buttons. */
function RowWithAction({ row, action, theme }: { row: ReactNode; action: ReactNode; theme: ThemeColors }) {
  if (!action) return <>{row}</>;
  return (
    <View style={styles.rowWithAction}>
      <View style={styles.rowMain}>{row}</View>
      <View style={[styles.rowAction, { backgroundColor: theme.row, borderBottomColor: theme.line }]}>{action}</View>
    </View>
  );
}

export function FormHeader({
  title,
  platform,
  canSave,
  onCancel,
  onSave,
  saveTestID,
  theme,
}: {
  title: string;
  platform: ScreenPlatform;
  canSave: boolean;
  onCancel: () => void;
  onSave: () => void;
  saveTestID?: string;
  theme: ThemeColors;
}) {
  const web = platform === "web";
  return (
    <View style={[styles.header, { backgroundColor: theme.paper, borderBottomColor: theme.line }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={web ? "Close" : "Cancel"}
        onPress={onCancel}
        hitSlop={8}
        style={styles.headerButton}
      >
        <Text allowFontScaling style={[styles.headerText, { color: theme.ink }]}>
          {web ? "✕" : "Cancel"}
        </Text>
      </Pressable>
      <Text allowFontScaling accessibilityRole="header" numberOfLines={1} style={[styles.title, { color: theme.ink }]}>
        {title}
      </Text>
      <Pressable
        testID={saveTestID}
        accessibilityRole="button"
        accessibilityLabel="Save"
        accessibilityState={{ disabled: !canSave }}
        disabled={!canSave}
        onPress={onSave}
        hitSlop={8}
        style={[styles.headerButton, styles.saveButton]}
      >
        <Text allowFontScaling style={[styles.headerText, styles.save, { color: theme.accent, opacity: canSave ? 1 : 0.4 }]}>
          {web ? "SAVE" : "Save"}
        </Text>
      </Pressable>
    </View>
  );
}

/** A form row: the label on the left, the control on the right, as in the mockup. */
export function FormField({
  label,
  error,
  errorTestID,
  theme,
  children,
}: {
  label: string;
  error?: string;
  errorTestID?: string;
  theme: ThemeColors;
  children: ReactNode;
}) {
  return (
    <View style={[styles.field, { backgroundColor: theme.row, borderBottomColor: theme.line }]}>
      <Text allowFontScaling style={[styles.label, { color: theme.accent }]}>
        {label}
      </Text>
      <View style={styles.fieldValue}>
        {children}
        {error ? (
          <Text allowFontScaling testID={errorTestID} style={[styles.error, { color: theme.listRed }]}>
            {error}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

/** Archive, Restore or Delete at the bottom of a form: a filled button in the action colour. */
export function FormAction({
  label,
  onPress,
  color,
  testID,
}: {
  label: string;
  onPress: () => void;
  color: string;
  testID?: string;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={[styles.action, { backgroundColor: color }]}
    >
      <Text allowFontScaling style={styles.actionText}>
        {label.toUpperCase()}
      </Text>
    </Pressable>
  );
}

export const formStyles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  content: {
    paddingBottom: 24,
  },
  typeBar: {
    alignItems: "center",
    padding: 14,
  },
  input: {
    fontSize: 16,
    minHeight: 32,
  },
});

const styles = StyleSheet.create({
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  swatch: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 3,
  },
  listContent: {
    paddingBottom: 24,
  },
  dragging: {
    zIndex: 1,
    opacity: 0.9,
    shadowColor: "#000",
    shadowOpacity: 0.25,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  handle: {
    minWidth: 44,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    cursor: "grab",
  },
  handleText: {
    fontSize: 22,
  },
  archivedHeader: {
    marginTop: 16,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    backgroundColor: "rgba(0,0,0,0.08)",
  },
  archivedTitle: {
    fontSize: 13,
  },
  restore: {
    fontSize: 15,
    fontWeight: "500",
  },
  rowWithAction: {
    flexDirection: "row",
  },
  rowMain: {
    flex: 1,
  },
  rowAction: {
    justifyContent: "center",
    paddingRight: 8,
    borderBottomWidth: 1,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    minHeight: 58,
    paddingHorizontal: 14,
    borderBottomWidth: 1,
  },
  headerButton: {
    minWidth: 44,
    minHeight: 44,
    justifyContent: "center",
  },
  saveButton: {
    alignItems: "flex-end",
  },
  headerText: {
    fontSize: 20,
  },
  save: {
    fontSize: 16,
    fontWeight: "600",
    letterSpacing: 1,
  },
  title: {
    flex: 1,
    fontSize: 20,
  },
  field: {
    flexDirection: "row",
    alignItems: "flex-start",
    minHeight: 48,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  label: {
    width: 84,
    fontSize: 13,
    paddingTop: 3,
  },
  fieldValue: {
    flex: 1,
    minWidth: 0,
  },
  error: {
    fontSize: 13,
    marginTop: 4,
  },
  action: {
    alignItems: "center",
    paddingVertical: 11,
    marginTop: 16,
    marginHorizontal: 18,
    borderRadius: 4,
  },
  actionText: {
    color: "#ffffff",
    fontSize: 15,
    fontWeight: "500",
    letterSpacing: 1,
  },
});
