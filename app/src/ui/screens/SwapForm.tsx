import { usePowerSync, useQuery } from "@powersync/react";
import { useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import { deleteSwap, saveSwap } from "../../data/mutations";
import type { InstrumentRow, SwapRow, TradeRow } from "../../data/portfolio";
import { confirmDialog } from "../../data/session";
import { fromFixed, toFixed } from "../../domain/decimal";
import { today as localToday } from "../../domain/period";
import { deleteError, listError, swapLegs, swapToValue, type Close, type Oversell, type Trade } from "../../domain/portfolio";
import { normalizeDecimal, validateSwap, type FieldError, type SwapInput } from "../../domain/validation";
import { useShortcuts } from "../../hooks/useShortcuts";
import { DateField } from "../components/DateField";
import { SelectField } from "../components/SelectField";
import { useBottomInset } from "../nav/bottomInset";
import type { ThemeColors } from "../theme";
import {
  defaultPlatform,
  FormAction,
  FormField,
  FormHeader,
  formStyles,
  keyboardAppearance,
  useScreenSettings,
  type ScreenPlatform,
} from "./manage";
import { shortDate } from "./Portfolio";

type PriceRow = { instrument_id: string; date: string; close: string };

/** The fields that the over-held check reads. A change to one of them clears a server over_held error. */
const HELD_CHECK_FIELDS: ReadonlySet<string> = new Set([
  "from_instrument_id",
  "to_instrument_id",
  "date",
  "from_quantity",
  "to_quantity",
]);

type Props = {
  /** null opens an empty form with instrumentId as the "from" asset. */
  id: string | null;
  instrumentId?: string;
  platform?: ScreenPlatform;
  locale?: string;
  today?: string;
  onClose: () => void;
};

/** Loads the swap, the assets and the FX closes, then shows the form for a new or an existing swap. */
export function SwapForm({ id, instrumentId, platform, locale, today, onClose }: Props) {
  const { settings, theme } = useScreenSettings();
  const swaps = useQuery<SwapRow>(
    "SELECT id, from_instrument_id, to_instrument_id, date, from_quantity, to_quantity, fee, value, to_value, note FROM swaps",
  );
  const trades = useQuery<TradeRow>("SELECT id, instrument_id, side, date, quantity, price, fee, note FROM trades");
  const instruments = useQuery<InstrumentRow>("SELECT * FROM instruments ORDER BY symbol");
  const fxPrices = useQuery<PriceRow>(
    "SELECT p.instrument_id, p.date, p.close FROM instrument_prices p JOIN instruments i ON i.id = p.instrument_id WHERE i.kind = 'fx' ORDER BY p.date",
  );
  const existing = id ? swaps.data.find((s) => s.id === id) : undefined;
  const loading = swaps.isLoading || trades.isLoading || instruments.isLoading || fxPrices.isLoading || !settings;

  // The swap is gone (deleted on another device, or a stale link). Close instead of an empty screen.
  const gone = !loading && id !== null && !existing;
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    if (gone) close.current();
  }, [gone]);

  if (loading || !settings || (id && !existing)) return null;

  return (
    <SwapFormBody
      key={existing?.id ?? "new"}
      existing={existing}
      fromId={existing?.from_instrument_id ?? instrumentId ?? null}
      swaps={swaps.data}
      trades={trades.data}
      instruments={instruments.data}
      fxPrices={fxPrices.data}
      appCurrency={settings.currency_code}
      platform={platform ?? defaultPlatform()}
      locale={locale}
      today={today ?? localToday()}
      weekStartDay={settings.week_start_day ?? 1}
      theme={theme}
      onClose={onClose}
    />
  );
}

function quantityText(text: string): string {
  const value = toFixed(text);
  return value === null ? text : fromFixed(value);
}

/** An oversell that the swap makes, with the quantity field that shows it and the symbol of its asset. */
type HeldError = {
  field: "from_quantity" | "to_quantity";
  held: string;
  sell?: { date: string; quantity: string };
  symbol: string;
};

