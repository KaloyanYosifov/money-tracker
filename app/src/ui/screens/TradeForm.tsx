import { usePowerSync, useQuery } from "@powersync/react";
import { useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import { deleteTrade, saveTrade } from "../../data/mutations";
import { useInstrument, type InstrumentDetail, type TradeRow } from "../../data/portfolio";
import { confirmDialog } from "../../data/session";
import { fromFixed, toFixed } from "../../domain/decimal";
import { today as localToday } from "../../domain/period";
import { deleteError, sellError } from "../../domain/portfolio";
import { normalizeDecimal, validateTrade, type FieldError, type TradeInput } from "../../domain/validation";
import type { Trade } from "../../generated/schema";
import { useShortcuts } from "../../hooks/useShortcuts";
import { DateField } from "../components/DateField";
import { SegmentedControl } from "../components/SegmentedControl";
import { useBottomInset } from "../nav/bottomInset";
import type { ThemeColors } from "../theme";
import {
  defaultPlatform,
  FormAction,
  FormField,
  FormHeader,
  FormNote,
  formStyles,
  keyboardAppearance,
  useScreenSettings,
  type ScreenPlatform,
} from "./manage";
import { shortDate } from "./Portfolio";

type Side = Trade["side"];

const SIDES: { value: Side; label: string }[] = [
  { value: "buy", label: "Buy" },
  { value: "sell", label: "Sell" },
];

/** The fields that the over-held check reads. A change to one of them clears a server over_held error. */
const SELL_CHECK_FIELDS: ReadonlySet<string> = new Set(["side", "date", "quantity"]);

type Props = {
  /** null opens an empty form for instrumentId. */
  id: string | null;
  instrumentId?: string;
  platform?: ScreenPlatform;
  locale?: string;
  today?: string;
  onClose: () => void;
};

/** Loads the trade and its instrument, then shows the form for a new or an existing trade. */
export function TradeForm({ id, instrumentId, platform, locale, today, onClose }: Props) {
  const { settings, theme } = useScreenSettings();
  const trade = useQuery<TradeRow>(
    "SELECT id, instrument_id, side, date, quantity, price, fee, note FROM trades WHERE id = ?",
    [id ?? ""],
  );
  const existing = id ? trade.data.find((t) => t.id === id) : undefined;
  const { data: detail, isLoading } = useInstrument(existing?.instrument_id ?? instrumentId ?? "");
  const loading = trade.isLoading || isLoading;

  // The trade is gone (deleted on another device, or a stale link). Close instead of an empty screen.
  const gone = !loading && id !== null && !existing;
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    if (gone) close.current();
  }, [gone]);

  if (loading || (id && !existing)) return null;

  const resolvedPlatform = platform ?? defaultPlatform();
  if (!detail) {
    // A new asset shows here only after the next sync.
    return (
      <View style={[formStyles.screen, { backgroundColor: theme.paper }]}>
        <FormHeader title="New trade" platform={resolvedPlatform} canSave={false} onCancel={onClose} onSave={() => {}} theme={theme} />
        <FormNote text="The asset is not on this device yet. It shows after the next sync." theme={theme} />
      </View>
    );
  }

  return (
    <TradeFormBody
      key={existing?.id ?? "new"}
      existing={existing}
      detail={detail}
      platform={resolvedPlatform}
      locale={locale}
      today={today ?? localToday()}
      weekStartDay={settings?.week_start_day ?? 1}
      theme={theme}
      onClose={onClose}
    />
  );
}

/** The close on the date, or the last close before it. */
function closeOn(prices: InstrumentDetail["holding"]["prices"], date: string): { date: string; text: string } | null {
  let found: (typeof prices)[number] | null = null;
  for (const price of prices) {
    if (price.date > date) break;
    found = price;
  }
  return found ? { date: found.date, text: fromFixed(found.close) } : null;
}

function quantityText(text: string): string {
  const value = toFixed(text);
  return value === null ? text : fromFixed(value);
}

