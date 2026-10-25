import { usePowerSync, useQuery } from "@powersync/react";
import { useContext, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";

import {
  acceptBudgetCard,
  acceptRecurringCard,
  askQuestion,
  dismissCard,
  MAX_QUESTION_LENGTH,
  parseAction,
  useLastRunTime,
  useOpenCards,
  useQuestions,
  type AcceptResult,
  type BudgetAction,
  type InsightCard,
  type InsightQuestionRow,
  type RecurringAction,
} from "../../data/insights";
import type { FieldError } from "../../data/mutations";
import { amountInputText, formatAmount, parseAmount } from "../../domain/money";
import { today as localToday } from "../../domain/period";
import type { Account, Category, UserSettings } from "../../generated/schema";
import { useLayoutMode } from "../../hooks/useLayoutMode";
import { GroupedSection } from "../components/GroupedSection";
import { isHovered } from "../components/interaction";
import { SelectField } from "../components/SelectField";
import { useCloseWithOverlays } from "../overlays";
import type { ThemeColors } from "../theme";
import { FormField, formStyles, keyboardAppearance, useScreenSettings } from "./manage";

const KIND_LABEL: Record<InsightCard["kind"], string> = {
  tip: "Tip",
  budget: "Budget",
  recurring_rule: "Recurring rule",
};

const ACCEPT_LABEL: Partial<Record<InsightCard["kind"], string>> = {
  budget: "Set budget",
  recurring_rule: "Add recurring rule",
};

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function lastRunText(last: string | null): string {
  if (!last) return "No run yet";
  const when = new Date(last).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return `Updated ${when}`;
}

function errorText(errors: FieldError[]): string {
  const error = errors[0];
  if (error?.field === "amount_minor") return "Enter an amount above 0";
  if (error?.field === "account_id") return "Pick an account";
  if (error?.field === "name") return "Enter a name";
  return "Check the values";
}

/**
 * The accept sheet works on a card. An answer with an action has no card, so
 * it becomes one with the question id. The accept then writes the record, and
 * its status update matches no card.
 */
function answerCard(question: InsightQuestionRow): InsightCard | null {
  if (question.status !== "answered" || !question.action) return null;
  const kind: InsightCard["kind"] = question.action.includes('"frequency"') ? "recurring_rule" : "budget";
  const result: InsightCard = {
    id: question.id,
    user_id: question.user_id,
    kind,
    title: "",
    body: "",
    fingerprint: "",
    status: "open",
    action: question.action,
  };
  return parseAction(result) ? result : null;
}

type Props = {
  today?: string;
};

/** The AI Insights page: the suggestions of the daily run, and questions about a category. */
export function InsightsScreen({ today = localToday() }: Props) {
  const db = usePowerSync();
  const { settings, theme } = useScreenSettings();
  const currency = settings?.currency_code ?? "EUR";
  const cards = useOpenCards().data;
  const lastRun = useLastRunTime();
  const categories = useQuery<Category>("SELECT * FROM categories ORDER BY type, sort_order, name").data;
  const accounts = useQuery<Account>("SELECT * FROM accounts WHERE archived_at IS NULL ORDER BY sort_order, name").data;
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const questions = useQuestions(categoryId).data;
  const [text, setText] = useState("");
  const [askError, setAskError] = useState<string | null>(null);
  const [open, setOpen] = useState<InsightCard | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // An answer has no status, so an accepted answer action hides only until the page reloads.
  const [acceptedAnswers, setAcceptedAnswers] = useState<string[]>([]);

  const categoryName = (id: string) => categories.find((c) => c.id === id)?.name ?? "";
  const options = categories.filter((c) => !c.archived_at).map((c) => ({ id: c.id, name: c.name, icon: c.icon }));

  async function ask(id: string, question: string) {
    const result = await askQuestion(db, id, question);
    if (result.ok) {
      setText("");
      setAskError(null);
    } else {
      const error = result.errors[0];
      setAskError(error?.message ?? (error?.code === "too_long" ? "Too long" : "Required"));
    }
  }

  function closeSheet(result: AcceptResult) {
    if (!open) return;
    if ("outOfDate" in result) setNotice("The suggestion no longer matches your data, so it is dismissed.");
    else setNotice(null);
    if (result.ok && !cards.some((c) => c.id === open.id)) setAcceptedAnswers((ids) => [...ids, open.id]);
    setOpen(null);
  }

  return (
    <ScrollView style={{ backgroundColor: theme.row }} contentContainerStyle={styles.content}>
      <Text allowFontScaling testID="insights-last-run" style={[styles.lastRun, { color: theme.accent }]}>
        {lastRunText(lastRun)}
      </Text>

      <GroupedSection title="Suggestions" theme={theme}>
        {notice ? (
          <Text allowFontScaling style={[styles.notice, { backgroundColor: theme.carryOver, color: theme.ink }]}>
            {notice}
          </Text>
        ) : null}
        {cards.length === 0 ? (
          <Text allowFontScaling style={[styles.empty, { color: theme.accent }]}>
            No suggestions yet.
          </Text>
        ) : (
          cards.map((card) => {
            const acceptLabel = parseAction(card) ? ACCEPT_LABEL[card.kind] : undefined;
            return (
              <View key={card.id} testID={`insight-card-${card.id}`} style={[styles.card, { borderColor: theme.line, backgroundColor: theme.paper }]}>
                <Text allowFontScaling style={[styles.kind, { color: theme.accent }]}>
                  {KIND_LABEL[card.kind]}
                </Text>
                <Text allowFontScaling style={[styles.title, { color: theme.ink }]}>
                  {card.title}
                </Text>
                <Text allowFontScaling style={[styles.body, { color: theme.ink }]}>
                  {card.body}
                </Text>
                <View style={styles.buttons}>
                  <Button label="Dismiss" theme={theme} onPress={() => void dismissCard(db, card.id)} />
                  {acceptLabel ? <Button label={acceptLabel} primary theme={theme} onPress={() => setOpen(card)} /> : null}
                </View>
              </View>
            );
          })
        )}
      </GroupedSection>

      <GroupedSection title="Ask about a category" theme={theme}>
        <View style={[styles.ask, { borderBottomColor: theme.line }]}>
          <SelectField
            label="Category"
            options={options}
            value={categoryId}
            onChange={setCategoryId}
            iconStyle={settings?.icon_style}
            placeholder="Select a category"
            theme={theme}
            testID="ask-category"
            optionTestIDPrefix="ask-category-"
          />
          <TextInput
            allowFontScaling
            testID="ask-question"
            accessibilityLabel="Question"
            placeholder={categoryId ? `Ask a question about ${categoryName(categoryId)}` : "Ask a question"}
            placeholderTextColor={theme.accent}
            keyboardAppearance={keyboardAppearance(theme)}
            multiline
            maxLength={MAX_QUESTION_LENGTH}
            value={text}
            onChangeText={setText}
            style={[styles.question, { color: theme.ink, borderColor: theme.line, backgroundColor: theme.paper }]}
          />
          {askError ? (
            <Text allowFontScaling style={[styles.error, { color: theme.listRed }]}>
              {askError}
            </Text>
          ) : null}
          <View style={styles.buttons}>
            <Button label="Ask" primary disabled={!categoryId} theme={theme} onPress={() => categoryId && void ask(categoryId, text)} />
          </View>
        </View>

        {questions.map((question) => {
          const action = acceptedAnswers.includes(question.id) ? null : answerCard(question);
          return (
            <View key={question.id} testID={`question-${question.id}`} style={[styles.qa, { borderBottomColor: theme.line }]}>
              <Text allowFontScaling style={[styles.questionText, { color: theme.ink }]}>
                {question.question}
              </Text>
              {question.status === "pending" ? (
                <Text allowFontScaling style={[styles.pending, { color: theme.accent }]}>
                  Waiting for answer
                </Text>
              ) : question.status === "failed" ? (
                <>
                  <Text allowFontScaling style={[styles.body, { color: theme.listRed }]}>
                    {question.error ?? "The question failed."}
                  </Text>
                  <View style={styles.buttons}>
                    <Button label="Ask again" theme={theme} onPress={() => void ask(question.category_id, question.question)} />
                  </View>
                </>
              ) : (
                <Text allowFontScaling style={[styles.body, { color: theme.ink }]}>
                  {question.answer}
                </Text>
              )}
              {action ? (
                <View testID="answer-action" style={[styles.mini, { borderColor: theme.accent, backgroundColor: theme.paper }]}>
                  <Text allowFontScaling style={[styles.body, { color: theme.ink }]}>
                    {actionSummary(action, categoryName, currency)}
                  </Text>
                  <View style={styles.buttons}>
                    <Button label={ACCEPT_LABEL[action.kind] ?? ""} primary theme={theme} onPress={() => setOpen(action)} />
                  </View>
                </View>
              ) : null}
            </View>
          );
        })}
      </GroupedSection>

      {open ? (
        <AcceptSheet
          card={open}
          categoryName={categoryName}
          accounts={accounts}
          settings={settings}
          currency={currency}
          theme={theme}
          onCancel={() => setOpen(null)}
          onSave={async (amountMinor, recurring) => {
            const result =
              open.kind === "budget"
                ? await acceptBudgetCard(db, open, amountMinor)
                : await acceptRecurringCard(db, open, today, { amount_minor: amountMinor, ...recurring });
            if (result.ok || "outOfDate" in result) closeSheet(result);
            return result;
          }}
        />
      ) : null}
    </ScrollView>
  );
}

function actionSummary(card: InsightCard, categoryName: (id: string) => string, currency: string): string {
  const action = parseAction(card);
  if (!action) return "";
  const amount = formatAmount(action.amount_minor, currency);
  if (card.kind === "budget") return `Budget · ${categoryName(action.category_id)} · ${amount}`;
  const rule = action as RecurringAction;
  return `Recurring rule · ${rule.name} · ${amount} · ${capitalized(rule.frequency)}`;
}

type RecurringChanges = { name: string; account_id: string };

type SheetProps = {
  card: InsightCard;
  categoryName: (id: string) => string;
  accounts: Account[];
  settings: UserSettings | undefined;
  currency: string;
  theme: ThemeColors;
  onCancel: () => void;
  /** Returns the result of the accept. The sheet shows its errors. */
  onSave: (amountMinor: number, recurring?: RecurringChanges) => Promise<AcceptResult>;
};

/** The values of a suggestion to check before Save. A bottom sheet on the phone, a centered card on the wide layout. */
function AcceptSheet({ card, categoryName, accounts, settings, currency, theme, onCancel, onSave }: SheetProps) {
  const wide = useLayoutMode() === "sidebar";
  const bottomInset = useContext(SafeAreaInsetsContext)?.bottom ?? 0;
  const action = parseAction(card) as BudgetAction | RecurringAction;
  const rule = card.kind === "recurring_rule" ? (action as RecurringAction) : null;
  const [amountText, setAmountText] = useState(amountInputText(action.amount_minor, currency));
  const [name, setName] = useState(rule?.name ?? "");
  const [accountId, setAccountId] = useState<string | null>(rule?.account_id ?? null);
  const [error, setError] = useState<string | null>(null);
  useCloseWithOverlays(true, onCancel);

  async function save() {
    const amountMinor = parseAmount(amountText, currency);
    if (amountMinor === null) {
      setError("Enter an amount above 0");
      return;
    }
    const result = await onSave(amountMinor, rule ? { name, account_id: accountId ?? "" } : undefined);
    if (!result.ok && "errors" in result) setError(errorText(result.errors));
  }

  const title = rule ? "Recurring rule" : `Budget for ${categoryName(action.category_id)}`;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onCancel}>
      <View style={[styles.root, wide && styles.rootWide]}>
        <Pressable accessibilityLabel="Close" style={styles.backdrop} onPress={onCancel} />
        <View
          accessibilityViewIsModal
          testID={wide ? "accept-sheet-card" : "accept-sheet"}
          style={[
            wide ? styles.sheetCard : [styles.sheet, { paddingBottom: Math.max(styles.sheet.paddingBottom, bottomInset) }],
            { backgroundColor: theme.row },
          ]}
        >
          <Text allowFontScaling accessibilityRole="header" style={[styles.sheetTitle, { color: theme.ink }]}>
            {title}
          </Text>
          <Text allowFontScaling style={[styles.why, { color: theme.accent }]}>
            From an AI suggestion. Check the values before you save.
          </Text>
          <FormField label="Category" theme={theme}>
            <Text allowFontScaling testID="accept-category" style={[formStyles.input, { color: theme.ink }]}>
              {categoryName(action.category_id)}
            </Text>
          </FormField>
          {rule ? (
            <>
              <FormField label="Name" theme={theme}>
                <TextInput
                  allowFontScaling
                  accessibilityLabel="Name"
                  keyboardAppearance={keyboardAppearance(theme)}
                  value={name}
                  onChangeText={setName}
                  style={[formStyles.input, { color: theme.ink }]}
                />
              </FormField>
              <FormField label="Account" theme={theme}>
                <SelectField
                  label="Account"
                  options={accounts.map((a) => ({ id: a.id, name: a.name }))}
                  value={accountId}
                  onChange={setAccountId}
                  placeholder="Pick an account"
                  theme={theme}
                />
              </FormField>
              <FormField label="Repeats" theme={theme}>
                <Text allowFontScaling style={[formStyles.input, { color: theme.ink }]}>
                  {`${capitalized(rule.frequency)} from ${rule.start_date}`}
                </Text>
              </FormField>
            </>
          ) : (
            <FormField label="Period" theme={theme}>
              <Text allowFontScaling style={[formStyles.input, { color: theme.ink }]}>
                {`${capitalized(settings?.time_period ?? "monthly")} (from Settings)`}
              </Text>
            </FormField>
          )}
          <FormField label="Amount" error={error ?? undefined} theme={theme}>
            <TextInput
              allowFontScaling
              accessibilityLabel="Amount"
              keyboardType="decimal-pad"
              keyboardAppearance={keyboardAppearance(theme)}
              value={amountText}
              onChangeText={setAmountText}
              style={[formStyles.input, { color: theme.ink }]}
            />
          </FormField>
          <View style={[styles.buttons, styles.sheetButtons]}>
            <Button label="Cancel" theme={theme} onPress={onCancel} />
            <Button label="Save" primary theme={theme} onPress={() => void save()} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

function Button({
  label,
  onPress,
  primary = false,
  disabled = false,
  theme,
}: {
  label: string;
  onPress: () => void;
  primary?: boolean;
  disabled?: boolean;
  theme: ThemeColors;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={(state) => [
        styles.button,
        { borderColor: theme.accent },
        primary ? { backgroundColor: theme.accent } : (isHovered(state) || state.pressed) && { backgroundColor: theme.hover },
        (disabled || (primary && state.pressed)) && styles.dim,
      ]}
    >
      <Text allowFontScaling style={[styles.buttonText, { color: primary ? theme.paper : theme.accent }]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingBottom: 24,
  },
  lastRun: {
    fontSize: 12,
    paddingTop: 12,
    paddingHorizontal: 14,
  },
  notice: {
    fontSize: 13,
    margin: 12,
    marginBottom: 0,
    padding: 10,
    borderRadius: 8,
  },
  empty: {
    fontSize: 14,
    textAlign: "center",
    paddingVertical: 28,
  },
  card: {
    marginHorizontal: 12,
    marginTop: 12,
    padding: 12,
    borderWidth: 1,
    borderRadius: 12,
  },
  kind: {
    fontSize: 11,
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  title: {
    fontSize: 15,
    fontWeight: "600",
    marginTop: 4,
    marginBottom: 4,
  },
  body: {
    fontSize: 13.5,
    lineHeight: 19,
  },
  buttons: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 8,
    marginTop: 10,
  },
  button: {
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  buttonText: {
    fontSize: 13,
  },
  dim: {
    opacity: 0.6,
  },
  ask: {
    padding: 12,
    gap: 8,
    borderBottomWidth: 1,
  },
  question: {
    minHeight: 44,
    fontSize: 15,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  error: {
    fontSize: 12,
  },
  qa: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderBottomWidth: 1,
    gap: 4,
  },
  questionText: {
    fontSize: 14,
    fontWeight: "600",
  },
  pending: {
    fontSize: 13.5,
    fontStyle: "italic",
  },
  mini: {
    marginTop: 6,
    padding: 10,
    borderWidth: 1,
    borderStyle: "dashed",
    borderRadius: 10,
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
  sheet: {
    marginTop: "auto",
    width: "100%",
    maxWidth: 520,
    alignSelf: "center",
    paddingHorizontal: 12,
    paddingTop: 14,
    paddingBottom: 24,
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
  },
  sheetCard: {
    width: "100%",
    maxWidth: 420,
    padding: 16,
    borderRadius: 8,
    shadowColor: "#3c2314",
    shadowOpacity: 0.35,
    shadowRadius: 30,
    shadowOffset: { width: 0, height: 10 },
  },
  sheetTitle: {
    fontSize: 17,
    fontWeight: "600",
    paddingHorizontal: 4,
  },
  why: {
    fontSize: 13,
    paddingHorizontal: 4,
    paddingTop: 4,
    paddingBottom: 10,
  },
  sheetButtons: {
    marginTop: 14,
  },
});
