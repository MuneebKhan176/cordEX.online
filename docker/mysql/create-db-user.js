const mysql = require("mysql2/promise");

function requiredEnv(name) {
    const value = process.env[name];
    if (value === undefined || value === "") {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

function quoteSqlString(value) {
    return "'" + value.replace(/\\/g, "\\\\").replace(/'/g, "''") + "'";
}

async function createDatabaseUser() {
    const database = requiredEnv("DB_NAME");
    const username = requiredEnv("DB_USERNAME");
    const password = requiredEnv("DB_PASSWORD");

    if (!/^[A-Za-z0-9_]+$/.test(database)) {
        throw new Error("DB_NAME may contain only letters, digits, and underscores.");
    }

    if (!/^[A-Za-z0-9_]+$/.test(username) ||
        ["root", "admin"].includes(username.toLowerCase())) {
        throw new Error(
            "DB_USERNAME must be a dedicated account name containing only letters, digits, and underscores."
        );
    }

    const rootUser = process.env.MYSQL_ROOT_USER || "root";
    const rootPassword = requiredEnv("MYSQL_ROOT_PASSWORD");

    const connection = await mysql.createConnection({
        host: requiredEnv("DB_HOST"),
        port: Number(process.env.DB_PORT || 3306),
        user: rootUser,
        password: rootPassword,
        connectTimeout: 10000
    });

    const account = `${quoteSqlString(username)}@'%'`;
    const passwordLiteral = quoteSqlString(password);
    const databaseIdentifier = "`" + database + "`";

    try {
        await connection.query(
            `CREATE USER IF NOT EXISTS ${account} IDENTIFIED BY ${passwordLiteral}`
        );
        await connection.query(
            `ALTER USER ${account} IDENTIFIED BY ${passwordLiteral}`
        );
        await connection.query(
            `GRANT ALL PRIVILEGES ON ${databaseIdentifier}.* TO ${account}`
        );

        console.log(
            `MySQL application user "${username}"@'%' is ready for database "${database}".`
        );
    } finally {
        await connection.end();
    }
}

createDatabaseUser().catch(error => {
    console.error("MySQL application-user initialization failed:", error.message);
    process.exitCode = 1;
});
