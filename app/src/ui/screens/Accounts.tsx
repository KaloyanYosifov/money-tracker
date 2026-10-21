import { usePowerSync, useQuery } from "@powersync/react";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import { archiveAccount, deleteAccount, restoreAccount, saveAccount } from "../../data/mutations";
import { deleteSyncProblem, problemRecord, useSyncProblem } from "../../data/syncProblems";
import { validateAccount } from "../../domain/validation";
import type { Account } from "../../generated/schema";
import { isHovered } from "../components/interaction";
import { PaperBar } from "../components/PaperBar";
import { Texture } from "../Texture";
import { paperTint, type ThemeColors } from "../theme";
import {
  ColorPalette,
  defaultPlatform,
  FormAction,
  FormField,
  FormHeader,
  formStyles,
  PALETTE,
  PersonIcon,
  ReorderList,
  useScreenSettings,
  type ScreenPlatform,
} from "./manage";

export const ACCOUNTS_HINT =
  "You can use accounts to split expenses, for example per bank card, or keep a separate 'Savings' account.";

type ScreenProps = {
  platform?: ScreenPlatform;
  onOpen: (id: string) => void;
  onNew: () => void;
  /** Opens the transaction form with the type transfer. */
  onTransfer: () => void;
};

/** The Accounts page: the Transfer button, the accounts and the footer hint. */
export function AccountsScreen({ platform, onOpen, onNew, onTransfer }: ScreenProps) {
  const db = usePowerSync();
  const { theme } = useScreenSettings();
  const { data } = useQuery<Account>("SELECT * FROM accounts ORDER BY sort_order, name");

  const active = data.filter((a) => !a.archived_at);
  const archived = data.filter((a) => a.archived_at);

  async function reorder(ids: string[]) {
    for (const [index, id] of ids.entries()) {
      const account = active.find((a) => a.id === id);
      if (!account || account.sort_order === index) continue;
      await saveAccount(db, { ...account, sort_order: index });
    }
  }

  return (
    <View style={[styles.screen, { backgroundColor: theme.row }]}>
      <PaperBar theme={theme} style={styles.bar}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Transfer"
          onPress={onTransfer}
          style={(state) => [styles.transfer, { backgroundColor: theme.transferButton, opacity: state.pressed ? 0.8 : isHovered(state) ? 0.92 : 1 }]}
        >
          <Text allowFontScaling style={styles.transferText}>
            Transfer
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="New account"
          onPress={onNew}
          hitSlop={8}
          style={(state) => [styles.add, (isHovered(state) || state.pressed) && { backgroundColor: theme.hover }]}
        >
          <Text allowFontScaling style={[styles.addText, { color: theme.ink }]}>
            +
          </Text>
        </Pressable>
      </PaperBar>
      <View style={styles.fill}>
        <ReorderList
          items={active}
          archived={archived}
          platform={platform ?? defaultPlatform()}
          theme={theme}
          icon={(a) => <PersonIcon color={a.color} testID={`account-icon-${a.id}`} />}
          onOpen={onOpen}
          onReorder={(ids) => void reorder(ids)}
          onRestore={(id) => void restoreAccount(db, id)}
        />
      </View>
      <Texture kind="paper" tint={paperTint(theme)} style={[styles.footer, { borderTopColor: theme.line }]}>
        <Text allowFontScaling style={[styles.footerText, { color: theme.accent }]}>
          {ACCOUNTS_HINT}
        </Text>
      </Texture>
    </View>
  );
}

type FormProps = {
  /** null opens an empty form. */
  id: string | null;
  platform?: ScreenPlatform;
  /** A sync problem of this record: the form shows the rejected data, and a save removes the problem. */
  problemId?: string;
  onClose: () => void;
};

