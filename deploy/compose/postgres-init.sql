-- Local development only. The passwords are dev values.
-- The migrations need powersync_repl to exist before they run.
CREATE ROLE powersync_repl WITH LOGIN REPLICATION PASSWORD 'powersync-repl-dev';

CREATE ROLE powersync_storage WITH LOGIN PASSWORD 'powersync-storage-dev';
CREATE DATABASE powersync_storage OWNER powersync_storage;
