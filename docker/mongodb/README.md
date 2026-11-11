# CORDEX MongoDB Container

- Image: MongoDB 8.0
- Compose service: `mongodb`
- Internal address: `mongodb:27017`
- Persistent volume: `cordex_mongodb_data`

MongoDB is not published on a VPS host port. The Node backend and the schema initializer connect over the private Compose network using `MONGO_URI`.

On first initialization, the container creates a dedicated application user with read/write access only to `MONGO_DB_NAME`. The root account is reserved for administration.

The `mongodb-schema-init` Compose job imports the Mongoose models from `Social_Platform/social_models.js` and runs `Model.init()` to create missing collections and ensure declared indexes. It does not drop collections or documents and it runs on subsequent Compose deployments as well.

Start:

```bash
docker compose up -d mongodb mongodb-schema-init
```

Logs:

```bash
docker compose logs -f mongodb mongodb-schema-init
```

The app-user creation script in `/docker-entrypoint-initdb.d` runs only when the data directory is empty. Changing credentials later does not automatically alter existing MongoDB users. Persistent data remains in the named volume when containers stop or are recreated. Do not use `docker compose down -v` unless you intend to delete the database volume.
