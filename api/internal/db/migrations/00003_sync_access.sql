-- +goose Up
-- +goose StatementBegin
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'powersync_repl') THEN
        RAISE EXCEPTION 'role powersync_repl does not exist: create it (LOGIN, REPLICATION) before you run the migrations';
    END IF;
END
$$;
-- +goose StatementEnd

CREATE PUBLICATION powersync FOR TABLE
    accounts, categories, transactions, recurring_rules, budgets, user_settings;

GRANT SELECT ON accounts, categories, transactions, recurring_rules, budgets, user_settings TO powersync_repl;

-- +goose Down
REVOKE SELECT ON accounts, categories, transactions, recurring_rules, budgets, user_settings FROM powersync_repl;
DROP PUBLICATION powersync;