function SwapFormBody({
  existing,
  fromId,
  swaps,
  trades,
  instruments,
  fxPrices,
  appCurrency,
  platform,
  locale,
  today,
  weekStartDay,
  theme,
  onClose,
}: {
  existing: SwapRow | undefined;
  fromId: string | null;
  swaps: SwapRow[];
  trades: TradeRow[];
  instruments: InstrumentRow[];
  fxPrices: PriceRow[];
  appCurrency: string;
  platform: ScreenPlatform;
  locale?: string;
  today: string;
  weekStartDay: number;
  theme: ThemeColors;
  onClose: () => void;
}) {
  const db = usePowerSync();
  const bottomInset = useBottomInset();

  const [from, setFrom] = useState<string | null>(fromId);
  const [to, setTo] = useState<string | null>(existing?.to_instrument_id ?? null);
  const [date, setDate] = useState(existing?.date ?? today);
  const [fromQuantity, setFromQuantity] = useState(existing?.from_quantity ?? "");
  const [toQuantity, setToQuantity] = useState(existing?.to_quantity ?? "");
  const [fee, setFee] = useState(existing?.fee ?? "");
  const [value, setValue] = useState(existing?.value ?? "");
  // The "to" value that the user typed. Null while the form fills it from the FX closes.
  const [typedToValue, setTypedToValue] = useState<string | null>(existing?.to_value ?? null);
  const [note, setNote] = useState(existing?.note ?? "");
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const [serverErrors, setServerErrors] = useState<FieldError[]>([]);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [deleteBlocked, setDeleteBlocked] = useState<string | null>(null);
  const savingRef = useRef(false);

  const assets = instruments.filter((i) => i.kind !== "fx");
  const byId = new Map(instruments.map((i) => [i.id, i]));
  const fromAsset = from ? byId.get(from) : undefined;
  const toAsset = to ? byId.get(to) : undefined;
  const fromQuote = fromAsset?.quote_currency;
  const toQuote = toAsset?.quote_currency;
  const sameQuote = !fromQuote || !toQuote || fromQuote === toQuote;

  function fxCloses(quote: string): Close[] {
    const pair = instruments.find((i) => i.kind === "fx" && i.symbol === `${appCurrency}${quote}=X`);
    return pair ? fxPrices.filter((p) => p.instrument_id === pair.id) : [];
  }

  const convert = (amount: string) =>
    fromQuote && toQuote
      ? swapToValue(amount, fromQuote, toQuote, appCurrency, fxCloses(fromQuote), fxCloses(toQuote), date)
      : null;
  const rateMissing = !sameQuote && convert("1") === null;
  const normalizedValue = normalizeDecimal(value);
  const toValue = sameQuote
    ? normalizedValue
    : (typedToValue ?? (toFixed(normalizedValue) === null ? "" : (convert(normalizedValue) ?? "")));

  function touch(field: string) {
    setTouched((previous) => new Set(previous).add(field));
    setServerErrors((previous) =>
      previous.filter((e) => e.field !== field && !(e.code === "over_held" && HELD_CHECK_FIELDS.has(field))),
    );
  }

  const input: SwapInput = {
    ...(existing ? { id: existing.id } : {}),
    from_instrument_id: from ?? "",
    to_instrument_id: to ?? "",
    date,
    from_quantity: normalizeDecimal(fromQuantity),
    to_quantity: normalizeDecimal(toQuantity),
    fee: normalizeDecimal(fee),
    value: normalizedValue,
    to_value: normalizeDecimal(toValue),
    note: note === "" ? null : note,
  };
  const errors = validateSwap({
    ...input,
    fee: input.fee === "" ? "0" : input.fee,
  });

  function legsOf(instrumentId: string): Trade[] {
    const legs: Trade[] = trades.filter((t) => t.instrument_id === instrumentId);
    for (const swap of swaps) {
      if (swap.from_instrument_id === instrumentId) legs.push(swapLegs(swap).sell);
      if (swap.to_instrument_id === instrumentId) legs.push(swapLegs(swap).buy);
    }
    return legs;
  }

  const swapId = existing?.id ?? "";
  const symbolOf = (instrumentId: string) => byId.get(instrumentId)?.symbol ?? "?";

  function heldError(over: Oversell, instrumentId: string): HeldError {
    if (over.sell.id === swapId)
      return {
        field: "from_quantity",
        held: over.held,
        symbol: symbolOf(instrumentId),
      };
    return {
      field: instrumentId === from ? "from_quantity" : "to_quantity",
      held: over.held,
      sell: over.sell,
      symbol: symbolOf(instrumentId),
    };
  }

  function clientHeldError(): HeldError | null {
    // An invalid quantity counts as 0, so the check of one side does not wait for the other side.
    if (!from || errors.some((e) => e.field === "from_instrument_id" || e.field === "date")) return null;
    const legs = swapLegs({ ...input, id: swapId, fee: input.fee === "" ? "0" : input.fee });
    const ids = new Set([from]);
    if (to) ids.add(to);
    if (existing) {
      ids.add(existing.from_instrument_id);
      ids.add(existing.to_instrument_id);
    }
    for (const instrumentId of ids) {
      const before = legsOf(instrumentId);
      const after = before.filter((t) => t.id !== swapId);
      if (instrumentId === from) after.push(legs.sell);
      if (instrumentId === to) after.push(legs.buy);
      const over = listError(before, after, swapId);
      if (over) return heldError(over, instrumentId);
    }
    return null;
  }

  function serverHeldError(): HeldError | null {
    const error = serverErrors.find((e) => e.code === "over_held");
    if (!error || error.held === undefined) return null;
    const field = error.field === "from_quantity" ? "from_quantity" : "to_quantity";
    const sell = error.sell;
    if (!sell) return { field, held: error.held, symbol: symbolOf(from ?? "") };
    // The server names the later sell but not its asset. A swap's two legs share its id, so match sells only.
    const candidates = [from, to, existing?.from_instrument_id, existing?.to_instrument_id];
    const owner = candidates.find((id) => id && legsOf(id).some((t) => t.side === "sell" && t.id === sell.id));
    return { field, held: error.held, sell, symbol: symbolOf(owner ?? "") };
  }

  const held = clientHeldError() ?? serverHeldError();

  function laterSellText(sell: { date: string; quantity: string }, heldBefore: string, symbol: string): string {
    return `The sell of ${quantityText(sell.quantity)} ${symbol} on ${shortDate(sell.date, true)} would be more than you hold (${quantityText(heldBefore)}).`;
  }

  function errorFor(field: string): FieldError | undefined {
    return (
      serverErrors.find((e) => e.field === field) ?? (touched.has(field) ? errors.find((e) => e.field === field) : undefined)
    );
  }

  function message(field: string): string | undefined {
    if (held && held.field === field) {
      if (held.sell) return laterSellText(held.sell, held.held, held.symbol);
      return `You hold ${quantityText(held.held)} ${held.symbol} on ${shortDate(date, true)}. You cannot swap ${quantityText(input.from_quantity)}.`;
    }
    const error = errorFor(field);
    if (!error) return undefined;
    if (error.code === "invalid_reference") return "This asset is no longer on this device.";
    if (error.code === "same_instrument") return "Pick a different asset";
    if (field === "from_instrument_id" || field === "to_instrument_id") return "Pick an asset";
    if (field === "from_quantity" || field === "to_quantity") return "Enter a quantity above 0";
    if (field === "value" || field === "to_value") return "Enter a value above 0";
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
      const result = await saveSwap(db, input);
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

  async function remove() {
    if (!existing) return;
    for (const instrumentId of [existing.from_instrument_id, existing.to_instrument_id]) {
      const blocked = deleteError(legsOf(instrumentId), existing.id);
      if (blocked) {
        setDeleteBlocked(`You cannot delete this swap. ${laterSellText(blocked.sell, blocked.held, symbolOf(instrumentId))}`);
        return;
      }
    }
    if (!(await confirmDialog("Delete this swap", "Delete"))) return;
    const result = await deleteSwap(db, existing.id);
    if (!result.ok) {
      const error = result.errors[0];
      setDeleteBlocked(
        error?.sell && error.held !== undefined
          ? `You cannot delete this swap. ${laterSellText(error.sell, error.held, symbolOf(existing.to_instrument_id))}`
          : "You cannot delete this swap.",
      );
      return;
    }
    onClose();
  }

  useShortcuts(sheetOpen ? {} : { save: () => void save(), cancel: onClose });

  const keyboard = keyboardAppearance(theme);
  const inputStyle = [formStyles.input, { color: theme.ink }];
  const options = (exclude: string | null) => assets.filter((i) => i.id !== exclude).map((i) => ({ id: i.id, name: i.symbol }));
  const feeLabel = toAsset ? `Fee (${toAsset.symbol})` : "Fee";
  const valueLabel = fromQuote ? `Value (${fromQuote})` : "Value";
  const toValueLabel = `Value (${toQuote})`;

  function decimalInput(testID: string, label: string, text: string, onChange: (next: string) => void, placeholder = "0") {
    return (
      <TextInput
        testID={testID}
        accessibilityLabel={label}
        allowFontScaling
        inputMode="decimal"
        keyboardType="decimal-pad"
        keyboardAppearance={keyboard}
        inputAccessoryViewButtonLabel="Done"
        placeholder={placeholder}
        placeholderTextColor={theme.accent}
        value={text}
        onChangeText={onChange}
        style={inputStyle}
      />
    );
  }

  return (
    <View style={[formStyles.screen, { backgroundColor: theme.paper }]}>
      <FormHeader
        title={existing ? "Edit swap" : "New swap"}
        platform={platform}
        canSave={!saving && held === null}
        onCancel={onClose}
        onSave={() => void save()}
        saveTestID="swap-save"
        theme={theme}
      />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={[formStyles.content, { paddingBottom: formStyles.content.paddingBottom + bottomInset }]}
      >
        {failed ? (
          <Text allowFontScaling accessibilityRole="alert" style={[formStyles.error, { color: theme.listRed }]}>
            Could not save. Try again.
          </Text>
        ) : null}

        <FormField label="From" error={message("from_instrument_id")} theme={theme}>
          <SelectField
            label="From"
            testID="swap-from"
            optionTestIDPrefix="swap-from-option-"
            placeholder="Select an asset"
            options={options(to)}
            value={from}
            onChange={(next) => {
              if (byId.get(next ?? "")?.quote_currency !== fromQuote) setTypedToValue(null);
              setFrom(next);
              touch("from_instrument_id");
            }}
            onOpenChange={setSheetOpen}
            theme={theme}
          />
        </FormField>

        <FormField label="Quantity given" error={message("from_quantity")} errorTestID="error-from_quantity" theme={theme}>
          {decimalInput("swap-from-quantity", "Quantity given", fromQuantity, (text) => {
            setFromQuantity(text);
            touch("from_quantity");
          })}
        </FormField>

        <FormField label="To" error={message("to_instrument_id")} theme={theme}>
          <SelectField
            label="To"
            testID="swap-to"
            optionTestIDPrefix="swap-to-option-"
            placeholder="Select an asset"
            options={options(from)}
            value={to}
            onChange={(next) => {
              // A typed "to" value is in the old quote currency.
              if (byId.get(next ?? "")?.quote_currency !== toQuote) setTypedToValue(null);
              setTo(next);
              touch("to_instrument_id");
            }}
            onOpenChange={setSheetOpen}
            theme={theme}
          />
        </FormField>

        <FormField label="Quantity received" error={message("to_quantity")} errorTestID="error-to_quantity" theme={theme}>
          {decimalInput("swap-to-quantity", "Quantity received", toQuantity, (text) => {
            setToQuantity(text);
            touch("to_quantity");
          })}
        </FormField>

        <FormField label={feeLabel} error={message("fee")} theme={theme}>
          {decimalInput("swap-fee", feeLabel, fee, (text) => {
            setFee(text);
            touch("fee");
          })}
        </FormField>

        <FormField label="Date" error={message("date")} theme={theme}>
          <DateField
            testID="swap-date"
            value={date}
            onChange={(next) => {
              setDate(next);
              touch("date");
            }}
            accessibilityLabel="Date"
            weekStartDay={weekStartDay}
            onOpenChange={setSheetOpen}
            locale={locale}
            today={today}
            theme={theme}
          />
        </FormField>

        <FormField label={valueLabel} error={message("value")} errorTestID="error-value" theme={theme}>
          {decimalInput(
            "swap-value",
            valueLabel,
            value,
            (text) => {
              setValue(text);
              touch("value");
            },
            "0.00",
          )}
        </FormField>

        {sameQuote ? null : (
          <FormField label={toValueLabel} error={message("to_value")} errorTestID="error-to_value" theme={theme}>
            {decimalInput(
              "swap-to-value",
              toValueLabel,
              toValue,
              (text) => {
                setTypedToValue(text);
                touch("to_value");
              },
              "0.00",
            )}
            {rateMissing && typedToValue === null && !message("to_value") ? (
              <Text allowFontScaling style={[styles.hint, { color: theme.accent }]}>
                No exchange rate for this date. Enter the value.
              </Text>
            ) : null}
          </FormField>
        )}

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
        {existing ? <FormAction testID="swap-delete" label="Delete" onPress={() => void remove()} color={theme.listRed} /> : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  hint: {
    fontSize: 12,
    marginTop: 4,
  },
});
