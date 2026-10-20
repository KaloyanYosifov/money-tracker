import { usePowerSync, useQuery } from "@powersync/react";
import { useState, type ReactNode } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, useColorScheme, View } from "react-native";

import { saveRecurringRule, saveTransaction, type SaveResult } from "../../data/mutations";
import { deleteSyncProblem, problemRecord, useSyncProblem } from "../../data/syncProblems";
import { useUndo } from "../../data/UndoProvider";
import { formatAmount, minorUnits } from "../../domain/money";
import { today as localToday } from "../../domain/period";
import {
  validateRecurringRule,
  validateTransaction,
  type FieldError,
  type ValidationCode,
} from "../../domain/validation";
import type { Category, RecurringRule, Transaction, UserSettings } from "../../generated/schema";
import { setDevicePref } from "../../hooks/useDevicePrefs";
import { useShortcuts } from "../../hooks/useShortcuts";
import { AmountKeypad } from "../components/AmountKeypad";
import { GroupedSection } from "../components/GroupedSection";
import { isHovered } from "../components/interaction";
import { SegmentedControl } from "../components/SegmentedControl";
import { ThemedSwitch } from "../components/ThemedSwitch";
import { CategoryIcon, categoryIcons, type CategoryIconKey } from "../icons/categoryIcons";
import { colors, resolveTheme, type ThemeColors } from "../theme";
import { FormAction, FormField, FormHeader, formStyles } from "./manage";

export const LAST_ACCOUNT_PREF = "lastAccountId";

type TransactionType = Transaction["type"];
type Frequency = RecurringRule["frequency"];
type CategoryRow = Pick<Category, "id" | "type" | "name" | "icon">;
type AccountRow = { id: string; name: string };

type Props = {
  /** null opens an empty form. */
  id: string | null;
  /** The type of a new transaction. */
  initialType?: TransactionType;
  platform?: "ios" | "web";
  locale?: string;
  today?: string;
  /** A sync problem of this transaction: the form shows the rejected data, and a save removes the problem. */
  problemId?: string;
  onClose: () => void;
};

const TYPES: { value: TransactionType; label: string }[] = [
  { value: "expense", label: "Expense" },
  { value: "income", label: "Income" },
  { value: "transfer", label: "Transfer" },
];

const FREQUENCIES: { value: Frequency; label: string }[] = [
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "biweekly", label: "Every 2 weeks" },
  { value: "monthly", label: "Monthly" },
  { value: "yearly", label: "Yearly" },
];

const MESSAGES: Record<ValidationCode, string> = {
  required: "Required",
  invalid: "Not valid",
  too_long: "Too long",
  out_of_range: "Out of range",
  invalid_category_type: "Pick a category of this type",
  invalid_transfer: "Not allowed for a transfer",
  invalid_reference: "No longer exists",
  in_use: "In use",
};

function message(error: FieldError, today: string): string {
  if (error.field === "amount_minor" && error.code === "out_of_range") return "Enter an amount above 0";
  if (error.field === "to_account_id" && error.code === "invalid_transfer") return "Pick a different account";
  if ((error.field === "date" || error.field === "end_date") && error.code === "invalid") return `Use a date like ${today}`;
  if (error.field === "end_date" && error.code === "out_of_range") return "Must not be before the start";
  return MESSAGES[error.code];
}

/** Minor units as a keypad expression, for example 1499 EUR as "14.99". */
function minorToExpression(minor: number, currency: string): string {
  const digits = minorUnits(currency);
  if (digits === 0) return String(minor);
  const text = String(minor).padStart(digits + 1, "0");
  return `${text.slice(0, -digits)}.${text.slice(-digits)}`;
}

