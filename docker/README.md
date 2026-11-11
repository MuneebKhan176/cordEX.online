# CORDEX database containers

CORDEX runs MySQL 8.4 and MongoDB 8.0 as separate Docker Compose services. Both use named Docker volumes and are reachable only from services on the Compose network; neither database port is published on the VPS host.

## Configure environment

Merge the database variables from `.env.docker.example` into the root `.env`, preserving all existing application secrets and settings. Set `DB_NAME=NodeJS_Exchange` to match the supplied SQL schema. Use strong, unique passwords. Keep the MongoDB URI password URL-encoded if it contains URI-reserved characters.

## Initialization flow

```text
mysql healthy
  -> mysql-schema-init (Databases/MySQL/schema.sql)
  -> mysql-ai-permissions (Databases/MySQL/ai_permissions.sql)

mongodb healthy
  -> mongodb-schema-init (Social_Platform/social_models.js)
```

The Node backend and AI analytics service wait for the relevant schema jobs to complete successfully. These jobs run on every Compose deployment and are designed to be repeatable. MySQL creates missing tables; MongoDB ensures collections and declared indexes exist. Neither initializer drops existing application data.

Important: `CREATE TABLE IF NOT EXISTS` does not migrate an already-existing table to a newer definition. If your existing database has older columns/indexes, prepare a reviewed ALTER migration separately.

## Start

After configuring the root `.env`:

```bash
docker compose config
docker compose up -d --build
docker compose ps
```

Inspect startup:

```bash
docker compose logs -f mysql mysql-schema-init mysql-ai-permissions mongodb mongodb-schema-init node-backend ai-analytics
```

## Existing database migration

Starting these containers creates empty databases; it does not copy data from an external provider. Before switching production traffic, take provider-side backups and restore them into the new containers. Verify row/document counts and application reads before changing DNS or stopping old database services.

Keep independent backups off the VPS. A Docker volume is persistence, not a backup.

## Data safety

- `docker compose stop` and `docker compose down` preserve named volumes.
- `docker compose down -v` deletes the named database volumes.
- Official image initialization scripts run only on an empty data directory. The separate schema jobs are not tied to first-boot volume initialization.
