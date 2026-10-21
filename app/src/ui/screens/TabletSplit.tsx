import { useState } from "react";
import { StyleSheet, View } from "react-native";

import type { Period } from "../../domain/period";
import { Chalkboard } from "./Chalkboard";
import { useScreenSettings } from "./manage";
import { TransactionList } from "./TransactionList";

type Props = {
  period: Period;
  onOpen: (id: string) => void;
  onAdd: (type: "expense" | "income") => void;
  onShift: (step: number) => void;
};

/** iPad landscape: the chalkboard and the transaction list side by side. A category on the chalkboard filters the list. */
export function TabletSplit({ period, onOpen, onAdd, onShift }: Props) {
  const { theme } = useScreenSettings();
  const [filter, setFilter] = useState<{ categoryId: string; accountId: string | null } | null>(null);

  return (
    <View style={styles.row}>
      <View style={[styles.pane, { borderRightColor: theme.line }]}>
        <Chalkboard
          period={period}
          showRotateHint={false}
          onCategoryPress={(categoryId, accountId) => setFilter({ categoryId, accountId })}
          onAdd={onAdd}
        />
      </View>
      <View style={styles.pane}>
        <TransactionList
          // A new filter from the chalkboard starts the list with it.
          key={filter ? `${filter.accountId ?? ""}:${filter.categoryId}` : "all"}
          period={period}
          layout="phone"
          initialAccountId={filter?.accountId ?? null}
          initialCategoryId={filter?.categoryId ?? null}
          onOpen={onOpen}
          onShift={onShift}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flex: 1,
    flexDirection: "row",
  },
  pane: {
    flex: 1,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: "transparent",
  },
});
