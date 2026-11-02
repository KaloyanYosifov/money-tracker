-- +goose Up
ALTER TABLE accounts ADD COLUMN exclude_from_net_worth boolean NOT NULL DEFAULT false;

-- The price worker owns these rows. last_attempt_at, history_from, fail_count
-- and fail_reason are worker state and do not sync.
CREATE TABLE instruments (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    symbol          text NOT NULL UNIQUE,
    name            text NOT NULL,
    exchange        text NOT NULL,
    kind            text NOT NULL CHECK (kind IN ('stock', 'etf', 'crypto', 'fx')),
    quote_currency  text NOT NULL,
    last_fetched_at timestamptz,
    last_attempt_at timestamptz,
    history_from    date,
    fail_count      int NOT NULL DEFAULT 0,
    failed_at       timestamptz,
    fail_reason     text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE instrument_prices (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    instrument_id uuid NOT NULL REFERENCES instruments ON DELETE CASCADE,
    date          date NOT NULL,
    close         text NOT NULL,
    as_of         timestamptz NOT NULL,
    UNIQUE (instrument_id, date)
);

-- The instruments and FX pairs of each user. The sync rules read it to give
-- each user one bucket for each of them.
CREATE TABLE user_instruments (
    user_id       uuid NOT NULL,
    instrument_id uuid NOT NULL REFERENCES instruments,
    PRIMARY KEY (user_id, instrument_id)
);

CREATE TABLE trades (
    id            uuid PRIMARY KEY,
    user_id       uuid NOT NULL,
    instrument_id uuid NOT NULL,
    side          text NOT NULL CHECK (side IN ('buy', 'sell')),
    date          date NOT NULL,
    quantity      text NOT NULL,
    price         text NOT NULL,
    fee           text NOT NULL,
    note          text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, id),
    FOREIGN KEY (user_id, instrument_id) REFERENCES user_instruments (user_id, instrument_id)
);

CREATE INDEX trades_instrument_date_idx ON trades (instrument_id, date);

ALTER PUBLICATION powersync ADD TABLE instruments, instrument_prices, user_instruments, trades;

GRANT SELECT ON instruments, instrument_prices, user_instruments, trades TO powersync_repl;

-- +goose Down
DROP TABLE trades;
DROP TABLE user_instruments;
DROP TABLE instrument_prices;
DROP TABLE instruments;
ALTER TABLE accounts DROP COLUMN exclude_from_net_worth;
