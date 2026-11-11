# CORDEX MySQL Container

- Image: MySQL 8.4
- Compose service: `mysql`
- Internal address: `mysql:3306`
- Persistent volume: `cordex_mysql_data`

The database is not published on a VPS host port. The Node backend and
AI analytics service connect over the private Compose network.

The MySQL image creates the application database and application user
from `DB_NAME`, `DB_USERNAME`, and `DB_PASSWORD`. The initialization
script also creates the separate AI analytics account with SELECT-only
permissions using `AI_DB_USER` and `AI_DB_PASSWORD`.

Start:

```bash
docker compose up -d mysql
```

Logs:

```bash
docker compose logs -f mysql
```

Initialization scripts run only when the data directory is empty.
Changing credentials later does not automatically alter existing MySQL
users. Persistent data remains in the named volume when containers stop
or are recreated. Do not use `docker compose down -v` unless you intend
to delete the database volume.
