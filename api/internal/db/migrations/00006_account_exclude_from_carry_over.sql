-- +goose Up
ALTER TABLE accounts ADD COLUMN exclude_from_carry_over boolean NOT NULL DEFAULT false;

-- +goose Down
ALTER TABLE accounts DROP COLUMN exclude_from_carry_over;
