# CORDEX database containers

CORDEX runs MySQL 8.4 and MongoDB 8.0 as separate Docker Compose
services. Both databases use named Docker volumes and are reachable
only from services on the Compose network; neither database port is
published on the VPS host.

## Configure environment

The `.env.docker.example` file contains the additional database
settings required by this Compose setup.

- If you do not have a root `.env` yet, copy the example and then add
  all of your existing application secrets and required settings.
- If you already have a production `.env`, do **not** overwrite it.
  Merge the database variables from `.env.docker.example` into it,
  preserving your current application secrets.

Set `DB_NAME` to the exact MySQL database name you intend to restore.
The Compose file uses that same database for the AI analytics service
and provisions its separate account with SELECT-only permissions.
Use strong, unique passwords. Keep the MongoDB URI password
URL-encoded if it contains URI-reserved characters.

## Start

After configuring the root `.env`:

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
