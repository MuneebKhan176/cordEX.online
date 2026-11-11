# CORDEX MySQL schema

- `schema.sql` contains the NodeJS_Exchange application tables.
- `initDB.js` creates the configured database if missing and applies the schema.
- `ai_permissions.sql` contains only the four AI views and restricted reader grants.
- `initAIPermissions.js` applies that separate permissions file using the root credentials and injects `AI_DB_PASSWORD`.

Both initialization scripts are safe to rerun for the current schema: the table definitions use `CREATE TABLE IF NOT EXISTS`, the AI views use `CREATE OR REPLACE VIEW`, and the AI account is created/updated explicitly. The schema does not drop databases or tables.

The schema initializer creates missing tables; it is not a migration engine. If an existing table has an older definition, `CREATE TABLE IF NOT EXISTS` does not add or alter columns, indexes, or constraints. Apply a reviewed migration for those changes.

The AI reader receives SELECT only on:
- `ai_futures_positions`
- `ai_futures_trades`
- `ai_futures_funding`
- `ai_spot_trades`

It receives no direct privileges on base tables. In Docker the account host is `%` so the separate analytics container can connect over the private Compose network. The MySQL port is not published to the VPS host.
