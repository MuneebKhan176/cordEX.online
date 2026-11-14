# CORDEX MySQL Container

- Image: MySQL 8.4
- Compose service: `mysql`
- Internal address: `mysql:3306`
- Persistent volume: `cordex_mysql_data`

MySQL is reachable only from services on the private Compose network; its port is not published on the VPS host.

## Initialization order

Docker Compose runs the one-shot initialization jobs in this order:

1. `mysql-app-user-init` runs `docker/mysql/create-db-user.js`. It connects as the MySQL root account, creates or updates `DB_USERNAME`@'%', and grants that account privileges only on `DB_NAME`.
2. `mysql-schema-init` runs `Databases/MySQL/initDB.js` and applies `Databases/MySQL/schema.sql`.
3. `mysql-ai-permissions` applies the separate read-only AI views and grants.
4. `node-backend` starts after the initialization jobs complete successfully.

The app-user script is safe to rerun. It synchronizes the password from `DB_PASSWORD` and ensures the application account can connect from other containers on the Compose network.

## Environment variables

Required application credentials: `DB_NAME`, `DB_USERNAME`, and `DB_PASSWORD`.

The root account is used only by initialization jobs. Set `MYSQL_ROOT_PASSWORD` to the root password. For compatibility with existing deployments, Compose falls back to `DB_PASSWORD` when `MYSQL_ROOT_PASSWORD` is not set. On an already initialized MySQL volume, the configured root password must match the existing root account password; changing the environment variable does not reset the password in the volume.

## Start

```bash
docker compose up -d --build
```

Run only the MySQL initialization chain:

```bash
docker compose up -d --build mysql mysql-app-user-init mysql-schema-init mysql-ai-permissions
```

Logs:

```bash
docker compose logs -f mysql mysql-app-user-init mysql-schema-init mysql-ai-permissions
```

Persistent data remains in the named volume when containers stop or are recreated. Do not use `docker compose down -v` unless you intend to delete the database volume.
