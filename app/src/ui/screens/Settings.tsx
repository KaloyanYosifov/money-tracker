import { usePowerSync, useQuery } from "@powersync/react";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View, type PressableStateCallbackType } from "react-native";

import { saveOverallBudget, updateSettings, type SettingsPatch } from "../../data/mutations";
import type { DeviceSession, SessionsApi } from "../../data/session";
import { deleteSyncProblem, EDITABLE_TABLES, type SyncProblem } from "../../data/syncProblems";
import { minorUnits, parseAmount } from "../../domain/money";
import type { UserSettings } from "../../generated/schema";
import { APP_LOCK_PREF, LOCK_AFTER_PREF, TABS_POSITION_PREF, useDevicePrefs } from "../../hooks/useDevicePrefs";
import { useAppLockAvailable } from "../../security/AppLock";
import { useSyncState } from "../../sync/syncState";
import { useUpdateRequired } from "../../sync/updateRequired";
import { GroupedSection } from "../components/GroupedSection";
import { isHovered } from "../components/interaction";
import { ThemedSwitch } from "../components/ThemedSwitch";
import type { ThemeColors } from "../theme";
import { defaultPlatform, useScreenSettings, type ScreenPlatform } from "./manage";

export type { SessionsApi } from "../../data/session";

type Option<T extends string> = { value: T; label: string };

const TIME_PERIODS: Option<UserSettings["time_period"]>[] = [
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "biweekly", label: "Every 2 weeks" },
  { value: "monthly", label: "Monthly" },
  { value: "yearly", label: "Yearly" },
];

const THEMES: Option<UserSettings["theme"]>[] = [
  { value: "light", label: "Off" },
  { value: "dark", label: "On" },
  { value: "system", label: "System" },
];

const SUMMARY_FONTS: Option<UserSettings["summary_font"]>[] = [
  { value: "mono", label: "DroidSansMono" },
  { value: "system", label: "System" },
];

const ICON_STYLES: Option<UserSettings["icon_style"]>[] = [
  { value: "filled", label: "Filled" },
  { value: "outline", label: "Outline" },
];

const TABS_POSITIONS: Option<"top" | "bottom">[] = [
  { value: "top", label: "Top" },
  { value: "bottom", label: "Bottom" },
];

const LOCK_AFTER: Option<"0" | "60" | "300">[] = [
  { value: "0", label: "Immediately" },
  { value: "60", label: "After 1 minute" },
  { value: "300", label: "After 5 minutes" },
];

