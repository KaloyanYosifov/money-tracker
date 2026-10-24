import { usePowerSync, useQuery } from "@powersync/react";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import { archiveCategory, deleteCategory, restoreCategory, saveCategory, saveCategoryBudget } from "../../data/mutations";
import { deleteSyncProblem, problemRecord, useSyncProblem } from "../../data/syncProblems";
import { amountInputText, parseAmount } from "../../domain/money";
import { validateCategory } from "../../domain/validation";
import type { Category, UserSettings } from "../../generated/schema";
import { useShortcuts } from "../../hooks/useShortcuts";
import { isHovered } from "../components/interaction";
import { PaperBar } from "../components/PaperBar";
import { SegmentedControl } from "../components/SegmentedControl";
import { CategoryIcon, categoryIconKeys, categoryIcons, type CategoryIconKey } from "../icons/categoryIcons";
import { useBottomInset } from "../nav/bottomInset";
import type { ThemeColors } from "../theme";
import {
  ColorPalette,
  defaultPlatform,
  FormAction,
  FormField,
  FormHeader,
  FormNote,
  formStyles,
  keyboardAppearance,
  PALETTE,
  ReorderList,
  useScreenSettings,
  type ScreenPlatform,
} from "./manage";

type CategoryType = Category["type"];

const TYPES: { value: CategoryType; label: string }[] = [
  { value: "expense", label: "Expense" },
  { value: "income", label: "Income" },
];

function Glyph({
  icon,
  iconStyle,
  theme,
}: {
  icon: string;
  iconStyle: UserSettings["icon_style"];
  theme: ThemeColors;
}) {
  if (!(icon in categoryIcons)) return null;
  return <CategoryIcon icon={icon as CategoryIconKey} variant={iconStyle} color={theme.ink} background={theme.row} />;
}

type ScreenProps = {
  platform?: ScreenPlatform;
  onOpen: (id: string) => void;
  onNew: (type: CategoryType) => void;
};

/** The Categories page: the Expense / Income switch and the categories of that type. */
export function CategoriesScreen({ platform, onOpen, onNew }: ScreenProps) {
  const db = usePowerSync();
  const { settings, theme } = useScreenSettings();
  const [type, setType] = useState<CategoryType>("expense");
  const { data } = useQuery<Category>("SELECT * FROM categories WHERE type = ? ORDER BY sort_order, name", [type]);
  const iconStyle = settings?.icon_style ?? "filled";

  const active = data.filter((c) => !c.archived_at);
  const archived = data.filter((c) => c.archived_at);

  async function reorder(ids: string[]) {
    for (const [index, id] of ids.entries()) {
      const category = active.find((c) => c.id === id);
      if (!category || category.sort_order === index) continue;
      await saveCategory(db, { ...category, sort_order: index });
    }
  }

  return (
    <View style={[styles.screen, { backgroundColor: theme.row }]}>
      <PaperBar theme={theme} style={styles.bar}>
        <SegmentedControl options={TYPES} value={type} onChange={setType} theme={theme} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="New category"
          onPress={() => onNew(type)}
          hitSlop={8}
          style={(state) => [styles.add, (isHovered(state) || state.pressed) && { backgroundColor: theme.hover }]}
        >
          <Text allowFontScaling style={[styles.addText, { color: theme.ink }]}>
            +
          </Text>
        </Pressable>
      </PaperBar>
      <ReorderList
        items={active}
        archived={archived}
        platform={platform ?? defaultPlatform()}
        theme={theme}
        icon={(c) => <Glyph icon={c.icon} iconStyle={iconStyle} theme={theme} />}
        onOpen={onOpen}
        onReorder={(ids) => void reorder(ids)}
        onRestore={(id) => void restoreCategory(db, id)}
      />
    </View>
  );
}

type FormProps = {
  /** null opens an empty form. */
  id: string | null;
  initialType?: CategoryType;
  platform?: ScreenPlatform;
  /** A sync problem of this record: the form shows the rejected data, and a save removes the problem. */
  problemId?: string;
  onClose: () => void;
};

