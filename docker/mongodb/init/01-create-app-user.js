const databaseName = process.env.MONGO_DB_NAME;
const username = process.env.MONGO_APP_USERNAME;
const password = process.env.MONGO_APP_PASSWORD;

if (!databaseName || !username || !password) {
    throw new Error("MongoDB application credentials are missing");
}

const applicationDatabase = db.getSiblingDB(databaseName);

applicationDatabase.createUser({
    user: username,
    pwd: password,
    roles: [
        {
            role: "readWrite",
            db: databaseName
        }
    ]
});

print("CORDEX MongoDB application user created.");