function currencySymbol(currency: string): string {
  const format = new Intl.NumberFormat(undefined, { style: "currency", currency });
  // Hermes on iOS has no NumberFormat.formatToParts. Without it, remove the number ("0.00") from "€0.00".
  if (typeof format.formatToParts !== "function") {
    const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
    const number = new Intl.NumberFormat(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(0);
    return format.format(0).replace(number, "").trim() || currency;
  }
  const part = format.formatToParts(0).find((p) => p.type === "currency");
  return part?.value ?? currency;
}

/** Minor units as text for the input, for example 25000 EUR as "250.00". */
function amountText(minor: number, currency: string): string {
  return (minor / 10 ** minorUnits(currency)).toFixed(minorUnits(currency));
}

type SettingsProps = {
  platform?: ScreenPlatform;
  onClose: () => void;
  onOpenSyncProblems: () => void;
  onOpenSessions: () => void;
  onLogout: () => void;
  onResetLocalData: () => void;
};

/** The Settings screen. Synced settings go to user_settings, device settings to device_prefs. */
export function Settings({
  platform,
  onClose,
  onOpenSyncProblems,
  onOpenSessions,
  onLogout,
  onResetLocalData,
}: SettingsProps) {
  const db = usePowerSync();
  const { settings, theme } = useScreenSettings();
  const { prefs, setPref } = useDevicePrefs();
  const sync = useSyncState(useUpdateRequired());
  const problems = useQuery<{ n: number }>("SELECT count(*) AS n FROM sync_problems");
  const problemCount = problems.data[0]?.n ?? 0;
  const native = (platform ?? defaultPlatform()) === "ios";
  const lockAvailable = useAppLockAvailable();

  const set = (patch: SettingsPatch) => void updateSettings(db, patch);

  return (
    <View style={[styles.screen, { backgroundColor: theme.paper }]}>
      <ScreenHeader title="Settings" onBack={onClose} theme={theme} />
      <ScrollView contentContainerStyle={styles.content}>
        {settings ? (
          <GroupedSection title="Spending (All Accounts)" theme={theme}>
            <ChoiceRow
              label="Time Period"
              value={settings.time_period}
              options={TIME_PERIODS}
              onChange={(time_period) => set({ time_period })}
              theme={theme}
            />
            <SwitchRow
              label="Budget Mode"
              value={Boolean(settings.budget_mode)}
              onChange={(budget_mode) => set({ budget_mode })}
              theme={theme}
            />
            {settings.budget_mode ? <BudgetAmountRow settings={settings} theme={theme} /> : null}
            <SwitchRow
              label="Carry Over"
              value={Boolean(settings.carry_over)}
              onChange={(carry_over) => set({ carry_over })}
              theme={theme}
            />
            <SwitchRow
              label="Hide Future Transactions"
              value={Boolean(settings.hide_future)}
              onChange={(hide_future) => set({ hide_future })}
              theme={theme}
            />
          </GroupedSection>
        ) : null}

        <GroupedSection title="Automatic Syncing" theme={theme}>
          <View style={[styles.row, { backgroundColor: theme.row, borderBottomColor: theme.line }]}>
            <View style={styles.label}>
              <Text allowFontScaling style={[styles.labelText, { color: theme.settingsBlue }]}>
                Home Server Sync
              </Text>
              <Text testID="sync-state" allowFontScaling style={[styles.subText, { color: theme.accent }]}>
                {sync.label}
              </Text>
            </View>
          </View>
          {problemCount > 0 ? (
            <LinkRow label={`Sync problems (${problemCount})`} onPress={onOpenSyncProblems} theme={theme} />
          ) : null}
          <LinkRow label="Devices" onPress={onOpenSessions} theme={theme} />
        </GroupedSection>

        {settings ? (
          <GroupedSection title="User Interface" theme={theme}>
            <ChoiceRow label="Dark Theme" value={settings.theme} options={THEMES} onChange={(t) => set({ theme: t })} theme={theme} />
            <SwitchRow
              label="Show Transaction Note"
              value={Boolean(settings.show_note)}
              onChange={(show_note) => set({ show_note })}
              theme={theme}
            />
            <View
              accessible
              accessibilityLabel={`Currency Symbol, ${currencySymbol(settings.currency_code)}`}
              style={[styles.row, { backgroundColor: theme.row, borderBottomColor: theme.line }]}
            >
              <Text allowFontScaling style={[styles.label, styles.labelText, { color: theme.settingsBlue }]}>
                Currency Symbol
              </Text>
              <Text allowFontScaling style={[styles.value, { color: theme.ink }]}>
                {currencySymbol(settings.currency_code)}
              </Text>
            </View>
            <ChoiceRow
              label="Summary Font"
              value={settings.summary_font}
              options={SUMMARY_FONTS}
              onChange={(summary_font) => set({ summary_font })}
              theme={theme}
            />
            <ChoiceRow
              label="Category Icon Style"
              value={settings.icon_style}
              options={ICON_STYLES}
              onChange={(icon_style) => set({ icon_style })}
              theme={theme}
            />
            {native ? (
              <ChoiceRow
                label="Tabs Position"
                value={prefs[TABS_POSITION_PREF] === "top" ? "top" : "bottom"}
                options={TABS_POSITIONS}
                onChange={(position) => void setPref(TABS_POSITION_PREF, position)}
                theme={theme}
              />
            ) : null}
          </GroupedSection>
        ) : null}

        {native ? (
          <GroupedSection title="Security" theme={theme}>
            <SwitchRow
              testID="app-lock-switch"
              label="App Lock"
              value={prefs[APP_LOCK_PREF] === "on"}
              onChange={(on) => void setPref(APP_LOCK_PREF, on ? "on" : null)}
              disabled={lockAvailable === false && prefs[APP_LOCK_PREF] !== "on"}
              theme={theme}
            />
            {lockAvailable === false ? (
              <Text allowFontScaling style={[styles.note, { color: theme.ink }]}>
                Set up a passcode on this device first
              </Text>
            ) : null}
            <ChoiceRow
              label="Lock After"
              value={LOCK_AFTER.find((o) => o.value === prefs[LOCK_AFTER_PREF])?.value ?? "0"}
              options={LOCK_AFTER}
              onChange={(seconds) => void setPref(LOCK_AFTER_PREF, seconds)}
              theme={theme}
            />
          </GroupedSection>
        ) : null}

        <GroupedSection title="General" theme={theme}>
          <LinkRow label="Reset local data" onPress={onResetLocalData} theme={theme} />
          <LinkRow label="Log out" onPress={onLogout} theme={theme} color={theme.listRed} />
        </GroupedSection>
      </ScrollView>
    </View>
  );
}

function BudgetAmountRow({ settings, theme }: { settings: UserSettings; theme: ThemeColors }) {
  const { data } = useQuery<{ amount_minor: number }>(
    "SELECT amount_minor FROM budgets WHERE category_id IS NULL AND period = ? ORDER BY id LIMIT 1",
    [settings.time_period],
  );
  const stored = data[0]?.amount_minor;
  // A new stored amount or period starts the input again from the stored value.
  return <BudgetAmountInput key={`${settings.time_period}:${stored}`} settings={settings} stored={stored} theme={theme} />;
}

function BudgetAmountInput({
  settings,
  stored,
  theme,
}: {
  settings: UserSettings;
  stored: number | undefined;
  theme: ThemeColors;
}) {
  const db = usePowerSync();
  const currency = settings.currency_code;
  const [text, setText] = useState(stored === undefined ? "" : amountText(stored, currency));
  const [invalid, setInvalid] = useState(false);

  function save() {
    if (text.trim() === "") return;
    const minor = parseAmount(text, currency);
    setInvalid(minor === null);
    if (minor !== null && minor !== stored) void saveOverallBudget(db, settings.time_period, minor);
  }

  return (
    <View style={[styles.row, { backgroundColor: theme.row, borderBottomColor: theme.line }]}>
      <View style={styles.label}>
        <Text allowFontScaling style={[styles.labelText, { color: theme.settingsBlue }]}>
          Budget Amount
        </Text>
        {invalid ? (
          <Text allowFontScaling style={[styles.subText, { color: theme.listRed }]}>
            Enter an amount above 0
          </Text>
        ) : null}
      </View>
      <TextInput
        allowFontScaling
        accessibilityLabel="Budget Amount"
        inputMode="decimal"
        placeholder={currencySymbol(currency)}
        placeholderTextColor={theme.accent}
        value={text}
        onChangeText={setText}
        onBlur={save}
        onSubmitEditing={save}
        style={[styles.input, { color: theme.ink }]}
      />
    </View>
  );
}

function rowBackground(state: PressableStateCallbackType, theme: ThemeColors): string {
  if (state.pressed) return theme.line;
  return isHovered(state) ? theme.hover : theme.row;
}

function ScreenHeader({ title, onBack, theme }: { title: string; onBack: () => void; theme: ThemeColors }) {
  return (
    <View style={[styles.header, { borderBottomColor: theme.line }]}>
      <Pressable
        testID="back"
        accessibilityRole="button"
        accessibilityLabel="Back"
        onPress={onBack}
        hitSlop={8}
        style={(state) => [styles.back, (isHovered(state) || state.pressed) && { backgroundColor: theme.hover }]}
      >
        <Text allowFontScaling style={[styles.backText, { color: theme.ink }]}>
          ←
        </Text>
      </Pressable>
      <Text allowFontScaling accessibilityRole="header" style={[styles.title, { color: theme.ink }]}>
        {title}
      </Text>
    </View>
  );
}

function SwitchRow({
  label,
  value,
  onChange,
  disabled,
  theme,
  testID,
}: {
  testID?: string;
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  theme: ThemeColors;
}) {
  return (
    <View style={[styles.row, { backgroundColor: theme.row, borderBottomColor: theme.line }]}>
      <Text allowFontScaling style={[styles.label, styles.labelText, { color: theme.settingsBlue }]}>
        {label}
      </Text>
      <ThemedSwitch
        testID={testID}
        accessibilityRole="switch"
        accessibilityLabel={label}
        value={value}
        disabled={disabled}
        onValueChange={onChange}
        theme={theme}
      />
    </View>
  );
}

function ChoiceRow<T extends string>({
  label,
  value,
  options,
  onChange,
  theme,
}: {
  label: string;
  value: T;
  options: readonly Option<T>[];
  onChange: (value: T) => void;
  theme: ThemeColors;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value)?.label ?? value;
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}, ${current}`}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((o) => !o)}
        style={(state) => [styles.row, { backgroundColor: rowBackground(state, theme), borderBottomColor: theme.line }]}
      >
        <Text allowFontScaling style={[styles.label, styles.labelText, { color: theme.settingsBlue }]}>
          {label}
        </Text>
        <Text allowFontScaling style={[styles.value, { color: theme.ink }]}>
          {current}
        </Text>
      </Pressable>
      {open
        ? options.map((option) => {
            const checked = option.value === value;
            return (
              <Pressable
                key={option.value}
                accessibilityRole="radio"
                accessibilityLabel={option.label}
                accessibilityState={{ checked }}
                onPress={() => {
                  setOpen(false);
                  if (!checked) onChange(option.value);
                }}
                style={(state) => [
                  styles.row,
                  styles.option,
                  { backgroundColor: isHovered(state) || state.pressed ? theme.hover : theme.paper, borderBottomColor: theme.line },
                ]}
              >
                <Text allowFontScaling style={[styles.label, { color: theme.ink }]}>
                  {option.label}
                </Text>
                <Text style={[styles.value, { color: theme.accent }]}>{checked ? "✓" : ""}</Text>
              </Pressable>
            );
          })
        : null}
    </>
  );
}

function LinkRow({
  label,
  onPress,
  theme,
  color,
}: {
  label: string;
  onPress: () => void;
  theme: ThemeColors;
  color?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={(state) => [styles.row, { backgroundColor: rowBackground(state, theme), borderBottomColor: theme.line }]}
    >
      <Text allowFontScaling style={[styles.label, styles.labelText, { color: color ?? theme.settingsBlue }]}>
        {label}
      </Text>
      <Text allowFontScaling style={[styles.value, { color: theme.line }]}>
        ›
      </Text>
    </Pressable>
  );
}

type ProblemRow = SyncProblem & { has_row: number };

const TABLE_LABELS: Record<string, string> = {
  transactions: "Transaction",
  categories: "Category",
  accounts: "Account",
  recurring_rules: "Repeating transaction",
  budgets: "Budget",
  user_settings: "Settings",
};

const OP_LABELS: Record<SyncProblem["op"], string> = {
  PUT: "new or saved",
  PATCH: "changed",
  DELETE: "deleted",
};

/** "Edit and retry" needs a form for the table and the full record: the upload data of a PUT, or the local row. */
function canEdit(problem: ProblemRow): boolean {
  return EDITABLE_TABLES.includes(problem.table_name) && problem.op !== "DELETE" && (problem.op === "PUT" || problem.has_row === 1);
}

export interface ProblemEdit {
  problemId: string;
  table: string;
  recordId: string;
}

/** The uploads that the server rejected, with "Edit and retry" and "Discard". */
export function SyncProblemsScreen({ onEdit, onClose }: { onEdit: (edit: ProblemEdit) => void; onClose: () => void }) {
  const db = usePowerSync();
  const { theme } = useScreenSettings();
  const { data } = useQuery<ProblemRow>(
    `SELECT p.*, CASE p.table_name
        WHEN 'transactions' THEN EXISTS (SELECT 1 FROM transactions WHERE id = p.record_id)
        WHEN 'categories' THEN EXISTS (SELECT 1 FROM categories WHERE id = p.record_id)
        WHEN 'accounts' THEN EXISTS (SELECT 1 FROM accounts WHERE id = p.record_id)
        ELSE 0 END AS has_row
      FROM sync_problems p
      ORDER BY p.created_at, p.id`,
  );

  return (
    <View style={[styles.screen, { backgroundColor: theme.paper }]}>
      <ScreenHeader title="Sync problems" onBack={onClose} theme={theme} />
      <ScrollView contentContainerStyle={styles.content}>
        {data.length === 0 ? (
          <Text allowFontScaling style={[styles.empty, { color: theme.ink }]}>
            No sync problems.
          </Text>
        ) : (
          <Text allowFontScaling style={[styles.intro, { color: theme.ink }]}>
            The server did not accept these changes. Edit and retry a change, or discard it.
          </Text>
        )}
        {data.map((problem) => (
          <View key={problem.id} style={[styles.card, { backgroundColor: theme.row, borderBottomColor: theme.line }]}>
            <Text allowFontScaling style={[styles.labelText, { color: theme.ink }]}>
              {`${TABLE_LABELS[problem.table_name] ?? problem.table_name} (${OP_LABELS[problem.op] ?? problem.op})`}
            </Text>
            <Text allowFontScaling style={[styles.subText, { color: theme.listRed }]}>
              {problem.message}
            </Text>
            <View style={styles.actions}>
              {canEdit(problem) ? (
                <ActionButton
                  label="Edit and retry"
                  accessibilityLabel={`Edit and retry, ${problem.message}`}
                  onPress={() => onEdit({ problemId: problem.id, table: problem.table_name, recordId: problem.record_id })}
                  color={theme.accent}
                />
              ) : null}
              <ActionButton
                testID="discard-problem"
                label="Discard"
                accessibilityLabel={`Discard, ${problem.message}`}
                onPress={() => void deleteSyncProblem(db, problem.id)}
                color={theme.listRed}
              />
            </View>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

function ActionButton({
  label,
  accessibilityLabel,
  onPress,
  color,
  testID,
}: {
  testID?: string;
  label: string;
  accessibilityLabel: string;
  onPress: () => void;
  color: string;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={[styles.action, { borderColor: color }]}
    >
      <Text allowFontScaling style={[styles.actionText, { color }]}>
        {label}
      </Text>
    </Pressable>
  );
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/** The devices with a session. The current one is marked, the others can be revoked. */
export function SessionsScreen({
  api,
  currentSessionId,
  onClose,
}: {
  api: SessionsApi;
  currentSessionId: string | null;
  onClose: () => void;
}) {
  const { theme } = useScreenSettings();
  const [sessions, setSessions] = useState<DeviceSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void api.list().then((result) => {
      if (!alive) return;
      if (result.ok) setSessions(result.value);
      else setError(result.error === "network" ? "You are offline. Connect to see your devices." : "Could not load the devices.");
    });
    return () => {
      alive = false;
    };
  }, [api]);

  async function revoke(session: DeviceSession) {
    const result = await api.revoke(session.id);
    if (result.ok) {
      setSessions((previous) => previous?.filter((s) => s.id !== session.id) ?? null);
      setError(null);
    } else {
      setError(`Could not revoke ${session.device_name}.`);
    }
  }

  return (
    <View style={[styles.screen, { backgroundColor: theme.paper }]}>
      <ScreenHeader title="Devices" onBack={onClose} theme={theme} />
      <ScrollView contentContainerStyle={styles.content}>
        {error ? (
          <Text allowFontScaling accessibilityRole="alert" style={[styles.intro, { color: theme.listRed }]}>
            {error}
          </Text>
        ) : null}
        {sessions?.map((session) => {
          const current = session.current || session.id === currentSessionId;
          return (
            <View key={session.id} style={[styles.row, { backgroundColor: theme.row, borderBottomColor: theme.line }]}>
              <View style={styles.label}>
                <Text allowFontScaling style={[styles.labelText, { color: theme.ink }]}>
                  {session.device_name}
                </Text>
                <Text allowFontScaling style={[styles.subText, { color: theme.accent }]}>
                  {`Last used ${formatDate(session.last_used_at)}`}
                </Text>
                {current ? (
                  <Text allowFontScaling style={[styles.subText, { color: theme.listGreen }]}>
                    This device
                  </Text>
                ) : null}
              </View>
              {current ? null : (
                <ActionButton
                  label="Revoke"
                  accessibilityLabel={`Revoke ${session.device_name}`}
                  onPress={() => void revoke(session)}
                  color={theme.listRed}
                />
              )}
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  content: {
    paddingBottom: 32,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 58,
    paddingHorizontal: 14,
    borderBottomWidth: 1,
  },
  back: {
    minWidth: 44,
    minHeight: 44,
    marginRight: 6,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  backText: {
    fontSize: 22,
  },
  title: {
    fontSize: 22,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 48,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderBottomWidth: 1,
  },
  option: {
    paddingLeft: 32,
  },
  label: {
    flex: 1,
  },
  labelText: {
    fontSize: 15,
  },
  subText: {
    fontSize: 12.5,
    marginTop: 2,
  },
  value: {
    fontSize: 16,
    marginLeft: 12,
  },
  note: {
    fontSize: 13,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  input: {
    minWidth: 100,
    fontSize: 16,
    textAlign: "right",
  },
  empty: {
    fontSize: 15,
    padding: 20,
    textAlign: "center",
  },
  intro: {
    fontSize: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  card: {
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderBottomWidth: 1,
  },
  actions: {
    flexDirection: "row",
    gap: 10,
    marginTop: 10,
  },
  action: {
    borderWidth: 1.5,
    borderRadius: 4,
    paddingVertical: 6,
    paddingHorizontal: 12,
    minHeight: 36,
    justifyContent: "center",
  },
  actionText: {
    fontSize: 14,
    fontWeight: "600",
  },
});