function TradeFormBody({
  existing,
  detail,
  platform,
  locale,
  today,
  weekStartDay,
  theme,
  onClose,
}: {
  existing: TradeRow | undefined;
  detail: InstrumentDetail;
  platform: ScreenPlatform;
  locale?: string;
  today: string;
  weekStartDay: number;
  theme: ThemeColors;
  onClose: () => void;
}) {
  const db = usePowerSync();
  const bottomInset = useBottomInset();
  const { instrument, holding } = detail;
  const currency = holding.quoteCurrency;
  const initialDate = existing?.date ?? today;
  const initialClose = existing ? null : closeOn(holding.prices, initialDate);

  const [side, setSide] = useState<Side>(existing?.side ?? "buy");
  const [date, setDate] = useState(initialDate);
  const [quantity, setQuantity] = useState(existing?.quantity ?? "");
  const [price, setPrice] = useState(existing?.price ?? initialClose?.text ?? "");
  // The date of the close in the price field. Null after the user types a price.
  const [priceCloseDate, setPriceCloseDate] = useState<string | null>(initialClose?.date ?? null);
  const [fee, setFee] = useState(existing?.fee ?? "");
  const [note, setNote] = useState(existing?.note ?? "");
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const [serverErrors, setServerErrors] = useState<FieldError[]>([]);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [deleteBlocked, setDeleteBlocked] = useState<string | null>(null);
  const savingRef = useRef(false);

  function touch(field: string) {
    setTouched((previous) => new Set(previous).add(field));
    setServerErrors((previous) =>
      previous.filter((e) => e.field !== field && !(e.code === "over_held" && SELL_CHECK_FIELDS.has(field))),
    );
  }

  const input: TradeInput = {
    ...(existing ? { id: existing.id } : {}),
    instrument_id: instrument.id,
    side,
    date,
    quantity: normalizeDecimal(quantity),
    price: normalizeDecimal(price),
    fee: normalizeDecimal(fee),
    note: note === "" ? null : note,
  };
  const errors = validateTrade({ ...input, fee: input.fee === "" ? "0" : input.fee });
  const candidateId = existing?.id ?? "";
  const over =
    errors.some((e) => e.field === "quantity" || e.field === "date")
      ? null
      : sellError(detail.trades, { id: candidateId, side, date, quantity: input.quantity, price: "0", fee: "0" });
  const overError = serverErrors.find((e) => e.code === "over_held");
  const held = over?.held ?? overError?.held ?? null;
  const laterSell = over ? (over.sell.id === candidateId ? undefined : over.sell) : overError?.sell;

  function errorFor(field: string): FieldError | undefined {
    return serverErrors.find((e) => e.field === field) ?? (touched.has(field) ? errors.find((e) => e.field === field) : undefined);
  }

  function message(field: string): string | undefined {
    if (field === "quantity" && held !== null && laterSell) return laterSellText(laterSell, held);
    if (field === "quantity" && held !== null) {
      return `You hold ${quantityText(held)} ${holding.symbol} on ${shortDate(date, true)}. You cannot sell ${quantityText(input.quantity)}.`;
    }
    const error = errorFor(field);
    if (!error) return undefined;
    if (field === "quantity") return "Enter a quantity above 0";
    if (field === "price") return "Enter a price above 0";
    if (field === "fee") return "Enter a fee, for example 1.00";
    if (field === "date") return `Use a date like ${today}`;
    if (field === "note") return "Too long";
    return "Not valid";
  }

  async function save() {
    if (savingRef.current || held !== null) return;
    if (errors.length > 0) {
      setTouched((previous) => new Set([...previous, ...errors.map((e) => e.field)]));
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setFailed(false);
    try {
      const result = await saveTrade(db, input);
      if (!result.ok) {
        setServerErrors(result.errors);
        return;
      }
      onClose();
    } catch {
      setFailed(true);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  function laterSellText(sell: { date: string; quantity: string }, heldBefore: string): string {
    return `The sell of ${quantityText(sell.quantity)} ${holding.symbol} on ${shortDate(sell.date, true)} would be more than you hold (${quantityText(heldBefore)}).`;
  }

  async function remove() {
    if (!existing) return;
    const blocked = deleteError(detail.trades, existing.id);
    if (blocked) {
      setDeleteBlocked(`You cannot delete this trade. ${laterSellText(blocked.sell, blocked.held)}`);
      return;
    }
    if (!(await confirmDialog("Delete this trade", "Delete"))) return;
    const result = await deleteTrade(db, existing.id);
    if (!result.ok) {
      const error = result.errors[0];
      setDeleteBlocked(
        error?.sell && error.held !== undefined
          ? `You cannot delete this trade. ${laterSellText(error.sell, error.held)}`
          : "You cannot delete this trade.",
      );
      return;
    }
    onClose();
  }

  useShortcuts(sheetOpen ? {} : { save: () => void save(), cancel: onClose });

  function changeDate(next: string) {
    setDate(next);
    touch("date");
    if (priceCloseDate === null && price !== "") return;
    const close = closeOn(holding.prices, next);
    if (close) {
      setPrice(close.text);
      setPriceCloseDate(close.date);
    }
  }

  const keyboard = keyboardAppearance(theme);
  const inputStyle = [formStyles.input, { color: theme.ink }];
  const priceLabel = `Price per ${instrument.kind === "crypto" ? "coin" : "share"} (${currency})`;
  const instrumentError = serverErrors.find((e) => e.field === "instrument_id");

  return (
    <View style={[formStyles.screen, { backgroundColor: theme.paper }]}>
      <FormHeader
        title={existing ? "Edit trade" : "New trade"}
        platform={platform}
        canSave={!saving && held === null}
        onCancel={onClose}
        onSave={() => void save()}
        saveTestID="trade-save"
        theme={theme}
      />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={[formStyles.content, { paddingBottom: formStyles.content.paddingBottom + bottomInset }]}
      >
        <View style={[styles.card, { backgroundColor: theme.row, borderBottomColor: theme.line }]}>
          <View style={styles.titleRow}>
            <Text allowFontScaling style={[styles.title, { color: theme.ink }]}>
              {instrument.name}
            </Text>
            <Text allowFontScaling style={[styles.badge, { color: theme.accent, borderColor: theme.accent }]}>
              {currency}
            </Text>
          </View>
          <Text allowFontScaling style={[styles.sub, { color: theme.accent }]}>
            {`${holding.symbol} · You hold ${fromFixed(holding.quantity)}`}
          </Text>
        </View>

        {failed || instrumentError ? (
          <Text allowFontScaling accessibilityRole="alert" style={[formStyles.error, { color: theme.listRed }]}>
            {instrumentError ? "This asset is no longer on this device." : "Could not save. Try again."}
          </Text>
        ) : null}

        <View style={formStyles.typeBar}>
          <SegmentedControl
            options={SIDES}
            value={side}
            onChange={(next) => {
              setSide(next);
              touch("side");
            }}
            theme={theme}
          />
        </View>

        <FormField label="Date" error={message("date")} theme={theme}>
          <DateField
            testID="trade-date"
            value={date}
            onChange={changeDate}
            accessibilityLabel="Date"
            weekStartDay={weekStartDay}
            onOpenChange={setSheetOpen}
            locale={locale}
            today={today}
            theme={theme}
          />
        </FormField>

        <FormField label="Quantity" error={message("quantity")} errorTestID="error-quantity" theme={theme}>
          <TextInput
            testID="trade-quantity"
            accessibilityLabel="Quantity"
            allowFontScaling
            autoFocus={!existing}
            inputMode="decimal"
            keyboardType="decimal-pad"
            keyboardAppearance={keyboard}
            inputAccessoryViewButtonLabel="Done"
            placeholder="0"
            placeholderTextColor={theme.accent}
            value={quantity}
            onChangeText={(text) => {
              setQuantity(text);
              touch("quantity");
            }}
            style={inputStyle}
          />
          {message("quantity") ? null : <Hint text="Fractions allowed" theme={theme} />}
        </FormField>

        <FormField label={priceLabel} error={message("price")} theme={theme}>
          <TextInput
            testID="trade-price"
            accessibilityLabel={priceLabel}
            allowFontScaling
            inputMode="decimal"
            keyboardType="decimal-pad"
            keyboardAppearance={keyboard}
            inputAccessoryViewButtonLabel="Done"
            placeholder="0.00"
            placeholderTextColor={theme.accent}
            value={price}
            onChangeText={(text) => {
              setPrice(text);
              setPriceCloseDate(null);
              touch("price");
            }}
            style={inputStyle}
          />
          {priceCloseDate !== null && !message("price") ? (
            <Hint text={`Close of ${shortDate(priceCloseDate, true)}. You can change it.`} theme={theme} />
          ) : null}
        </FormField>

        <FormField label={`Fee (${currency})`} error={message("fee")} theme={theme}>
          <TextInput
            testID="trade-fee"
            accessibilityLabel={`Fee (${currency})`}
            allowFontScaling
            inputMode="decimal"
            keyboardType="decimal-pad"
            keyboardAppearance={keyboard}
            inputAccessoryViewButtonLabel="Done"
            placeholder="0.00"
            placeholderTextColor={theme.accent}
            value={fee}
            onChangeText={(text) => {
              setFee(text);
              touch("fee");
            }}
            style={inputStyle}
          />
        </FormField>

        <FormField label="Note" error={message("note")} theme={theme}>
          <TextInput
            accessibilityLabel="Note"
            allowFontScaling
            multiline
            placeholder="Optional"
            placeholderTextColor={theme.accent}
            keyboardAppearance={keyboard}
            value={note}
            onChangeText={(text) => {
              setNote(text);
              touch("note");
            }}
            style={inputStyle}
          />
        </FormField>

        {deleteBlocked ? (
          <Text allowFontScaling accessibilityRole="alert" style={[formStyles.error, { color: theme.listRed }]}>
            {deleteBlocked}
          </Text>
        ) : null}
        {existing ? <FormAction testID="trade-delete" label="Delete" onPress={() => void remove()} color={theme.listRed} /> : null}
      </ScrollView>
    </View>
  );
}

function Hint({ text, theme }: { text: string; theme: ThemeColors }) {
  return (
    <Text allowFontScaling style={[styles.hint, { color: theme.accent }]}>
      {text}
    </Text>
  );
}

const styles = StyleSheet.create({
  card: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  title: {
    flexShrink: 1,
    fontSize: 20,
  },
  badge: {
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.5,
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  sub: {
    fontSize: 12,
    marginTop: 2,
  },
  hint: {
    fontSize: 12,
    marginTop: 4,
  },
});
