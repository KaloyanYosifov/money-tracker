import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import type { InstrumentKind, InstrumentsApi, InstrumentsError, SearchResult } from "../../data/instrumentsApi";
import { useShortcuts } from "../../hooks/useShortcuts";
import { isHovered } from "../components/interaction";
import { useBottomInset } from "../nav/bottomInset";
import type { ThemeColors } from "../theme";
import { FormField, formStyles, keyboardAppearance, useScreenSettings } from "./manage";

export const SEARCH_DELAY_MS = 300;
const MIN_QUERY = 2;

const KIND_LABELS: Record<InstrumentKind, string> = {
  stock: "Stock",
  etf: "ETF",
  crypto: "Crypto",
  fx: "Currency",
};

const RATE_LIMITED = "Too many searches. Wait a minute.";

type Props = {
  api: InstrumentsApi;
  onCancel: () => void;
  /** Gets the id of the added instrument. */
  onAdded: (instrumentId: string) => void;
};

type Search =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "done"; results: SearchResult[] }
  | { state: "failed"; error: InstrumentsError };

function resultLine(result: SearchResult): string {
  return [result.symbol, result.exchange, KIND_LABELS[result.kind]].filter(Boolean).join(" · ");
}

/** Search on Yahoo Finance and add an asset. Needs the network. */
export function AddInstrumentScreen({ api, onCancel, onAdded }: Props) {
  const { theme } = useScreenSettings();
  const bottomInset = useBottomInset();
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<Search>({ state: "idle" });
  const [adding, setAdding] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  // Only the answer to the last request counts. An older answer can arrive later.
  const requestRef = useRef(0);

  useEffect(() => {
    const text = query.trim();
    const request = ++requestRef.current;
    if (text.length < MIN_QUERY) return;
    const timer = setTimeout(() => {
      setSearch({ state: "loading" });
      void api.search(text).then((result) => {
        if (request !== requestRef.current) return;
        setSearch(result.ok ? { state: "done", results: result.value } : { state: "failed", error: result.error });
      });
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [api, query]);

  useShortcuts({ cancel: onCancel });

  async function add(result: SearchResult) {
    if (adding) return;
    setAdding(result.symbol);
    setAddError(null);
    try {
      const added = await api.add(result.symbol);
      if (added.ok) {
        onAdded(added.value.id);
        return;
      }
      setAddError(
        added.error === "network"
          ? "Adding an asset needs a connection."
          : added.error === "rate_limited"
            ? RATE_LIMITED
            : `Could not add ${result.name}. Try again.`,
      );
    } finally {
      setAdding(null);
    }
  }

  const shown: Search = query.trim().length < MIN_QUERY ? { state: "idle" } : search;
  const offline = shown.state === "failed" && shown.error === "network";

  return (
    <View style={[formStyles.screen, { backgroundColor: theme.paper }]}>
      <View style={[styles.header, { borderBottomColor: theme.line }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cancel"
          onPress={onCancel}
          hitSlop={8}
          style={(state) => [styles.headerButton, (isHovered(state) || state.pressed) && { backgroundColor: theme.hover }]}
        >
          <Text allowFontScaling style={[styles.headerText, { color: theme.ink }]}>
            ‹ Cancel
          </Text>
        </Pressable>
        <Text allowFontScaling accessibilityRole="header" numberOfLines={1} style={[styles.title, { color: theme.ink }]}>
          Add asset
        </Text>
        <View style={styles.headerSpacer} />
      </View>

      <FormField label="Name or ticker" theme={theme}>
        <TextInput
          accessibilityLabel="Name or ticker"
          allowFontScaling
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          keyboardAppearance={keyboardAppearance(theme)}
          placeholder="Apple, VWCE, BTC"
          placeholderTextColor={theme.accent}
          value={query}
          onChangeText={setQuery}
          style={[formStyles.input, { color: theme.ink }]}
        />
      </FormField>

      {addError ? (
        <Text allowFontScaling accessibilityRole="alert" style={[formStyles.error, { color: theme.listRed }]}>
          {addError}
        </Text>
      ) : null}

      {offline ? (
        <View style={styles.empty}>
          <Text allowFontScaling style={[styles.emptyTitle, { color: theme.ink }]}>
            Search needs a connection
          </Text>
          <Text allowFontScaling style={[styles.emptyText, { color: theme.accent }]}>
            You are offline. Trades for assets that you already hold work offline.
          </Text>
        </View>
      ) : (
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 24 + bottomInset }}>
          <Results search={shown} adding={adding} theme={theme} onPick={(result) => void add(result)} />
        </ScrollView>
      )}
    </View>
  );
}

function Results({
  search,
  adding,
  theme,
  onPick,
}: {
  search: Search;
  adding: string | null;
  theme: ThemeColors;
  onPick: (result: SearchResult) => void;
}) {
  if (search.state === "idle") return null;
  if (search.state === "loading") {
    return <ActivityIndicator style={styles.loading} color={theme.accent} accessibilityLabel="Searching" />;
  }
  if (search.state === "failed") {
    return (
      <Text allowFontScaling accessibilityRole="alert" style={[styles.message, { color: theme.listRed }]}>
        {search.error === "rate_limited" ? RATE_LIMITED : "Search is not available now."}
      </Text>
    );
  }
  return (
    <>
      <Text allowFontScaling accessibilityRole="header" style={[styles.section, { color: theme.accent }]}>
        Results from Yahoo Finance
      </Text>
      {search.results.length === 0 ? (
        <Text allowFontScaling style={[styles.message, { color: theme.accent }]}>
          No results. Try the ticker, for example AAPL.
        </Text>
      ) : (
        search.results.map((result) => {
          const line = resultLine(result);
          return (
            <Pressable
              key={result.symbol}
              accessibilityRole="button"
              accessibilityLabel={`${result.name}, ${line}`}
              disabled={adding !== null}
              onPress={() => onPick(result)}
              style={(state) => [
                styles.row,
                {
                  backgroundColor: state.pressed ? theme.line : isHovered(state) ? theme.hover : theme.row,
                  borderBottomColor: theme.line,
                },
              ]}
            >
              <View style={styles.rowMain}>
                <Text allowFontScaling style={[styles.rowTitle, { color: theme.ink }]}>
                  {result.name}
                </Text>
                <Text allowFontScaling style={[styles.rowSub, { color: theme.accent }]}>
                  {line}
                </Text>
              </View>
              {adding === result.symbol ? <ActivityIndicator color={theme.accent} /> : null}
            </Pressable>
          );
        })
      )}
      <Text allowFontScaling style={[styles.message, { color: theme.accent }]}>
        Pick a result to add it and enter your first trade.
      </Text>
    </>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 58,
    paddingHorizontal: 14,
    borderBottomWidth: 1,
  },
  headerButton: {
    minHeight: 44,
    minWidth: 96,
    paddingHorizontal: 8,
    borderRadius: 22,
    justifyContent: "center",
  },
  headerText: {
    fontSize: 18,
  },
  title: {
    flex: 1,
    fontSize: 20,
    textAlign: "center",
  },
  headerSpacer: {
    minWidth: 96,
  },
  section: {
    fontSize: 13,
    fontWeight: "600",
    letterSpacing: 1,
    textTransform: "uppercase",
    paddingHorizontal: 14,
    paddingTop: 16,
    paddingBottom: 6,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 50,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderBottomWidth: 1,
    gap: 12,
  },
  rowMain: {
    flex: 1,
  },
  rowTitle: {
    fontSize: 17,
  },
  rowSub: {
    fontSize: 12,
    marginTop: 2,
  },
  message: {
    fontSize: 13,
    lineHeight: 18,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  loading: {
    marginTop: 24,
  },
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
    gap: 12,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: "600",
  },
  emptyText: {
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
  },
});
