-- +goose Up
ALTER TABLE recurring_rules ADD COLUMN generated_through date;
ALTER TABLE recurring_rules ADD CONSTRAINT recurring_rules_end_date_check
    CHECK (end_date IS NULL OR end_date >= start_date);

-- +goose Down
ALTER TABLE recurring_rules DROP CONSTRAINT recurring_rules_end_date_check;
ALTER TABLE recurring_rules DROP COLUMN generated_through;