/** The form for a new or an existing category. */
export function CategoryForm({ id, initialType = "expense", platform, problemId, onClose }: FormProps) {
  const { settings, theme } = useScreenSettings();
  const category = useQuery<Category>("SELECT * FROM categories WHERE id = ?", [id ?? ""]);
  const usage = useQuery<{ used: number }>(
    `SELECT (EXISTS (SELECT 1 FROM transactions WHERE category_id = ?)
          OR EXISTS (SELECT 1 FROM recurring_rules WHERE category_id = ?)
          OR EXISTS (SELECT 1 FROM budgets WHERE category_id = ?)) AS used`,
    [id ?? "", id ?? "", id ?? ""],
  );
  const { problem, isLoading: problemLoading } = useSyncProblem(problemId);
  const timePeriod = settings?.time_period;
  const budget = useQuery<{ amount_minor: number }>(
    "SELECT amount_minor FROM budgets WHERE category_id = ? AND period = ? ORDER BY id LIMIT 1",
    [id ?? "", timePeriod ?? ""],
  );
  const existing = id ? problemRecord(problem, category.data[0]) : undefined;
  // Wait for settings: the stored budget depends on the time_period, and a form
  // built before it loads could delete or overwrite the wrong period's budget.
  if (category.isLoading || usage.isLoading || problemLoading || budget.isLoading || !settings || (id && !existing)) {
    return null;
  }

  return (
    <CategoryFormBody
      key={`${existing?.id ?? "new"}:${timePeriod}`}
      existing={existing}
      used={Boolean(usage.data[0]?.used)}
      initialType={initialType}
      iconStyle={settings.icon_style}
      storedBudget={budget.data[0]?.amount_minor ?? null}
      currency={settings.currency_code}
      timePeriod={settings.time_period}
      platform={platform ?? defaultPlatform()}
      theme={theme}
      problemId={problemId}
      onClose={onClose}
    />
  );
}

