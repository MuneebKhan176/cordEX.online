# CORDEX MySQL Container

- Image: MySQL 8.4
- Compose service: `mysql`
- Internal address: `mysql:3306`
- Persistent volume: `cordex_mysql_data`

MySQL is reachable only from services on the private Compose network; its port is not published on the VPS host.

The Compose startup sequence waits for MySQL health, applies `Databases/MySQL/schema.sql`, then applies the separate `Databases/MySQL/ai_permissions.sql`. These are one-shot Node jobs using the MySQL root account. The schema initializer is rerun on each `docker compose up` and creates missing tables without dropping existing data.

Start:

```bash
docker compose up -d mysql mysql-schema-init mysql-ai-permissions
```

Logs:

```bash
docker compose logs -f mysql mysql-schema-init mysql-ai-permissions
```

The official MySQL image's built-in initialization only runs when the data directory is empty. The schema jobs are separate so they also run against an existing named volume. On an existing volume, ensure the root account is permitted to connect from the Compose network; `MYSQL_ROOT_HOST` is applied automatically only on first initialization.

Persistent data remains in the named volume when containers stop or are recreated. Do not use `docker compose down -v` unless you intend to delete the database volume.
