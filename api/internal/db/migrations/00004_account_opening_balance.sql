-- +goose Up
ALTER TABLE accounts ADD COLUMN opening_balance_minor bigint NOT NULL DEFAULT 0
    CHECK (opening_balance_minor BETWEEN -1000000000000 AND 1000000000000);

-- +goose Down
ALTER TABLE accounts DROP COLUMN opening_balance_minor;
