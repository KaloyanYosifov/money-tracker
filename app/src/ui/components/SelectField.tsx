import { useContext, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";

import type { UserSettings } from "../../generated/schema";
import { useLayoutMode } from "../../hooks/useLayoutMode";
import { CategoryIcon, categoryIcons, type CategoryIconKey } from "../icons/categoryIcons";
import { useCloseWithOverlays } from "../overlays";
import type { ThemeColors } from "../theme";
import { isHovered } from "./interaction";

export type SelectOption = { id: string; name: string; icon?: string };

type Props = {
  /** The name of the field, and the title of the sheet. */
  label: string;
  options: SelectOption[];
  value: string | null;
  onChange: (id: string) => void;
  /** The style of the category icons in the options. */
  iconStyle?: UserSettings["icon_style"];
  /** Called when the sheet opens and closes, for example to pause the keyboard shortcuts of a form. */
  onOpenChange?: (open: boolean) => void;
  placeholder?: string;
  theme: ThemeColors;
  testID?: string;
  /** The testID of each option is `${optionTestIDPrefix}${option.name}`. */
  optionTestIDPrefix?: string;
};

/** The selected option, or the placeholder. A press opens a sheet with the options. A selected option closes it. */
export function SelectField({
  label,
  options,
  value,
  onChange,
  iconStyle,
  onOpenChange,
  placeholder = "None",
  theme,
  testID,
  optionTestIDPrefix,
}: Props) {
  const [open, setOpen] = useState(false);
  const wide = useLayoutMode() === "sidebar";
  const bottomInset = useContext(SafeAreaInsetsContext)?.bottom ?? 0;
  const selected = options.find((o) => o.id === value);

  function setOpenState(next: boolean) {
    setOpen(next);
    onOpenChange?.(next);
  }
  useCloseWithOverlays(open, () => setOpenState(false));

  const icon = (option: SelectOption, background: string) =>
    option.icon !== undefined && option.icon in categoryIcons ? (
      <CategoryIcon icon={option.icon as CategoryIconKey} variant={iconStyle} color={theme.ink} background={background} />
    ) : null;

  return (
    <>
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={`${label}, ${selected?.name ?? placeholder}`}
        onPress={() => setOpenState(true)}
        style={(state) => [styles.value, isHovered(state) && { backgroundColor: theme.hover }]}
      >
        {selected ? icon(selected, theme.row) : null}
        <Text allowFontScaling style={[styles.valueText, { color: selected ? theme.ink : theme.accent }]}>
          {selected?.name ?? placeholder}
        </Text>
        <Text allowFontScaling style={[styles.chevron, { color: theme.control }]}>
          ›
        </Text>
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpenState(false)}>
        <View style={[styles.root, wide && styles.rootWide]}>
          <Pressable accessibilityLabel="Close" style={styles.backdrop} onPress={() => setOpenState(false)} />
          <View
            accessibilityViewIsModal
            style={[
              wide ? styles.card : [styles.sheet, { paddingBottom: Math.max(styles.sheet.paddingBottom, bottomInset) }],
              { backgroundColor: theme.row },
            ]}
          >
            <Text allowFontScaling accessibilityRole="header" style={[styles.title, { color: theme.accent }]}>
              {label}
            </Text>
            <ScrollView style={styles.list}>
              <View accessibilityRole="radiogroup" accessibilityLabel={label}>
                {options.map((option) => {
                  const checked = option.id === value;
                  return (
                    <Pressable
                      key={option.id}
                      testID={optionTestIDPrefix ? `${optionTestIDPrefix}${option.name}` : undefined}
                      accessibilityRole="radio"
                      accessibilityLabel={option.name}
                      accessibilityState={{ checked }} aria-checked={checked}
                      onPress={() => {
                        onChange(option.id);
                        setOpenState(false);
                      }}
                      style={(state) => [
                        styles.option,
                        { borderBottomColor: theme.line },
                        (isHovered(state) || state.pressed) && { backgroundColor: theme.hover },
                      ]}
                    >
                      {icon(option, theme.row)}
                      <Text allowFontScaling style={[styles.optionText, { color: theme.ink }]}>
                        {option.name}
                      </Text>
                      {checked ? (
                        <Text allowFontScaling style={[styles.check, { color: theme.accent }]}>
                          ✓
                        </Text>
                      ) : null}
                    </Pressable>
                  );
                })}
              </View>
            </ScrollView>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Cancel"
              onPress={() => setOpenState(false)}
              style={(state) => [styles.cancel, isHovered(state) && { backgroundColor: theme.hover }]}
            >
              <Text allowFontScaling style={[styles.cancelText, { color: theme.ink }]}>
                Cancel
              </Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  value: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: 24,
    borderRadius: 4,
  },
  valueText: {
    flex: 1,
    fontSize: 16,
  },
  chevron: {
    fontSize: 20,
  },
  root: {
    flex: 1,
  },
  rootWide: {
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  backdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: "rgba(0,0,0,0.35)",
  },
  // On a tablet the sheet keeps a phone-like width in the middle, away from the rounded screen corners.
  sheet: {
    marginTop: "auto",
    width: "100%",
    maxWidth: 520,
    maxHeight: "80%",
    alignSelf: "center",
    paddingHorizontal: 12,
    paddingBottom: 24,
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
  },
  card: {
    width: "100%",
    maxWidth: 380,
    maxHeight: "80%",
    paddingHorizontal: 12,
    paddingBottom: 8,
    borderRadius: 8,
    overflow: "hidden",
    shadowColor: "#3c2314",
    shadowOpacity: 0.35,
    shadowRadius: 30,
    shadowOffset: { width: 0, height: 10 },
  },
  title: {
    fontSize: 13,
    paddingTop: 14,
    paddingBottom: 6,
    paddingHorizontal: 4,
  },
  list: {
    flexGrow: 0,
  },
  option: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minHeight: 48,
    paddingVertical: 6,
    paddingHorizontal: 4,
    borderBottomWidth: 1,
  },
  optionText: {
    flex: 1,
    fontSize: 16,
  },
  check: {
    fontSize: 16,
    fontWeight: "600",
  },
  cancel: {
    alignSelf: "flex-end",
    marginTop: 8,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 4,
  },
  cancelText: {
    fontSize: 15,
  },
});
