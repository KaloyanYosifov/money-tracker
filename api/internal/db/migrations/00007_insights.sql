-- +goose Up
ALTER TABLE user_settings ADD COLUMN insights_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE insights (
    id          uuid PRIMARY KEY,
    user_id     uuid NOT NULL,
    kind        text NOT NULL CHECK (kind IN ('tip', 'budget', 'recurring_rule')),
    title       text NOT NULL,
    body        text NOT NULL,
    fingerprint text NOT NULL,
    status      text NOT NULL CHECK (status IN ('open', 'accepted', 'dismissed')),
    action      jsonb,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, id)
);

CREATE INDEX insights_user_status_idx ON insights (user_id, status);

-- attempts and next_attempt_at are server-only retry state for the question
-- worker. They are not in insight_question.schema.json, so they do not upload.
CREATE TABLE insight_questions (
    id              uuid PRIMARY KEY,
    user_id         uuid NOT NULL,
    category_id     uuid NOT NULL,
    question        text NOT NULL,
    answer          text,
    action          jsonb,
    status          text NOT NULL CHECK (status IN ('pending', 'answered', 'failed')),
    error           text,
    answered_at     timestamptz,
    attempts        int NOT NULL DEFAULT 0,
    next_attempt_at timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, id),
    FOREIGN KEY (user_id, category_id) REFERENCES categories (user_id, id) ON DELETE CASCADE
);

CREATE INDEX insight_questions_status_idx ON insight_questions (status);

CREATE TABLE insight_memory (
    user_id    uuid PRIMARY KEY,
    summary    text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER PUBLICATION powersync ADD TABLE insights, insight_questions;

GRANT SELECT ON insights, insight_questions TO powersync_repl;

-- +goose Down
DROP TABLE insight_memory;
DROP TABLE insight_questions;
DROP TABLE insights;
ALTER TABLE user_settings DROP COLUMN insights_enabled;