/** The form for a new or an existing account. */
export function AccountForm({ id, platform, problemId, onClose }: FormProps) {
  const { theme } = useScreenSettings();
  const account = useQuery<Account>("SELECT * FROM accounts WHERE id = ?", [id ?? ""]);
  const usage = useQuery<{ used: number }>(
    `SELECT (EXISTS (SELECT 1 FROM transactions WHERE ? IN (account_id, to_account_id))
          OR EXISTS (SELECT 1 FROM recurring_rules WHERE ? IN (account_id, to_account_id))) AS used`,
    [id ?? "", id ?? ""],
  );
  const { problem, isLoading: problemLoading } = useSyncProblem(problemId);
  const existing = id ? problemRecord(problem, account.data[0]) : undefined;
  if (account.isLoading || usage.isLoading || problemLoading || (id && !existing)) return null;

  return (
    <AccountFormBody
      key={existing?.id ?? "new"}
      existing={existing}
      used={Boolean(usage.data[0]?.used)}
      platform={platform ?? defaultPlatform()}
      theme={theme}
      problemId={problemId}
      onClose={onClose}
    />
  );
}

function AccountFormBody({
  existing,
  used,
  platform,
  theme,
  problemId,
  onClose,
}: {
  existing: Account | undefined;
  used: boolean;
  platform: ScreenPlatform;
  theme: ThemeColors;
  problemId?: string;
  onClose: () => void;
}) {
  const db = usePowerSync();
  const [name, setName] = useState(existing?.name ?? "");
  const [color, setColor] = useState(existing?.color ?? PALETTE[0].hex);
  const [nameTouched, setNameTouched] = useState(false);
  const [busy, setBusy] = useState(false);

  const input = { id: existing?.id, name, color, sort_order: existing?.sort_order };
  const errors = validateAccount(input);
  const nameError = errors.find((e) => e.field === "name");

  async function run(action: () => Promise<boolean>) {
    if (busy) return;
    setBusy(true);
    try {
      if (await action()) onClose();
    } finally {
      setBusy(false);
    }
  }

  const save = () =>
    run(async () => {
      const { ok } = await saveAccount(db, input);
      if (ok && problemId) await deleteSyncProblem(db, problemId);
      return ok;
    });

  return (
    <View style={[formStyles.screen, { backgroundColor: theme.paper }]}>
      <FormHeader
        title={existing ? "Edit Account" : "New Account"}
        platform={platform}
        canSave={errors.length === 0 && !busy}
        onCancel={onClose}
        onSave={() => void save()}
        theme={theme}
      />
      <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={formStyles.content}>
        <FormField
          label="Name"
          error={nameTouched && nameError ? (nameError.code === "too_long" ? "Too long" : "Required") : undefined}
          theme={theme}
        >
          <TextInput
            allowFontScaling
            placeholder="Name"
            placeholderTextColor={theme.accent}
            value={name}
            onChangeText={(text) => {
              setName(text);
              setNameTouched(true);
            }}
            style={[formStyles.input, { color: theme.ink }]}
          />
        </FormField>
        <FormField label="Colour" theme={theme}>
          <ColorPalette value={color} onChange={setColor} theme={theme} />
        </FormField>
        {existing && existing.archived_at ? (
          <FormAction
            label="Restore"
            color={theme.accent}
            onPress={() =>
              void run(async () => {
                await restoreAccount(db, existing.id);
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
                await archiveAccount(db, existing.id);
                return true;
              })
            }
          />
        ) : null}
        {existing && !used ? (
          <FormAction
            label="Delete"
            color={theme.listRed}
            onPress={() => void run(async () => (await deleteAccount(db, existing.id)).ok)}
          />
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  fill: {
    flex: 1,
  },
  bar: {
    flexDirection: "row",
    padding: 14,
  },
  transfer: {
    paddingVertical: 8,
    paddingHorizontal: 26,
    borderRadius: 4,
    shadowColor: "#000",
    shadowOpacity: 0.2,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 },
    minHeight: 44,
    justifyContent: "center",
  },
  transferText: {
    color: "#ffffff",
    fontSize: 18,
    fontWeight: "600",
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
  footer: {
    paddingTop: 12,
    paddingBottom: 18,
    paddingHorizontal: 20,
    borderTopWidth: 1,
  },
  footerText: {
    fontSize: 13,
    textAlign: "center",
    lineHeight: 18,
  },
});
