-- +goose Up
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE users (
    id              uuid PRIMARY KEY,
    email           citext NOT NULL UNIQUE,
    password_hash   text NOT NULL,
    totp_secret_enc bytea,
    totp_enabled    boolean NOT NULL DEFAULT false,
    totp_last_step  bigint,
    role            text NOT NULL CHECK (role IN ('admin', 'user')),
    failed_logins   integer NOT NULL DEFAULT 0,
    locked_until    timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE invites (
    token_hash    bytea PRIMARY KEY,
    email         citext NOT NULL,
    currency_code text NOT NULL,
    role          text NOT NULL CHECK (role IN ('admin', 'user')),
    expires_at    timestamptz NOT NULL,
    used_at       timestamptz
);

CREATE TABLE recovery_codes (
    user_id   uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    code_hash bytea NOT NULL,
    used_at   timestamptz,
    PRIMARY KEY (user_id, code_hash)
);

CREATE TABLE refresh_tokens (
    id           uuid PRIMARY KEY,
    user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    family_id    uuid NOT NULL,
    token_hash   bytea NOT NULL UNIQUE,
    device_name  text NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,
    revoked_at   timestamptz,
    replaced_by  uuid
);

CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);

CREATE TABLE deleted_records (
    table_name text NOT NULL,
    id         uuid NOT NULL,
    user_id    uuid NOT NULL,
    deleted_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (table_name, id)
);

-- +goose Down
DROP TABLE deleted_records;
DROP TABLE refresh_tokens;
DROP TABLE recovery_codes;
DROP TABLE invites;
DROP TABLE users;