/** Loads the records, then shows the form for a new or an existing transaction. */
export function TransactionForm({ id, initialType = "expense", platform, locale, today, problemId, onClose }: Props) {
  const transaction = useQuery<Transaction>("SELECT * FROM transactions WHERE id = ?", [id ?? ""]);
  const { problem, isLoading: problemLoading } = useSyncProblem(problemId);
  const existing = id ? problemRecord(problem, transaction.data[0]) : undefined;
  const rule = useQuery<RecurringRule>("SELECT * FROM recurring_rules WHERE id = ?", [existing?.recurring_rule_id ?? ""]);
  const settings = useQuery<UserSettings>("SELECT * FROM user_settings LIMIT 1");
  const lastAccount = useQuery<{ value: string | null }>("SELECT value FROM device_prefs WHERE id = ?", [LAST_ACCOUNT_PREF]);
  // Archived records are hidden, except the ones the transaction already uses.
  const categories = useQuery<CategoryRow>(
    "SELECT id, type, name, icon FROM categories WHERE archived_at IS NULL OR id = ? ORDER BY sort_order, name",
    [existing?.category_id ?? ""],
  );
  const accounts = useQuery<AccountRow>(
    "SELECT id, name FROM accounts WHERE archived_at IS NULL OR id IN (?, ?) ORDER BY sort_order, name",
    [existing?.account_id ?? "", existing?.to_account_id ?? ""],
  );
  const scheme = useColorScheme();

  const loading = [transaction, rule, settings, lastAccount, categories, accounts].some((q) => q.isLoading) || problemLoading;
  const userSettings = settings.data[0];
  if (loading || (id && !existing)) return null;

  const theme = colors[resolveTheme(userSettings?.theme ?? "system", scheme ?? "light")];
  return (
    <FormBody
      key={existing?.id ?? "new"}
      existing={existing}
      rule={rule.data[0]}
      initialType={initialType}
      categories={categories.data}
      accounts={accounts.data}
      lastAccountId={lastAccount.data[0]?.value ?? null}
      currency={userSettings?.currency_code ?? "EUR"}
      iconStyle={userSettings?.icon_style ?? "filled"}
      platform={platform ?? (Platform.OS === "web" ? "web" : "ios")}
      locale={locale}
      today={today ?? localToday()}
      theme={theme}
      problemId={problemId}
      onClose={onClose}
    />
  );
}

type BodyProps = {
  existing: Transaction | undefined;
  rule: RecurringRule | undefined;
  initialType: TransactionType;
  categories: CategoryRow[];
  accounts: AccountRow[];
  lastAccountId: string | null;
  currency: string;
  iconStyle: UserSettings["icon_style"];
  platform: "ios" | "web";
  locale?: string;
  today: string;
  theme: ThemeColors;
  problemId?: string;
  onClose: () => void;
};

