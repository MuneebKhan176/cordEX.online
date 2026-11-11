const fs = require("node:fs");
const path = require("node:path");
const mysql = require("mysql2/promise");

function requiredEnv(name) {
    const value = process.env[name];
    if (!value) throw new Error(`Missing required environment variable: ${name}`);
    return value;
}

function quoteSqlString(value) {
    return "'" + value.replace(/\\/g, "\\\\").replace(/'/g, "''") + "'";
}

async function initAIPermissions() {
    const database = requiredEnv("DB_NAME");
    const username = requiredEnv("AI_DB_USER");
    if (!/^[A-Za-z0-9_]+$/.test(database)) {
        throw new Error("DB_NAME may contain only letters, digits, and underscores.");
    }
    if (!/^[A-Za-z0-9_]+$/.test(username) || ["root", "admin"].includes(username.toLowerCase())) {
        throw new Error("AI_DB_USER must be a dedicated account name containing only letters, digits, and underscores.");
    }

    const sqlPath = path.join(__dirname, "ai_permissions.sql");
    const sql = fs.readFileSync(sqlPath, "utf8")
        .replaceAll("__AI_DB_USER__", username)
        .replaceAll("__AI_DB_PASSWORD__", quoteSqlString(requiredEnv("AI_DB_PASSWORD")));

    if (sql.includes("__AI_DB_USER__") || sql.includes("__AI_DB_PASSWORD__")) {
        throw new Error("AI permission SQL contains an unreplaced environment placeholder.");
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
        await connection.query(`USE \`${database}\``);
        await connection.query(sql);
        console.log(`AI views and restricted SELECT permissions initialized for "${username}".`);
    } finally {
        await connection.end();
    }
}

initAIPermissions().catch(error => {
    console.error("AI permission initialization failed:", error.message);
    process.exitCode = 1;
});
