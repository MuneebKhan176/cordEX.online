//Wallets_Config/walletIdGenerator.js   

const crypto = require("crypto");
/*
-- UID-284-QXM-731   → User
-- SAME AS USERS   → Pending User
-- ACC-638-HKD-251   → Funding Account
-- TXN-127-BRW-964   → Ledger Transaction
-- CR-583-NGP-146    → Credit Ledger
-- DR-892-XLC-507    → Debit Ledger

-- SP-314-KJH-682    → Spot Wallet
-- HLD-706-MVT-193    → Spot Holding
-- ORD-458-TYB-921   → Spot Order
-- SPT-271-YFD-835   → Spot Trade
-- SPP-649-RAZ-117   → Spot Position

-- FT-903-PLM-284    → Futures Wallet
-- ORD-176-UYF-950   → Futures Order
-- FTP-542-HSN-316   → Futures Position
-- FTT-821-JRX-604   → Futures Trade
-- FND-397-MGP-185   → Funding Payment
-- LIQ-664-ZWF-278   → Liquidation
 */
function generateWalletId(prefix = "ACC") {
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

    const firstNumber = crypto.randomInt(0, 1000)
        .toString()
        .padStart(3, "0");

    let randomLetters = "";
    for (let i = 0; i < 3; i++) {
        randomLetters += letters[crypto.randomInt(0, 26)];
    }

    const secondNumber = crypto.randomInt(0, 1000)
        .toString()
        .padStart(3, "0");

    return `${prefix}-${firstNumber}-${randomLetters}-${secondNumber}`;
}

// Whitelist of table/column pairs this is allowed to check against.
// Prevents accidental (or injected) arbitrary SQL identifiers, since
// table/column names can't be parameterized with placeholders.
//
// Every VARCHAR(20) PRIMARY KEY / UNIQUE id column in the schema that's
// marked "app-generated" in the CREATE TABLE comments should have an
// entry here. chat_rooms.room_id is intentionally excluded — it's a
// VARCHAR(36) UUID generated a different way, not one of these
// PREFIX-###-AAA-### ids.
const ALLOWED_TARGETS = {
    "users.id": true,
    "pending_users.id": true,
    "accounts.account_number": true,
    "ledger_transactions.id": true,
    "credit_ledger.id": true,
    "debit_ledger.id": true,

    "spot_wallet.wallet_id": true,
    "spot_holdings.holding_id": true,
    "spot_orders.order_id": true,
    "spot_trades.trade_id": true,
    "spot_positions.position_id": true,

    "futures_wallet.wallet_id": true,
    "futures_orders.order_id": true,
    "positions.position_id": true,
    "futures_trades.trade_id": true,
    "funding_payments.funding_id": true,
    "liquidations.liquidation_id": true,
};

/**
 * Generates a wallet ID and retries on collision, checked against the
 * given table/column on the SAME connection the caller is already using
 * (so it's safe to call inside an open transaction — no dirty reads of
 * uncommitted IDs from other connections/pool members).
 *
 * @param {object} connection - mysql2 connection or pool (must support .query)
 * @param {string} table
 * @param {string} column
 * @param {string} prefix - e.g. "UID" | "ACC" | "TXN" | "CR" | "DR" | "SP" | "HLD" | "SPO" | "SPT" | "SPP" | "FT" | "FTO" | "FTP" | "FTT" | "FND" | "LIQ"
 * @param {number} maxAttempts
 * @returns {Promise<string>}
 */
function generateUniqueWalletId(connection, table, column, prefix, maxAttempts = 8) {
    const key = `${table}.${column}`;
    if (!ALLOWED_TARGETS[key]) {
        throw new Error(`generateUniqueWalletId: unsupported target ${key}`);
    }

    const attempt = (n) => new Promise((resolve, reject) => {
        if (n >= maxAttempts) {
            return reject(new Error(`Could not generate a unique ${prefix} id after ${maxAttempts} attempts`));
        }

        const candidate = generateWalletId(prefix);

        connection.query(
            `SELECT 1 FROM ${table} WHERE ${column} = ? LIMIT 1`,
            [candidate],
            (err, result) => {
                if (err) return reject(err);
                if (result.length > 0) return resolve(attempt(n + 1)); // collision, retry
                resolve(candidate);
            }
        );
    });

    return attempt(0);
}

module.exports = { generateWalletId, generateUniqueWalletId };