function FormBody({
  existing,
  rule,
  initialType,
  categories,
  accounts,
  lastAccountId,
  currency,
  iconStyle,
  platform,
  locale,
  today,
  theme,
  problemId,
  onClose,
}: BodyProps) {
  const db = usePowerSync();
  const { requestDelete } = useUndo();

  const defaultAccount =
    accounts.find((a) => a.id === lastAccountId)?.id ?? accounts[0]?.id ?? "";
  const [type, setType] = useState<TransactionType>(existing?.type ?? initialType);
  const [amount, setAmount] = useState<number | null>(existing?.amount_minor ?? null);
  const [expression, setExpression] = useState(existing ? minorToExpression(existing.amount_minor, currency) : "");
  const [keypadOpen, setKeypadOpen] = useState(false);
  const [name, setName] = useState(existing?.name ?? "");
  const [date, setDate] = useState(existing?.date ?? today);
  const [categoryId, setCategoryId] = useState<string | null>(existing?.category_id ?? null);
  const [accountId, setAccountId] = useState(existing?.account_id ?? defaultAccount);
  const [toAccountId, setToAccountId] = useState<string | null>(existing?.to_account_id ?? null);
  const [repeating, setRepeating] = useState(Boolean(rule));
  const [frequency, setFrequency] = useState<Frequency>(rule?.frequency ?? "monthly");
  const [endDate, setEndDate] = useState(rule?.end_date ?? "");
  const [note, setNote] = useState(existing?.note ?? "");
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const [serverErrors, setServerErrors] = useState<FieldError[]>([]);
  const [saving, setSaving] = useState(false);

  const transfer = type === "transfer";
  // A manual transaction has no rule. Only a new transaction or an occurrence of a rule can repeat.
  const canRepeat = !existing || Boolean(rule);

  function touch(field: string) {
    setTouched((previous) => new Set(previous).add(field));
    setServerErrors((previous) => previous.filter((e) => e.field !== field));
  }

  const money = {
    type,
    amount_minor: amount ?? 0,
    name,
    category_id: transfer ? null : categoryId,
    account_id: accountId,
    to_account_id: transfer ? toAccountId : null,
    note: note === "" ? null : note,
  };
  const ruleStart = rule?.start_date ?? date;
  const categoryType = categories.find((c) => c.id === categoryId)?.type ?? null;
  const errors = [
    ...validateTransaction({ ...money, id: existing?.id, date }, categoryType),
    ...(repeating
      ? validateRecurringRule(
          { ...money, frequency, start_date: ruleStart, end_date: endDate === "" ? null : endDate },
          categoryType,
        ).filter((e) => e.field === "frequency" || e.field === "end_date")
      : []),
  ];
  const valid = errors.length === 0;

  function errorFor(field: string): FieldError | undefined {
    return serverErrors.find((e) => e.field === field) ?? (touched.has(field) ? errors.find((e) => e.field === field) : undefined);
  }

  async function save() {
    if (!valid || saving) return;
    setSaving(true);
    try {
      let result: SaveResult;
      if (!existing) {
        result = repeating
          ? await saveRecurringRule(
              db,
              { ...money, frequency, start_date: date, end_date: endDate === "" ? null : endDate },
              today,
            )
          : await saveTransaction(db, { ...money, date });
      } else {
        result = await saveTransaction(db, { ...money, id: existing.id, date });
        if (result.ok && rule) {
          // Repeating off ends the rule at this occurrence.
          const ruleInput = repeating
            ? { ...money, frequency, end_date: endDate === "" ? null : endDate }
            : { ...ruleMoney(rule), frequency: rule.frequency, end_date: date < rule.start_date ? rule.start_date : date };
          result = await saveRecurringRule(db, { ...ruleInput, id: rule.id, start_date: rule.start_date }, today);
        }
      }
      if (!result.ok) {
        setServerErrors(result.errors.map((e) => (e.field === "start_date" ? { ...e, field: "date" } : e)));
        return;
      }
      if (problemId) await deleteSyncProblem(db, problemId);
      await setDevicePref(db, LAST_ACCOUNT_PREF, accountId);
      onClose();
    } finally {
      setSaving(false);
    }
  }

  useShortcuts({ save: () => void save(), cancel: onClose });

  function changeType(next: TransactionType) {
    if (next === type) return;
    setType(next);
    setCategoryId(null);
    if (next !== "transfer") setToAccountId(null);
  }

  function remove() {
    if (!existing) return;
    requestDelete(existing.id);
    onClose();
  }

  const visibleCategories = categories.filter((c) => c.type === type);
  const textStyle = [styles.input, { color: theme.ink }];
  const title = existing ? "Edit Transaction" : `New ${TYPES.find((t) => t.value === type)?.label}`;

  return (
    <View style={[formStyles.screen, { backgroundColor: theme.paper }]}>
      <FormHeader
        title={title}
        platform={platform}
        canSave={valid && !saving}
        onCancel={onClose}
        onSave={() => void save()}
        saveTestID="transaction-save"
        theme={theme}
      />
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={formStyles.content}>
        <View style={formStyles.typeBar}>
          <SegmentedControl options={TYPES} value={type} onChange={changeType} theme={theme} />
        </View>

        <View style={[styles.amountRow, { backgroundColor: theme.row, borderBottomColor: theme.line }]}>
          <Pressable
            testID="transaction-amount"
            accessibilityRole="button"
            accessibilityLabel={`Amount, ${amount === null ? "empty" : formatAmount(amount, currency, locale)}`}
            onPress={() => setKeypadOpen((open) => !open)}
          >
            <Text allowFontScaling style={[styles.amount, { color: amountColor(type, amount, theme) }]}>
              {formatAmount(amount ?? 0, currency, locale)}
            </Text>
          </Pressable>
          {errorFor("amount_minor") ? (
            <Text allowFontScaling testID="error-amount_minor" style={[styles.error, { color: theme.listRed }]}>
              {message(errorFor("amount_minor") as FieldError, today)}
            </Text>
          ) : null}
        </View>
        {keypadOpen ? (
          <AmountKeypad
            currency={currency}
            locale={locale}
            initialExpression={expression}
            theme={theme}
            onChange={(minor, next) => {
              setAmount(minor);
              setExpression(next);
              touch("amount_minor");
            }}
          />
        ) : null}

        <GroupedSection title="Transaction Details" theme={theme}>
          <Field label="Name" error={errorFor("name")} today={today} theme={theme}>
            <TextInput
              testID="transaction-name"
              allowFontScaling
              placeholder="Name"
              placeholderTextColor={theme.accent}
              value={name}
              onChangeText={(text) => {
                setName(text);
                touch("name");
              }}
              style={textStyle}
            />
          </Field>

          <Field label="Date" error={errorFor("date")} today={today} theme={theme}>
            <TextInput
              allowFontScaling
              accessibilityLabel="Date"
              placeholder="YYYY-MM-DD"
              placeholderTextColor={theme.accent}
              value={date}
              onChangeText={(text) => {
                setDate(text);
                touch("date");
              }}
              style={textStyle}
            />
          </Field>

          {transfer ? null : (
            <Field label="Category" error={errorFor("category_id")} today={today} theme={theme}>
              <View accessibilityRole="radiogroup" accessibilityLabel="Category" style={styles.grid}>
                {visibleCategories.map((category) => {
                  const selected = category.id === categoryId;
                  return (
                    <Pressable
                      key={category.id}
                      testID={`category-option-${category.name}`}
                      accessibilityRole="radio"
                      accessibilityLabel={category.name}
                      accessibilityState={{ checked: selected }}
                      onPress={() => {
                        setCategoryId(category.id);
                        touch("category_id");
                      }}
                      style={(state) => [
                        styles.cell,
                        selected
                          ? { backgroundColor: theme.paper, borderColor: theme.accent }
                          : (isHovered(state) || state.pressed) && { backgroundColor: theme.hover },
                      ]}
                    >
                      {category.icon in categoryIcons ? (
                        <CategoryIcon
                          icon={category.icon as CategoryIconKey}
                          variant={iconStyle}
                          color={theme.ink}
                          background={selected ? theme.paper : theme.row}
                        />
                      ) : null}
                      <Text allowFontScaling numberOfLines={1} style={[styles.cellText, { color: theme.ink }]}>
                        {category.name}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </Field>
          )}

          <AccountChoice
            label={transfer ? "From" : "Account"}
            accounts={accounts}
            value={accountId}
            onChange={(next) => {
              setAccountId(next);
              touch("account_id");
            }}
            error={errorFor("account_id")}
            today={today}
            theme={theme}
          />
          {transfer ? (
            <AccountChoice
              label="To"
              accounts={accounts}
              value={toAccountId}
              onChange={(next) => {
                setToAccountId(next);
                touch("to_account_id");
              }}
              error={errorFor("to_account_id")}
              today={today}
              theme={theme}
            />
          ) : null}
        </GroupedSection>

        {canRepeat ? (
          <GroupedSection title="Repeating Details" theme={theme}>
            <FormField label="Repeating" theme={theme}>
              <View style={styles.switchValue}>
                <ThemedSwitch accessibilityLabel="Repeating" value={repeating} onValueChange={setRepeating} theme={theme} />
              </View>
            </FormField>
            {repeating ? (
              <>
                <Field label="Every" error={errorFor("frequency")} today={today} theme={theme}>
                  <View accessibilityRole="radiogroup" accessibilityLabel="Every" style={styles.chips}>
                    {FREQUENCIES.map((option) => (
                      <Chip
                        key={option.value}
                        label={option.label}
                        selected={option.value === frequency}
                        onPress={() => {
                          setFrequency(option.value);
                          touch("frequency");
                        }}
                        theme={theme}
                      />
                    ))}
                  </View>
                </Field>
                <Field label="End Date" error={errorFor("end_date")} today={today} theme={theme}>
                  <TextInput
                    allowFontScaling
                    accessibilityLabel="End Date"
                    placeholder="Never"
                    placeholderTextColor={theme.accent}
                    value={endDate}
                    onChangeText={(text) => {
                      setEndDate(text);
                      touch("end_date");
                    }}
                    style={textStyle}
                  />
                </Field>
              </>
            ) : null}
          </GroupedSection>
        ) : null}

        <GroupedSection theme={theme}>
          <Field label="Note" error={errorFor("note")} today={today} theme={theme}>
            <TextInput
              testID="transaction-note"
              allowFontScaling
              multiline
              placeholder="Add a note"
              placeholderTextColor={theme.accent}
              value={note}
              onChangeText={(text) => {
                setNote(text);
                touch("note");
              }}
              style={textStyle}
            />
          </Field>
        </GroupedSection>

        {existing ? <FormAction testID="transaction-delete" label="Delete" onPress={remove} color={theme.listRed} /> : null}
      </ScrollView>
    </View>
  );
}

function amountColor(type: TransactionType, amount: number | null, theme: ThemeColors): string {
  if (amount === null) return theme.accent;
  if (type === "expense") return theme.listRed;
  if (type === "income") return theme.listGreen;
  return theme.ink;
}

function ruleMoney(rule: RecurringRule) {
  return {
    type: rule.type,
    amount_minor: rule.amount_minor,
    name: rule.name,
    category_id: rule.category_id ?? null,
    account_id: rule.account_id,
    to_account_id: rule.to_account_id ?? null,
    note: rule.note ?? null,
  };
}

function Field({
  label,
  error,
  today,
  theme,
  children,
}: {
  label: string;
  error: FieldError | undefined;
  today: string;
  theme: ThemeColors;
  children: ReactNode;
}) {
  return (
    <FormField
      label={label}
      error={error ? message(error, today) : undefined}
      errorTestID={error ? `error-${error.field}` : undefined}
      theme={theme}
    >
      {children}
    </FormField>
  );
}

function AccountChoice({
  label,
  accounts,
  value,
  onChange,
  error,
  today,
  theme,
}: {
  label: string;
  accounts: AccountRow[];
  value: string | null;
  onChange: (id: string) => void;
  error: FieldError | undefined;
  today: string;
  theme: ThemeColors;
}) {
  return (
    <Field label={label} error={error} today={today} theme={theme}>
      <View accessibilityRole="radiogroup" accessibilityLabel={label} style={styles.chips}>
        {accounts.map((account) => (
          <Chip
            key={account.id}
            label={account.name}
            selected={account.id === value}
            onPress={() => onChange(account.id)}
            theme={theme}
          />
        ))}
      </View>
    </Field>
  );
}

function Chip({
  label,
  selected,
  onPress,
  theme,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  theme: ThemeColors;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ checked: selected }}
      onPress={onPress}
      style={(state) => [
        styles.chip,
        { borderColor: theme.accent },
        selected ? { backgroundColor: theme.accent } : (isHovered(state) || state.pressed) && { backgroundColor: theme.hover },
      ]}
    >
      <Text allowFontScaling style={[styles.chipText, { color: selected ? theme.paper : theme.accent }]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  input: {
    fontSize: 16,
    minHeight: 24,
  },
  amountRow: {
    alignItems: "flex-end",
    paddingTop: 14,
    paddingBottom: 6,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
  },
  amount: {
    fontSize: 40,
    fontWeight: "300",
    textAlign: "right",
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  cell: {
    width: 76,
    alignItems: "center",
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: "transparent",
    borderRadius: 6,
  },
  cellText: {
    fontSize: 12,
    marginTop: 2,
  },
  chips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  chip: {
    borderWidth: 1,
    borderRadius: 14,
    paddingVertical: 5,
    paddingHorizontal: 12,
    minHeight: 32,
    justifyContent: "center",
  },
  chipText: {
    fontSize: 14,
  },
  switchValue: {
    alignItems: "flex-end",
  },
  error: {
    fontSize: 13,
    marginTop: 4,
  },
});
