-- +goose Up
-- The foreign keys make an upload for an asset that the user did not add
-- fail with invalid_reference.
CREATE TABLE swaps (
    id                 uuid PRIMARY KEY,
    user_id            uuid NOT NULL,
    from_instrument_id uuid NOT NULL,
    to_instrument_id   uuid NOT NULL,
    date               date NOT NULL,
    from_quantity      text NOT NULL,
    to_quantity        text NOT NULL,
    fee                text NOT NULL,
    value              text NOT NULL,
    to_value           text NOT NULL,
    note               text,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, id),
    CHECK (from_instrument_id <> to_instrument_id),
    FOREIGN KEY (user_id, from_instrument_id) REFERENCES user_instruments (user_id, instrument_id),
    FOREIGN KEY (user_id, to_instrument_id) REFERENCES user_instruments (user_id, instrument_id)
);

CREATE INDEX swaps_from_instrument_date_idx ON swaps (from_instrument_id, date);
CREATE INDEX swaps_to_instrument_date_idx ON swaps (to_instrument_id, date);

ALTER PUBLICATION powersync ADD TABLE swaps;

GRANT SELECT ON swaps TO powersync_repl;

-- +goose Down
DROP TABLE swaps;
