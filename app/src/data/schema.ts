import { column, Schema, Table } from "@powersync/common";

// Mirrors schema/*.schema.json. PowerSync adds the id column itself.
// Booleans are stored as integer 0 or 1.

const accounts = new Table({
  user_id: column.text,
  name: column.text,
  color: column.text,
  sort_order: column.integer,
  opening_balance_minor: column.integer,
  archived_at: column.text,
});

const categories = new Table({
  user_id: column.text,
  type: column.text,
  name: column.text,
  icon: column.text,
  color: column.text,
  sort_order: column.integer,
  archived_at: column.text,
});

const transactions = new Table(
  {
    user_id: column.text,
    type: column.text,
    amount_minor: column.integer,
    currency_code: column.text,
    date: column.text,
    name: column.text,
    category_id: column.text,
    account_id: column.text,
    to_account_id: column.text,
    note: column.text,
    recurring_rule_id: column.text,
    source: column.text,
    import_batch_id: column.text,
    external_id: column.text,
    created_at: column.text,
    updated_at: column.text,
  },
  {
    indexes: {
      by_date: ["date"],
      by_category: ["category_id"],
      by_account: ["account_id"],
    },
  },
);

const recurring_rules = new Table({
  user_id: column.text,
  type: column.text,
  amount_minor: column.integer,
  name: column.text,
  category_id: column.text,
  account_id: column.text,
  to_account_id: column.text,
  note: column.text,
  frequency: column.text,
  start_date: column.text,
  end_date: column.text,
  generated_through: column.text,
});

const budgets = new Table({
  user_id: column.text,
  category_id: column.text,
  period: column.text,
  amount_minor: column.integer,
});

const user_settings = new Table({
  user_id: column.text,
  currency_code: column.text,
  time_period: column.text,
  week_start_day: column.integer,
  month_start_day: column.integer,
  year_start_month: column.integer,
  budget_mode: column.integer,
  carry_over: column.integer,
  hide_future: column.integer,
  show_note: column.integer,
  theme: column.text,
  summary_font: column.text,
  icon_style: column.text,
});

const device_prefs = new Table(
  {
    key: column.text,
    value: column.text,
  },
  { localOnly: true },
);

const sync_problems = new Table(
  {
    table_name: column.text,
    record_id: column.text,
    op: column.text,
    data_json: column.text,
    code: column.text,
    message: column.text,
    created_at: column.text,
  },
  { localOnly: true },
);

export const AppSchema = new Schema({
  accounts,
  categories,
  transactions,
  recurring_rules,
  budgets,
  user_settings,
  device_prefs,
  sync_problems,
});