function CategoryFormBody({
  existing,
  used,
  initialType,
  iconStyle,
  storedBudget,
  currency,
  timePeriod,
  platform,
  theme,
  problemId,
  onClose,
}: {
  existing: Category | undefined;
  used: boolean;
  initialType: CategoryType;
  iconStyle: UserSettings["icon_style"];
  storedBudget: number | null;
  currency: string;
  timePeriod: UserSettings["time_period"];
  platform: ScreenPlatform;
  theme: ThemeColors;
  problemId?: string;
  onClose: () => void;
}) {
  const bottomInset = useBottomInset();
  const db = usePowerSync();
  const [type, setType] = useState<CategoryType>(existing?.type ?? initialType);
  const [name, setName] = useState(existing?.name ?? "");
  const [icon, setIcon] = useState(existing?.icon ?? "tag");
  const [color, setColor] = useState(existing?.color ?? PALETTE[0].hex);
  const [budgetText, setBudgetText] = useState(storedBudget !== null ? amountInputText(storedBudget, currency) : "");
  const [nameTouched, setNameTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // A save error of the name from saveCategory / saveAccount, for example a duplicate name.
  const [nameSaveError, setNameSaveError] = useState<string | null>(null);
  // The id of a new category that a first save already inserted. A retry after a
  // failed budget write then updates it, instead of inserting a duplicate name.
  const [savedId, setSavedId] = useState<string | null>(null);

  const input = { id: existing?.id ?? savedId ?? undefined, type, name, icon, color, sort_order: existing?.sort_order };
  const errors = validateCategory(input);
  const nameError = errors.find((e) => e.field === "name");

  const periodTitle = timePeriod.charAt(0).toUpperCase() + timePeriod.slice(1);
  const budgetValue = budgetText.trim() === "" ? null : parseAmount(budgetText, currency);
  const budgetInvalid = type === "expense" && budgetText.trim() !== "" && budgetValue === null;

  async function run(action: () => Promise<boolean>) {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      if (await action()) onClose();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  const canSave = errors.length === 0 && !budgetInvalid && !busy;

  const save = () =>
    run(async () => {
      const result = await saveCategory(db, input);
      if (!result.ok) {
        setNameSaveError(result.errors.find((e) => e.field === "name")?.message ?? null);
        return false;
      }
      setSavedId(result.id);
      // A category can hold at most one budget: the one for the current period.
      // An income category clears any budget it had.
      const nextBudget = type === "expense" ? budgetValue : null;
      if (nextBudget !== storedBudget) {
        const budgetResult = await saveCategoryBudget(db, result.id, timePeriod, nextBudget);
        // Surface the failure. The category is saved, so a retry writes only the
        // budget (input now carries savedId, so it updates the category).
        if (!budgetResult.ok) throw new Error("budget save failed");
      }
      if (problemId) await deleteSyncProblem(db, problemId);
      return true;
    });

  // Web: Enter saves a valid form, Escape closes it.
  useShortcuts({
    save: () => {
      if (canSave) void save();
    },
    cancel: onClose,
  });

  return (
    <View style={[formStyles.screen, { backgroundColor: theme.paper }]}>
      <FormHeader
        title={existing ? "Edit Category" : "New Category"}
        platform={platform}
        canSave={canSave}
        onCancel={onClose}
        onSave={() => void save()}
        theme={theme}
      />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        // iOS: the keyboard would cover the lower fields. The insets let them scroll above it.
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={[formStyles.content, { paddingBottom: formStyles.content.paddingBottom + bottomInset }]}
      >
        {failed ? (
          <Text allowFontScaling accessibilityRole="alert" style={[formStyles.error, { color: theme.listRed }]}>
            Could not save. Try again.
          </Text>
        ) : null}
        {/* Existing transactions must keep a category of their own type. */}
        {used ? null : (
          <View style={formStyles.typeBar}>
            <SegmentedControl options={TYPES} value={type} onChange={setType} theme={theme} />
          </View>
        )}
        <FormField
          label="Name"
          error={
            nameSaveError ??
            (nameTouched && nameError ? (nameError.code === "too_long" ? "Too long" : "Required") : undefined)
          }
          theme={theme}
        >
          <TextInput
            allowFontScaling
            placeholder="Name"
            placeholderTextColor={theme.accent}
            keyboardAppearance={keyboardAppearance(theme)}
            value={name}
            onChangeText={(text) => {
              setName(text);
              setNameTouched(true);
              setNameSaveError(null);
            }}
            style={[formStyles.input, { color: theme.ink }]}
          />
        </FormField>
        <FormField label="Icon" theme={theme}>
          <View accessibilityRole="radiogroup" accessibilityLabel="Icon" style={styles.icons}>
            {categoryIconKeys.map((key) => {
              const selected = key === icon;
              return (
                <Pressable
                  key={key}
                  accessibilityRole="radio"
                  accessibilityLabel={categoryIcons[key].label}
                  accessibilityState={{ checked: selected }} aria-checked={selected}
                  onPress={() => setIcon(key)}
                  style={[styles.iconCell, selected && { backgroundColor: theme.row, borderColor: theme.accent }]}
                >
                  <CategoryIcon
                    icon={key}
                    variant={iconStyle}
                    color={theme.ink}
                    background={selected ? theme.row : theme.paper}
                  />
                </Pressable>
              );
            })}
          </View>
        </FormField>
        <FormField label="Colour" theme={theme}>
          <ColorPalette value={color} onChange={setColor} theme={theme} />
        </FormField>
        {type === "expense" ? (
          <>
            <FormField label={`${periodTitle} budget`} error={budgetInvalid ? "Invalid amount" : undefined} theme={theme}>
              <TextInput
                allowFontScaling
                accessibilityLabel={`${periodTitle} budget`}
                keyboardType="decimal-pad"
                keyboardAppearance={keyboardAppearance(theme)}
                value={budgetText}
                onChangeText={setBudgetText}
                style={[formStyles.input, { color: theme.ink }]}
              />
            </FormField>
            <FormNote text="Empty means no budget. The period is the Time Period from Settings." theme={theme} />
          </>
        ) : null}
        {existing && existing.archived_at ? (
          <FormAction
            label="Restore"
            color={theme.accent}
            onPress={() =>
              void run(async () => {
                await restoreCategory(db, existing.id);
                return true;
              })
            }
          />
        ) : null}
        {existing && !existing.archived_at ? (
          <FormAction
            label="Archive"
            color={theme.accent}
            onPress={() =>
              void run(async () => {
                await archiveCategory(db, existing.id);
                return true;
              })
            }
          />
        ) : null}
        {existing && !used ? (
          <FormAction
            label="Delete"
            color={theme.listRed}
            onPress={() => void run(async () => (await deleteCategory(db, existing.id)).ok)}
          />
        ) : null}
        {existing && used ? <FormNote text="Used by transactions: archive it instead of deleting." theme={theme} /> : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  bar: {
    flexDirection: "row",
    padding: 14,
  },
  add: {
    position: "absolute",
    right: 14,
    minWidth: 44,
    minHeight: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  addText: {
    fontSize: 32,
    fontWeight: "200",
  },
  icons: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  iconCell: {
    padding: 6,
    borderWidth: 1,
    borderColor: "transparent",
    borderRadius: 6,
  },
});
