# CORDEX MongoDB Container

- Image: MongoDB 8.0
- Compose service: `mongodb`
- Internal address: `mongodb:27017`
- Persistent volume: `cordex_mongodb_data`

MongoDB is not published on a VPS host port. The Node backend connects
to it over the private Compose network using `MONGO_URI`.

On first initialization, the container creates a dedicated application
user with read/write access only to `MONGO_DB_NAME`. The root account
is reserved for administration.

Start:

```bash
docker compose up -d mongodb
```

Logs:

```bash
docker compose logs -f mongodb
```

Initialization scripts run only when the data directory is empty.
Changing credentials later does not automatically alter existing users.
Persistent data remains in the named volume when containers stop or are
recreated. Do not use `docker compose down -v` unless you intend to
delete the database volume.
