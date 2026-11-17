-- +goose Up
ALTER TABLE insights ADD COLUMN source text NOT NULL DEFAULT 'spending'
    CHECK (source IN ('spending', 'portfolio'));

DROP INDEX insights_user_status_idx;
CREATE INDEX insights_user_source_status_idx ON insights (user_id, source, status);

ALTER TABLE insight_memory ADD COLUMN source text NOT NULL DEFAULT 'spending'
    CHECK (source IN ('spending', 'portfolio'));
ALTER TABLE insight_memory DROP CONSTRAINT insight_memory_pkey;
ALTER TABLE insight_memory ADD PRIMARY KEY (user_id, source);

-- +goose Down
WITH d AS (DELETE FROM insights WHERE source = 'portfolio' RETURNING id, user_id)
INSERT INTO deleted_records (table_name, id, user_id)
SELECT 'insights', id, user_id FROM d
ON CONFLICT (table_name, id) DO NOTHING;
DELETE FROM insight_memory WHERE source = 'portfolio';

ALTER TABLE insight_memory DROP CONSTRAINT insight_memory_pkey;
ALTER TABLE insight_memory ADD PRIMARY KEY (user_id);
ALTER TABLE insight_memory DROP COLUMN source;

DROP INDEX insights_user_source_status_idx;
CREATE INDEX insights_user_status_idx ON insights (user_id, status);
ALTER TABLE insights DROP COLUMN source;
