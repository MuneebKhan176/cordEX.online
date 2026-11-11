const fs = require("node:fs");
const path = require("node:path");
const mysql = require("mysql2/promise");

function requiredEnv(name) {
    const value = process.env[name];
    if (!value) throw new Error(`Missing required environment variable: ${name}`);
    return value;
}

async function initDatabase() {
    const database = requiredEnv("DB_NAME");
    if (!/^[A-Za-z0-9_]+$/.test(database)) {
        throw new Error("DB_NAME may contain only letters, digits, and underscores.");
    }

    const connection = await mysql.createConnection({
        host: requiredEnv("DB_HOST"),
        port: Number(process.env.DB_PORT || 3306),
        user: process.env.MYSQL_ROOT_USER || "root",
        password: requiredEnv("MYSQL_ROOT_PASSWORD"),
        multipleStatements: true,
        connectTimeout: 10000
    });

    try {
        await connection.query(`CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
        await connection.query(`USE \`${database}\``);

        const schemaPath = path.join(__dirname, "schema.sql");
        const schemaSql = fs.readFileSync(schemaPath, "utf8");
        await connection.query(schemaSql);
        console.log(`MySQL schema initialized successfully in database "${database}".`);
    } finally {
        await connection.end();
    }
}

initDatabase().catch(error => {
    console.error("MySQL schema initialization failed:", error.message);
    process.exitCode = 1;
});
