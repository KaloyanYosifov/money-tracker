-- +goose Up
CREATE TABLE accounts (
    id          uuid PRIMARY KEY,
    user_id     uuid NOT NULL,
    name        text NOT NULL,
    color       text NOT NULL,
    sort_order  integer NOT NULL,
    archived_at timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, id)
);

CREATE TABLE categories (
    id          uuid PRIMARY KEY,
    user_id     uuid NOT NULL,
    type        text NOT NULL,
    name        text NOT NULL,
    icon        text NOT NULL,
    color       text NOT NULL,
    sort_order  integer NOT NULL,
    archived_at timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, id)
);

CREATE TABLE recurring_rules (
    id            uuid PRIMARY KEY,
    user_id       uuid NOT NULL,
    type          text NOT NULL,
    amount_minor  bigint NOT NULL CHECK (amount_minor > 0),
    name          text NOT NULL,
    category_id   uuid,
    account_id    uuid NOT NULL,
    to_account_id uuid,
    note          text,
    frequency     text NOT NULL,
    start_date    date NOT NULL,
    end_date      date,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, id),
    FOREIGN KEY (user_id, account_id) REFERENCES accounts (user_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (user_id, to_account_id) REFERENCES accounts (user_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (user_id, category_id) REFERENCES categories (user_id, id) ON DELETE RESTRICT,
    CHECK (
        (type = 'transfer' AND category_id IS NULL AND to_account_id IS NOT NULL AND to_account_id <> account_id)
        OR (type IN ('expense', 'income') AND category_id IS NOT NULL AND to_account_id IS NULL)
    )
);

CREATE TABLE transactions (
    id                uuid PRIMARY KEY,
    user_id           uuid NOT NULL,
    type              text NOT NULL,
    amount_minor      bigint NOT NULL CHECK (amount_minor > 0),
    currency_code     text NOT NULL,
    date              date NOT NULL,
    name              text NOT NULL,
    category_id       uuid,
    account_id        uuid NOT NULL,
    to_account_id     uuid,
    note              text,
    recurring_rule_id uuid,
    source            text NOT NULL,
    import_batch_id   uuid,
    external_id       text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, id),
    FOREIGN KEY (user_id, account_id) REFERENCES accounts (user_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (user_id, to_account_id) REFERENCES accounts (user_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (user_id, category_id) REFERENCES categories (user_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (user_id, recurring_rule_id) REFERENCES recurring_rules (user_id, id)
        ON DELETE SET NULL (recurring_rule_id),
    CHECK (
        (type = 'transfer' AND category_id IS NULL AND to_account_id IS NOT NULL AND to_account_id <> account_id)
        OR (type IN ('expense', 'income') AND category_id IS NOT NULL AND to_account_id IS NULL)
    )
);

CREATE INDEX transactions_user_date_idx ON transactions (user_id, date);
CREATE INDEX transactions_user_category_idx ON transactions (user_id, category_id);
CREATE INDEX transactions_user_account_idx ON transactions (user_id, account_id);

CREATE TABLE budgets (
    id           uuid PRIMARY KEY,
    user_id      uuid NOT NULL,
    category_id  uuid,
    period       text NOT NULL,
    amount_minor bigint NOT NULL CHECK (amount_minor > 0),
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, id),
    FOREIGN KEY (user_id, category_id) REFERENCES categories (user_id, id) ON DELETE RESTRICT
);

CREATE TABLE user_settings (
    id               uuid PRIMARY KEY,
    user_id          uuid NOT NULL,
    currency_code    text NOT NULL,
    time_period      text NOT NULL,
    week_start_day   integer NOT NULL,
    month_start_day  integer NOT NULL,
    year_start_month integer NOT NULL,
    budget_mode      boolean NOT NULL,
    carry_over       boolean NOT NULL,
    hide_future      boolean NOT NULL,
    show_note        boolean NOT NULL,
    theme            text NOT NULL,
    summary_font     text NOT NULL,
    icon_style       text NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, id),
    UNIQUE (user_id)
);

-- +goose Down
DROP TABLE user_settings;
DROP TABLE budgets;
DROP TABLE transactions;
DROP TABLE recurring_rules;
DROP TABLE categories;
DROP TABLE accounts;
