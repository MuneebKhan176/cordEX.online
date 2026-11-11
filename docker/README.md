# CORDEX database containers

CORDEX runs MySQL 8.4 and MongoDB 8.0 as separate Docker Compose
services. Both databases use named Docker volumes and are reachable
only from services on the Compose network; neither database port is
published on the VPS host.

## Configure environment

Copy the example values into your existing root `.env` file, then
merge them with your current application secrets and settings. Do not
replace your existing `.env` wholesale and do not commit it.

```bash
# Linux VPS
cp .env.docker.example .env
```

If you already have a production `.env`, add/update only the database
variables shown in `.env.docker.example`.

Use strong, unique passwords. Keep the MongoDB URI password URL-encoded
if it contains URI-reserved characters. Set `AI_DB_NAME` to the same
database as `DB_NAME`; the AI account is provisioned with SELECT-only
permissions.

## Start

```bash
docker compose config
docker compose up -d --build
docker compose ps
```

Inspect logs:

```bash
docker compose logs -f mysql mongodb node-backend ai-analytics
```

## Existing database migration

Starting these containers creates empty databases; it does not copy
data from an external provider.

Before switching production traffic, take provider-side backups and
restore them into the new containers. Typical tools are `mysqldump`
and `mysql` for MySQL, and `mongodump` / `mongorestore` for MongoDB.
Verify row/document counts and application reads before changing DNS
or stopping the old database services.

Keep independent backups off the VPS. A Docker volume is persistence,
not a backup.

## Data safety

- `docker compose stop` and `docker compose down` preserve named volumes.
- `docker compose down -v` deletes the named database volumes.
- Initialization scripts run only on an empty data directory. They do
  not rotate credentials or re-run after the first initialization.
