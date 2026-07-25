// Wallets_Config/walletServices.js

const { generateUniqueWalletId } = require("./walletIdGenerator");

/**
 * Inserts a spot_wallet row. wallet_id is a VARCHAR(20) PRIMARY KEY
 * app-generated id (SP-###-AAA-###) with no schema default, so it must
 * be generated and supplied explicitly — this previously omitted
 * wallet_id from the INSERT and read back result.insertId, which only
 * exists for AUTO_INCREMENT columns and would have failed/returned
 * nothing useful against this schema.
 */
function createSpotWallet(connection, userId, callback) {
    generateUniqueWalletId(connection, "spot_wallet", "wallet_id", "SP")
        .then((walletId) => {
            const sql = `INSERT INTO spot_wallet (wallet_id, user_id) VALUES (?, ?)`;
            connection.query(sql, [walletId, userId], (err) => {
                if (err) return callback(err);
                return callback(null, walletId);
            });
        })
        .catch(callback);
}

/**
 * Inserts a futures_wallet row with schema defaults for everything but
 * the id. wallet_balance defaults to 0, status defaults to 'ACTIVE' per
 * the table definition — available_margin/used_margin no longer exist
 * as columns in the v2 schema (they're RAM-only, see LiveStateStore.js).
 * wallet_id is a VARCHAR(20) PRIMARY KEY app-generated id
 * (FT-###-AAA-###) with no schema default, generated the same way as
 * createSpotWallet above.
 */
function createFuturesWallet(connection, userId, callback) {
    generateUniqueWalletId(connection, "futures_wallet", "wallet_id", "FT")
        .then((walletId) => {
            const sql = `INSERT INTO futures_wallet (wallet_id, user_id) VALUES (?, ?)`;
            connection.query(sql, [walletId, userId], (err) => {
                if (err) return callback(err);
                return callback(null, walletId);
            });
        })
        .catch(callback);
}

/**
 * Creates both the spot and futures wallets for a newly verified user.
 *
 * @param {object} connection - active mysql2 connection, expected to be
 *                               mid-transaction with the caller.
 * @param {string} userId - the UID-###-AAA-### id, not a numeric id.
 * @param {(err: Error|null, wallets?: { spotWalletId: string, futuresWalletId: string }) => void} callback
 */
function createUserWallets(connection, userId, callback) {
    if (!userId) {
        return callback(new Error('createUserWallets: userId is required'));
    }

    createSpotWallet(connection, userId, (spotErr, spotWalletId) => {
        if (spotErr) {
            // Wrap with context so the caller's error log/response is useful
            // without needing to know which insert failed.
            const wrapped = new Error(`Spot wallet creation failed: ${spotErr.message}`);
            wrapped.cause = spotErr;
            return callback(wrapped);
        }

        createFuturesWallet(connection, userId, (futuresErr, futuresWalletId) => {
            if (futuresErr) {
                const wrapped = new Error(`Futures wallet creation failed: ${futuresErr.message}`);
                wrapped.cause = futuresErr;
                return callback(wrapped);
            }

            return callback(null, { spotWalletId, futuresWalletId });
        });
    });
}

module.exports = { createUserWallets, createSpotWallet, createFuturesWallet };