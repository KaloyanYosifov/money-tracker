import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { evaluateExpression, formatAmount, minorUnits } from "../../domain/money";
import { colors, type ThemeColors } from "../theme";

type Props = {
  currency: string;
  locale?: string;
  /** An expression with "." as the decimal separator, for example "14.99". */
  initialExpression?: string;
  /** Called after each key with the amount in minor units (null if it is not valid) and the expression. */
  onChange?: (minor: number | null, expression: string) => void;
  theme?: ThemeColors;
};

type Key = { value: string; text: string; label: string };

const digit = (d: string): Key => ({ value: d, text: d, label: d });

const keys: Key[][] = [
  [digit("7"), digit("8"), digit("9"), { value: "/", text: "÷", label: "divide" }],
  [digit("4"), digit("5"), digit("6"), { value: "*", text: "×", label: "times" }],
  [digit("1"), digit("2"), digit("3"), { value: "-", text: "−", label: "minus" }],
  [
    { value: ".", text: ".", label: "decimal point" },
    digit("0"),
    { value: "back", text: "⌫", label: "delete" },
    { value: "+", text: "+", label: "plus" },
  ],
];

const OPERATORS = "+-*/";

function lastOperand(expression: string): string {
  const match = /[^-+*/]*$/.exec(expression);
  return match ? match[0] : "";
}

/** Applies one key to the expression. Keys that make the expression invalid do nothing. */
function applyKey(expression: string, key: string, fractionDigits: number): string {
  const operand = lastOperand(expression);
  if (key === "back") return expression.slice(0, -1);
  if (OPERATORS.includes(key)) {
    if (expression === "") return expression;
    const base = OPERATORS.includes(expression.slice(-1)) || expression.endsWith(".") ? expression.slice(0, -1) : expression;
    return base + key;
  }
  if (key === ".") {
    if (fractionDigits === 0 || operand.includes(".")) return expression;
    return expression + (operand === "" ? "0." : ".");
  }
  const dot = operand.indexOf(".");
  if (dot >= 0 && operand.length - dot - 1 >= fractionDigits) return expression;
  return expression + key;
}

function evaluate(expression: string, currency: string): number | null {
  return evaluateExpression(expression.replace(/[-+*/.]$/, ""), currency);
}

const display = (expression: string) => expression.replace(/\*/g, "×").replace(/\//g, "÷");

/** Calculator keypad for amounts. Shows the expression and the evaluated amount. */
export function AmountKeypad({ currency, locale, initialExpression = "", onChange, theme = colors.light }: Props) {
  const [expression, setExpression] = useState(initialExpression);
  const result = evaluate(expression, currency);
  const amountText = expression === "" ? formatAmount(0, currency, locale) : result === null ? "—" : formatAmount(result, currency, locale);

  function press(key: string) {
    const next = applyKey(expression, key, minorUnits(currency));
    if (next === expression) return;
    setExpression(next);
    onChange?.(evaluate(next, currency), next);
  }

  return (
    <View style={{ backgroundColor: theme.row }}>
      <View style={[styles.display, { borderBottomColor: theme.line }]}>
        <Text allowFontScaling style={[styles.expression, { color: theme.accent }]}>
          {display(expression)}
        </Text>
        <Text allowFontScaling accessibilityLiveRegion="polite" style={[styles.amount, { color: theme.ink }]}>
          {amountText}
        </Text>
      </View>
      {keys.map((row, i) => (
        <View key={i} style={styles.row}>
          {row.map((key) => (
            <Pressable
              key={key.value}
              testID={`keypad-${key.label.replace(/ /g, "-")}`}
              accessibilityRole="button"
              accessibilityLabel={key.label}
              onPress={() => press(key.value)}
              style={({ pressed }) => [styles.key, { borderColor: theme.line }, pressed && { backgroundColor: theme.line }]}
            >
              <Text allowFontScaling style={[styles.keyText, { color: theme.ink }]}>
                {key.text}
              </Text>
            </Pressable>
          ))}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  display: {
    alignItems: "flex-end",
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
  },
  expression: {
    fontSize: 16,
    minHeight: 20,
  },
  amount: {
    fontSize: 40,
    fontWeight: "300",
  },
  row: {
    flexDirection: "row",
  },
  key: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 56,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  keyText: {
    fontSize: 24,
  },
});
