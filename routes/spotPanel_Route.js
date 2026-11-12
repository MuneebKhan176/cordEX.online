const express = require("express");
const path = require("path");
const router = express.Router();

// Same db module used across the app (authRoutes.js, walletRoutes.js …)
// `conn` = the shared pool, safe for one-shot queries. `getConnection` =
// checks out ONE dedicated connection for a real transaction (BEGIN ...
// FOR UPDATE ... COMMIT) — required any time locking is involved.
const { conn, getConnection } = require("../Databases/MySQL/db_connection");

// Same auth middleware used by /dashboard, /funding-wallet, etc. — sets req.user.id from the JWT cookie.
const verifyToken = require("../middle/middleware");

// TCP client for the C++ CryptoTrade engine (see engine/trade_engine.cpp).
const { sendOrderToEngine, cancelOrderOnEngine, engineEvents } = require("../Spot_Engine/engineClient");

// Locking module — every function here takes the SAME dedicated
// connection as the surrounding transaction, never the shared pool.
// Unchanged by the OCO migration: OCO is placed with side='SELL', and
// lockForOrder already reserves the base asset quantity for any non-BUY
// side, exactly like a plain SELL.
const { lockForOrder, unlockOnCancel, releaseOnFill } = require("../Wallets_Config/spotHoldings_Lock");

// Push notifier over the same market-data WebSocket layer — lets us tell
// a user's browser "go refresh your balance/orders" the instant one of
// their orders fills, even if that fill happened minutes later off a
// resting LIMIT/OCO leg with no HTTP request in flight to piggyback on.
const { notifyUserTradeUpdate } = require("../Web_Sockets/marketData_ws");

// ID-format schema migration: order_id, trade_id, and holding_id are all
// now app-generated PREFIX-###-AAA-### strings (VARCHAR PK, no
// AUTO_INCREMENT), instead of relying on insertResult.insertId.
const { generateUniqueWalletId } = require("../Wallets_Config/walletIdGenerator");

function sendResponse(res, statusCode, success, message, data = null) {
    return res.status(statusCode).json({ success, message, data });
}

// Promise-flavored query helper for the shared pool — fine for one-shot,
// non-transactional reads (GET endpoints below).
function query(sql, params) {
    return new Promise((resolve, reject) => {
        conn.query(sql, params, (err, result) => {
            if (err) return reject(err);
            resolve(result);
        });
    });
}

// Same helper, but bound to a specific dedicated connection — use this
// for anything that must run inside a transaction alongside a lock/
// unlock/release call.
function txQuery(connection, sql, params) {
    return new Promise((resolve, reject) => {
        connection.query(sql, params, (err, result) => {
            if (err) return reject(err);
            resolve(result);
        });
    });
}
function beginTransaction(connection) {
    return new Promise((resolve, reject) => {
        connection.beginTransaction((err) => (err ? reject(err) : resolve()));
    });
}
function commit(connection) {
    return new Promise((resolve, reject) => {
        connection.commit((err) => (err ? reject(err) : resolve()));
    });
}
function rollback(connection) {
    return new Promise((resolve) => {
        connection.rollback(() => resolve());
    });
}

/* ═══════════════════════════════════════════════════════════════════════
   SUPPORTED SYMBOLS
   ═══════════════════════════════════════════════════════════════════════ */
const SUPPORTED_SYMBOLS = ["BTC", "ETH", "BNB", "SOL", "XRP", "USDC"];

function toEnginePair(baseSymbol) {
    return `${baseSymbol}USDT`;
}
function fromEnginePair(pairSymbol) {
    return pairSymbol.endsWith("USDT") ? pairSymbol.slice(0, -4) : pairSymbol;
}

/* ═══════════════════════════════════════════════════════════════════════
   LIVE MARKET PRICE (server-side, never trusted from the client)
   ═══════════════════════════════════════════════════════════════════════ */
async function getMarketPrice(symbol) {
    const url = `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}USDT`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Binance responded with status ${r.status}`);
    const data = await r.json();
    const price = parseFloat(data.price);
    if (!price || isNaN(price)) throw new Error("Binance returned an invalid price");
    return price;
}

/* ═══════════════════════════════════════════════════════════════════════
   ORDER VALIDATION
   ───────────────────────────────────────────────────────────────────────
   Rewritten for the OCO migration:
     - No more take_profit_price / stop_loss_price attached to BUY orders.
     - OCO is its own order_type: SELL-only, carries limit_price (the
       upper, take-profit-style leg) and the new stop_price (the lower,
       stop-loss-style leg). Whichever leg the market reaches first fires;
       same semantics as the engine's OCO handling.

   Reused as-is by the new PATCH-style "modify order" flow below: a
   modification is validated with exactly the same rules as a brand-new
   order of the same type, against a fresh market price.
   ═══════════════════════════════════════════════════════════════════════ */
function validateOrderRequest(body, marketPrice) {
    const errors = [];

    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return { valid: false, errors: ["Malformed request body"] };
    }

    const { symbol, side, order_type, quantity, limit_price, stop_price } = body;

    if (!symbol || typeof symbol !== "string") errors.push("Symbol is required");
    if (side !== "BUY" && side !== "SELL") errors.push("Side must be BUY or SELL");
    if (order_type !== "MARKET" && order_type !== "LIMIT" && order_type !== "OCO") {
        errors.push("Order type must be MARKET, LIMIT, or OCO");
    }

    if (errors.length) return { valid: false, errors };

    const upperSymbol = symbol.toUpperCase();
    if (!SUPPORTED_SYMBOLS.includes(upperSymbol)) {
        errors.push(`Symbol '${upperSymbol}' is not supported for trading`);
    }

    const qty = parseFloat(quantity);
    if (quantity === undefined || quantity === null || isNaN(qty) || qty <= 0) {
        errors.push("Quantity must be a number greater than 0");
    }

    if (order_type === "OCO" && side !== "SELL") {
        errors.push("OCO orders are only supported on the SELL side");
    }

    let limitPrice = null;
    let stopPrice = null;

    if (order_type === "LIMIT") {
        limitPrice = parseFloat(limit_price);
        if (limit_price === undefined || limit_price === null || isNaN(limitPrice) || limitPrice <= 0) {
            errors.push("LIMIT orders require a limit_price greater than 0");
        }
        if (stop_price !== undefined && stop_price !== null && stop_price !== "") {
            errors.push("LIMIT orders must not include a stop_price");
        }
    } else if (order_type === "MARKET") {
        if (limit_price !== undefined && limit_price !== null && limit_price !== "") {
            errors.push("MARKET orders must not include a limit_price");
        }
        if (stop_price !== undefined && stop_price !== null && stop_price !== "") {
            errors.push("MARKET orders must not include a stop_price");
        }
    } else if (order_type === "OCO") {
        limitPrice = parseFloat(limit_price);
        stopPrice = parseFloat(stop_price);
        if (limit_price === undefined || limit_price === null || isNaN(limitPrice) || limitPrice <= 0) {
            errors.push("OCO orders require a positive limit_price (take-profit leg)");
        }
        if (stop_price === undefined || stop_price === null || isNaN(stopPrice) || stopPrice <= 0) {
            errors.push("OCO orders require a positive stop_price (stop-loss leg)");
        }
        if (!isNaN(limitPrice) && !isNaN(stopPrice) && limitPrice <= stopPrice) {
            errors.push("OCO limit_price (take-profit leg) must be above stop_price (stop-loss leg)");
        }
    }

    if (errors.length) return { valid: false, errors };

    if (order_type === "LIMIT") {
        if (side === "BUY" && limitPrice >= marketPrice) {
            errors.push(`Buy limit price must be below the current market price (${marketPrice})`);
        } else if (side === "SELL" && limitPrice <= marketPrice) {
            errors.push(`Sell limit price must be above the current market price (${marketPrice})`);
        }
    } else if (order_type === "OCO") {
        // Same shape as a SELL limit check, applied to both legs: the
        // take-profit leg sits above market, the stop leg sits below it.
        if (limitPrice <= marketPrice) {
            errors.push(`OCO take-profit price must be above the current market price (${marketPrice})`);
        }
        if (stopPrice >= marketPrice) {
            errors.push(`OCO stop price must be below the current market price (${marketPrice})`);
        }
    }

    if (errors.length) return { valid: false, errors };

    // entry_price_reference only matters for sizing a BUY's USDT lock.
    // SELL and OCO lock the base asset quantity itself, independent of
    // price, so there's nothing to reference there.
    const entryPrice =
        order_type === "MARKET" ? marketPrice :
        order_type === "LIMIT" ? limitPrice :
        null;

    return {
        valid: true,
        errors: [],
        normalized: {
            symbol: upperSymbol,
            side,
            order_type,
            quantity: qty,
            limit_price: limitPrice,   // LIMIT: the limit price. OCO: upper/take-profit-style leg.
            stop_price: stopPrice,     // OCO only: lower/stop-loss-style leg.
            entry_price_reference: entryPrice,
            market_price_reference: marketPrice,
        },
    };
}

/* ═══════════════════════════════════════════════════════════════════════
   PAGES
   ═══════════════════════════════════════════════════════════════════════ */
router.get("/spot-trade", verifyToken, (req, res) => {
    res.sendFile(path.join(__dirname, "../Frontend/TradePanels_UI/spot_trade.html"));
});

/* ═══════════════════════════════════════════════════════════════════════
   SPOT WALLET  (GET /api/spot/wallet)
   ═══════════════════════════════════════════════════════════════════════ */
router.get("/api/spot/wallet", verifyToken, (req, res) => {
    const userId = req.user.id;

    conn.query(
        "SELECT wallet_id, status FROM spot_wallet WHERE user_id = ?",
        [userId],
        (err, walletResult) => {
            if (err) return sendResponse(res, 500, false, "Database error");
            if (!walletResult.length) return sendResponse(res, 404, false, "Spot wallet not found");

            const wallet = walletResult[0];

            conn.query(
                `SELECT symbol, available_quantity, locked_quantity, average_buy_price, total_cost
                 FROM spot_holdings
                 WHERE wallet_id = ?`,
                [wallet.wallet_id],
                (holdingsErr, holdingsResult) => {
                    if (holdingsErr) return sendResponse(res, 500, false, "Database error");

                    const holdings = holdingsResult.map(h => ({
                        symbol: h.symbol,
                        available_quantity: parseFloat(h.available_quantity),
                        locked_quantity: parseFloat(h.locked_quantity),
                        average_buy_price: parseFloat(h.average_buy_price),
                        total_cost: parseFloat(h.total_cost),
                    }));

                    return sendResponse(res, 200, true, "Spot wallet loaded", {
                        wallet_id: wallet.wallet_id,
                        status: wallet.status,
                        holdings,
                    });
                }
            );
        }
    );
});

/* ═══════════════════════════════════════════════════════════════════════
   OPEN ORDERS  (GET /api/spot/orders)
   ───────────────────────────────────────────────────────────────────────
   `is_modifiable` is derived here (order_type in LIMIT/OCO AND status ===
   OPEN) so the frontend doesn't have to re-implement that rule to decide
   whether to render the pencil/edit icon for a given row.
   ═══════════════════════════════════════════════════════════════════════ */
router.get("/api/spot/orders", verifyToken, (req, res) => {
    const userId = req.user.id;

    conn.query(
        `SELECT order_id, symbol, side, order_type, quantity, remaining_quantity,
                limit_price, locked_price, stop_price, status, created_at
         FROM spot_orders
         WHERE user_id = ? AND status IN ('OPEN', 'PARTIALLY_FILLED')
         ORDER BY created_at DESC`,
        [userId],
        (err, result) => {
            if (err) return sendResponse(res, 500, false, "Database error");

            const orders = result.map(o => ({
                order_id: o.order_id,
                symbol: o.symbol,
                side: o.side,
                order_type: o.order_type,
                quantity: parseFloat(o.quantity),
                remaining_quantity: parseFloat(o.remaining_quantity),
                limit_price: o.limit_price !== null ? parseFloat(o.limit_price) : null,
                locked_price: o.locked_price !== null ? parseFloat(o.locked_price) : null,
                stop_price: o.stop_price !== null ? parseFloat(o.stop_price) : null,
                status: o.status,
                created_at: o.created_at,
                // MARKET orders fill immediately and never reach this
                // list; PARTIALLY_FILLED orders already have a live fill
                // on the books, so only untouched OPEN LIMIT/OCO orders
                // can be modified.
                is_modifiable: (o.order_type === "LIMIT" || o.order_type === "OCO") && o.status === "OPEN",
            }));

            return sendResponse(res, 200, true, "Open orders loaded", orders);
        }
    );
});

/* ═══════════════════════════════════════════════════════════════════════
   TRADE HISTORY  (GET /api/spot/trades)
   ───────────────────────────────────────────────────────────────────────
   Returns BOTH filled trades AND orders that were cancelled before ever
   generating a fill, merged into one time-ordered list — newest first.
   ═══════════════════════════════════════════════════════════════════════ */
router.get("/api/spot/trades", verifyToken, (req, res) => {
    const userId = req.user.id;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);

    conn.query(
        `SELECT * FROM (
            SELECT t.trade_id AS trade_id, t.order_id AS order_id, t.symbol AS symbol,
                   t.quantity AS quantity, t.price AS price, t.commission AS commission,
                   t.executed_at AS executed_at, o.side AS side, o.order_type AS order_type,
                   o.status AS order_status
            FROM spot_trades t
            JOIN spot_orders o ON o.order_id = t.order_id
            WHERE t.user_id = ?

            UNION ALL

            SELECT NULL AS trade_id, o.order_id AS order_id, o.symbol AS symbol,
                   o.quantity AS quantity, NULL AS price, 0 AS commission,
                   o.created_at AS executed_at, o.side AS side, o.order_type AS order_type,
                   o.status AS order_status
            FROM spot_orders o
            WHERE o.user_id = ?
              AND o.status = 'CANCELLED'
              AND NOT EXISTS (SELECT 1 FROM spot_trades t2 WHERE t2.order_id = o.order_id)
         ) combined
         ORDER BY executed_at DESC
         LIMIT ?`,
        [userId, userId, limit],
        (err, rows) => {
            if (err) return sendResponse(res, 500, false, "Database error");

            const trades = rows.map(t => ({
                trade_id: t.trade_id,
                order_id: t.order_id,
                symbol: t.symbol,
                quantity: parseFloat(t.quantity),
                price: t.price !== null ? parseFloat(t.price) : null,
                commission: parseFloat(t.commission),
                executed_at: t.executed_at,
                side: t.side,
                order_type: t.order_type,
                order_status: t.order_status,
            }));

            return sendResponse(res, 200, true, "Trade history loaded", trades);
        }
    );
});

/* ═══════════════════════════════════════════════════════════════════════
   ORDER BOOK  (GET /api/spot/orderbook?symbol=BTC)
   ═══════════════════════════════════════════════════════════════════════ */
router.get("/api/spot/orderbook", verifyToken, (req, res) => {
    const symbol = (req.query.symbol || "").toUpperCase();
    if (!symbol) return sendResponse(res, 400, false, "Missing symbol query param");

    const bookQuery = `
        SELECT side, limit_price, SUM(remaining_quantity) AS total_qty
        FROM spot_orders
        WHERE symbol = ?
          AND order_type IN ('LIMIT', 'OCO')
          AND status IN ('OPEN', 'PARTIALLY_FILLED')
          AND limit_price IS NOT NULL
        GROUP BY side, limit_price
        ORDER BY limit_price DESC
    `;

    conn.query(bookQuery, [symbol], (err, rows) => {
        if (err) return sendResponse(res, 500, false, "Database error");

        const bids = rows
            .filter(r => r.side === "BUY")
            .map(r => [parseFloat(r.limit_price), parseFloat(r.total_qty)]);

        const asks = rows
            .filter(r => r.side === "SELL")
            .map(r => [parseFloat(r.limit_price), parseFloat(r.total_qty)]);

        return sendResponse(res, 200, true, "Order book loaded", { symbol, bids, asks });
    });
});

/* ═══════════════════════════════════════════════════════════════════════
   PLACE ORDER  (POST /api/spot/order)
   ───────────────────────────────────────────────────────────────────────
   ID-FORMAT SCHEMA CHANGE: spot_orders.order_id is now an app-generated
   ORD-###-AAA-### string (VARCHAR PK, no AUTO_INCREMENT), so it must be
   generated with generateUniqueWalletId() BEFORE the INSERT and written
   explicitly — insertResult.insertId no longer exists for this table.
   Same connection, same transaction as the lock, so an id-collision retry
   or a lock failure both roll back cleanly together.
   ═══════════════════════════════════════════════════════════════════════ */
router.post("/api/spot/order", verifyToken, async (req, res) => {
    const userId = req.user.id;
    const symbolInput = req.body && req.body.symbol;

    if (!symbolInput || typeof symbolInput !== "string") {
        return sendResponse(res, 400, false, "Order validation failed", { errors: ["Symbol is required"] });
    }

    const upperSymbol = symbolInput.toUpperCase();
    if (!SUPPORTED_SYMBOLS.includes(upperSymbol)) {
        return sendResponse(res, 400, false, "Order validation failed", {
            errors: [`Symbol '${upperSymbol}' is not supported for trading`],
        });
    }

    let marketPrice;
    try {
        marketPrice = await getMarketPrice(upperSymbol);
    } catch (e) {
        return sendResponse(res, 502, false, "Could not fetch a live market price right now. Please try again.");
    }

    const validation = validateOrderRequest(req.body, marketPrice);
    if (!validation.valid) {
        return sendResponse(res, 400, false, "Order validation failed", { errors: validation.errors });
    }

    const packet = validation.normalized;

    let connection;
    try {
        connection = await getConnection();
    } catch (e) {
        return sendResponse(res, 500, false, "Could not acquire a database connection.");
    }

    let orderId;
    let wallet;
    try {
        await beginTransaction(connection);

        const walletRows = await txQuery(connection, "SELECT wallet_id, status FROM spot_wallet WHERE user_id = ?", [userId]);
        if (!walletRows.length) {
            await rollback(connection);
            return sendResponse(res, 404, false, "Spot wallet not found");
        }
        wallet = walletRows[0];
        if (wallet.status !== "ACTIVE") {
            await rollback(connection);
            return sendResponse(res, 403, false, "Spot wallet is blocked");
        }

        // Reserve funds/asset BEFORE the order exists. For BUY,
        // estimatedPrice sizes the USDT lock (persisted below as
        // locked_price). For SELL and OCO it's unused — the lock is just
        // `quantity` of the base asset, regardless of price.
        try {
            await lockForOrder(connection, {
                walletId: wallet.wallet_id,
                side: packet.side,
                symbol: packet.symbol,
                quantity: packet.quantity,
                estimatedPrice: packet.entry_price_reference,
            });
        } catch (lockErr) {
            await rollback(connection);
            return sendResponse(res, 400, false, lockErr.message);
        }

        // order_id has no AUTO_INCREMENT anymore — generate + collision-
        // check it on this same transactional connection.
        orderId = await generateUniqueWalletId(connection, "spot_orders", "order_id", "SPO");

        await txQuery(
            connection,
            `INSERT INTO spot_orders
                (order_id, user_id, wallet_id, symbol, side, order_type, quantity, remaining_quantity,
                 limit_price, locked_price, stop_price, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN')`,
            [
                orderId, userId, wallet.wallet_id, packet.symbol, packet.side, packet.order_type,
                packet.quantity, packet.quantity, packet.limit_price, packet.entry_price_reference,
                packet.stop_price,
            ]
        );

        await commit(connection);
    } catch (dbErr) {
        await rollback(connection);
        return sendResponse(res, 500, false, "Database error while placing order");
    } finally {
        connection.release();
    }

    const enginePacket = {
        action: "PLACE_ORDER",
        order_id: orderId,
        user_id: userId,
        wallet_id: wallet.wallet_id,
        symbol: toEnginePair(packet.symbol),
        side: packet.side,
        order_type: packet.order_type,
        quantity: packet.quantity,
        limit_price: packet.limit_price,
        stop_price: packet.stop_price,
    };

    let engineReply;
    try {
        engineReply = await sendOrderToEngine(enginePacket);
    } catch (engineErr) {
        // Unreachable / timed out — leave the row + its lock in place;
        // recovery reconciles it against whatever engine is live next.
        return sendResponse(res, 502, false,
            `Trade engine unavailable: ${engineErr.message}. Your order (#${orderId}) was saved and will be retried automatically.`,
            { order_id: orderId }
        );
    }

    if (!engineReply.accepted) {
        // Engine rejected it — release the reservation and mark
        // CANCELLED in its own transaction, since the placement
        // transaction already committed.
        await releaseRejectedOrder(orderId, packet.side, packet.symbol, packet.quantity, packet.entry_price_reference, wallet.wallet_id);
        return sendResponse(res, 400, false, "Order rejected by trade engine", {
            order_id: orderId,
            errors: engineReply.errors || [],
        });
    }

    return sendResponse(res, 200, true, "Order placed", {
        order_id: orderId,
        engine_order_id: engineReply.engine_order_id,
        wallet_id: wallet.wallet_id,
        symbol: packet.symbol,
        side: packet.side,
        order_type: packet.order_type,
        quantity: packet.quantity,
        limit_price: packet.limit_price,
        stop_price: packet.stop_price,
        entry_price_reference: packet.entry_price_reference,
        market_price_reference: packet.market_price_reference,
        status: "OPEN",
    });
});

/**
 * Shared unlock-and-cancel helper — used both when the engine rejects a
 * brand-new order and when a resting order is cancelled by the user.
 * Recomputes exactly what was reserved from remaining_quantity and the
 * persisted locked_price (BUY only), so no separate ledger of "how much
 * did we lock" needs to be maintained anywhere else. Works unchanged for
 * OCO since it's stored with side='SELL', same lock shape as a plain
 * SELL. order_id here is already the ORD-###-AAA-### string — no format
 * change needed in this function, it just passes it through in the
 * WHERE clause.
 */
async function releaseRejectedOrder(orderId, side, symbol, remainingQuantity, lockedPrice, walletId) {
    const lockSymbol = side === "BUY" ? "USDT" : symbol;
    const lockAmount = side === "BUY" ? remainingQuantity * lockedPrice : remainingQuantity;

    let connection;
    try {
        connection = await getConnection();
        await beginTransaction(connection);
        await unlockOnCancel(connection, { walletId, lockSymbol, lockAmount });
        await txQuery(connection, "UPDATE spot_orders SET status = 'CANCELLED' WHERE order_id = ?", [orderId]);
        await commit(connection);
    } catch (err) {
        if (connection) await rollback(connection);
        console.error(`Failed to release rejected order_id=${orderId}:`, err);
    } finally {
        if (connection) connection.release();
    }
}

/* ═══════════════════════════════════════════════════════════════════════
   CANCEL ORDER  (POST /api/spot/order/:order_id/cancel)
   ───────────────────────────────────────────────────────────────────────
   order_id arrives as a route param and is already the ORD-###-AAA-###
   string — no parseInt/Number coercion here (there never was any), so
   this endpoint needed no changes for the id-format migration.
   ═══════════════════════════════════════════════════════════════════════ */
router.post("/api/spot/order/:order_id/cancel", verifyToken, async (req, res) => {
    const userId = req.user.id;
    const orderId = req.params.order_id;

    try {
        const rows = await query(
            "SELECT order_id, wallet_id, symbol, side, status, remaining_quantity, locked_price FROM spot_orders WHERE order_id = ? AND user_id = ?",
            [orderId, userId]
        );
        if (!rows.length) return sendResponse(res, 404, false, "Order not found");

        const order = rows[0];
        if (order.status !== "OPEN" && order.status !== "PARTIALLY_FILLED") {
            return sendResponse(res, 400, false, `Order cannot be cancelled — current status is ${order.status}`);
        }

        let engineReply;
        try {
            engineReply = await cancelOrderOnEngine(order.order_id, toEnginePair(order.symbol));
        } catch (engineErr) {
            return sendResponse(res, 502, false, `Trade engine unavailable: ${engineErr.message}`);
        }

        if (!engineReply.cancelled) {
            // Most likely reason: it already filled (an EXECUTION for it
            // may be landing right now via handleExecution). Don't touch
            // the DB row — let the fill path be the one source of truth.
            return sendResponse(res, 409, false, engineReply.message || "Order could not be cancelled — it may have already filled");
        }

        const remaining = parseFloat(order.remaining_quantity);
        const lockedPrice = order.locked_price !== null ? parseFloat(order.locked_price) : null;
        const lockSymbol = order.side === "BUY" ? "USDT" : order.symbol;
        const lockAmount = order.side === "BUY" ? remaining * lockedPrice : remaining;

        let connection;
        try {
            connection = await getConnection();
            await beginTransaction(connection);
            await unlockOnCancel(connection, { walletId: order.wallet_id, lockSymbol, lockAmount });
            await txQuery(connection, "UPDATE spot_orders SET status = 'CANCELLED' WHERE order_id = ? AND user_id = ?", [orderId, userId]);
            await commit(connection);
        } catch (dbErr) {
            if (connection) await rollback(connection);
            return sendResponse(res, 500, false, "Database error while cancelling order");
        } finally {
            if (connection) connection.release();
        }

        return sendResponse(res, 200, true, "Order cancelled", { order_id: orderId });
    } catch (dbErr) {
        return sendResponse(res, 500, false, "Database error while cancelling order");
    }
});

/* ═══════════════════════════════════════════════════════════════════════
   MODIFY ORDER  (POST /api/spot/order/:order_id/modify)
   ───────────────────────────────────────────────────────────────────────
   The engine has no in-place "amend" concept, so a modification is
   implemented as cancel-the-old + place-a-new, reusing the exact same
   building blocks as the plain cancel and place-order endpoints above:

     1. Only LIMIT and OCO orders that are still fully OPEN are eligible.
        MARKET orders fill the instant they're submitted, so there's
        nothing pending to edit. A PARTIALLY_FILLED order already has a
        real fill booked against it — replacing "the rest of it" would
        require splitting a trade history record, so it's excluded too
        (matches spot_orders.status semantics: only a still-OPEN row has
        never executed at all).
     2. The new parameters are validated with the exact same rules as a
        brand-new order of that type, against a fresh market price.
     3. The existing order is cancelled on the engine first. If the
        engine reports it couldn't cancel (most likely: it just filled),
        nothing else happens — the original order is left exactly as-is
        and the client is told the modification didn't go through.
     4. Only once the engine confirms the cancel do we unwind the old
        order's DB row and fund/asset lock (identical accounting to
        POST /:order_id/cancel), then place the replacement using the
        identical lock -> insert -> engine flow as POST /api/spot/order.

   Because the cancel and the replacement are two separate engine round
   trips, there's a brief window with no resting order on the book for
   this position — by design, since the engine doesn't support atomic
   amend. If the replacement leg fails after the cancel already
   succeeded, that is surfaced explicitly in the response (old_order_id
   cancelled, new_order_id may or may not exist) rather than silently
   dropping the user's order.
   ═══════════════════════════════════════════════════════════════════════ */
router.post("/api/spot/order/:order_id/modify", verifyToken, async (req, res) => {
    const userId = req.user.id;
    const orderId = req.params.order_id;

    // 1. Load the existing order and confirm it's actually eligible for
    // modification.
    let existingRows;
    try {
        existingRows = await query(
            `SELECT order_id, wallet_id, symbol, side, order_type, status,
                    quantity, remaining_quantity, locked_price
             FROM spot_orders WHERE order_id = ? AND user_id = ?`,
            [orderId, userId]
        );
    } catch (e) {
        return sendResponse(res, 500, false, "Database error");
    }
    if (!existingRows.length) return sendResponse(res, 404, false, "Order not found");
    const existing = existingRows[0];

    if (existing.order_type === "MARKET") {
        return sendResponse(res, 400, false, "Market orders execute immediately and cannot be modified");
    }
    if (existing.order_type !== "LIMIT" && existing.order_type !== "OCO") {
        return sendResponse(res, 400, false, "This order type cannot be modified");
    }
    if (existing.status !== "OPEN") {
        return sendResponse(res, 400, false,
            `Order cannot be modified — current status is ${existing.status}. Only orders that have not started executing can be modified.`);
    }

    // 2. Validate the replacement parameters. Anything the client omits
    // falls back to the existing order's own value, so a caller can send
    // just the field(s) they actually changed (e.g. only a new
    // limit_price).
    let marketPrice;
    try {
        marketPrice = await getMarketPrice(existing.symbol);
    } catch (e) {
        return sendResponse(res, 502, false, "Could not fetch a live market price right now. Please try again.");
    }

    // Anything the caller didn't send falls back to the order's current
    // value, so a client can submit just the field it actually changed
    // (e.g. only a new limit_price) and still get a fully-formed packet
    // to validate.
    let currentPriceRow;
    try {
        const priceRows = await query("SELECT limit_price, stop_price FROM spot_orders WHERE order_id = ?", [orderId]);
        currentPriceRow = priceRows[0] || {};
    } catch (e) {
        return sendResponse(res, 500, false, "Database error");
    }

    const body = req.body || {};
    const hasValue = (v) => v !== undefined && v !== null && v !== "";

    const modifyRequestBody = {
        symbol: existing.symbol,
        side: existing.side,
        order_type: existing.order_type,
        quantity: hasValue(body.quantity) ? body.quantity : parseFloat(existing.quantity),
        limit_price: hasValue(body.limit_price)
            ? body.limit_price
            : (currentPriceRow.limit_price !== null ? parseFloat(currentPriceRow.limit_price) : undefined),
        stop_price: hasValue(body.stop_price)
            ? body.stop_price
            : (currentPriceRow.stop_price !== null && currentPriceRow.stop_price !== undefined
                ? parseFloat(currentPriceRow.stop_price)
                : undefined),
    };

    const validation = validateOrderRequest(modifyRequestBody, marketPrice);
    if (!validation.valid) {
        return sendResponse(res, 400, false, "Order validation failed", { errors: validation.errors });
    }
    const packet = validation.normalized;

    // 3. Cancel the existing order on the engine FIRST. If this fails
    // (already filled / already gone), stop here — nothing about the
    // original order or its lock is touched.
    let cancelReply;
    try {
        cancelReply = await cancelOrderOnEngine(existing.order_id, toEnginePair(existing.symbol));
    } catch (engineErr) {
        return sendResponse(res, 502, false, `Trade engine unavailable: ${engineErr.message}`);
    }
    if (!cancelReply.cancelled) {
        return sendResponse(res, 409, false,
            cancelReply.message || "Order could not be modified — it may have already filled");
    }

    // 4. Engine-side cancel confirmed — unwind the old DB row + lock,
    // identical accounting to POST /:order_id/cancel.
    const oldRemaining = parseFloat(existing.remaining_quantity);
    const oldLockedPrice = existing.locked_price !== null ? parseFloat(existing.locked_price) : null;
    const oldLockSymbol = existing.side === "BUY" ? "USDT" : existing.symbol;
    const oldLockAmount = existing.side === "BUY" ? oldRemaining * oldLockedPrice : oldRemaining;

    try {
        const cancelConnection = await getConnection();
        try {
            await beginTransaction(cancelConnection);
            await unlockOnCancel(cancelConnection, { walletId: existing.wallet_id, lockSymbol: oldLockSymbol, lockAmount: oldLockAmount });
            await txQuery(cancelConnection, "UPDATE spot_orders SET status = 'CANCELLED' WHERE order_id = ? AND user_id = ?", [orderId, userId]);
            await commit(cancelConnection);
        } catch (dbErr) {
            await rollback(cancelConnection);
            throw dbErr;
        } finally {
            cancelConnection.release();
        }
    } catch (dbErr) {
        // The engine has already dropped the old order at this point —
        // surface this loudly rather than letting the UI believe it's
        // still live.
        console.error(`Modify order: engine cancel succeeded but DB unwind failed for order_id=${orderId}:`, dbErr);
        return sendResponse(res, 500, false,
            "The order was cancelled on the trade engine, but updating the database failed. Please refresh your open orders before retrying.",
            { old_order_id: orderId }
        );
    }

    // 5. Place the replacement — identical lock -> insert -> engine flow
    // as POST /api/spot/order.
    let placeConnection;
    try {
        placeConnection = await getConnection();
    } catch (e) {
        return sendResponse(res, 500, false,
            "The original order was cancelled, but a database connection could not be acquired to place the replacement. Please place a new order manually.",
            { old_order_id: orderId }
        );
    }

    let newOrderId;
    let walletId;
    try {
        await beginTransaction(placeConnection);

        const walletRows = await txQuery(placeConnection, "SELECT wallet_id, status FROM spot_wallet WHERE user_id = ?", [userId]);
        if (!walletRows.length) {
            await rollback(placeConnection);
            return sendResponse(res, 404, false,
                "The original order was cancelled, but your spot wallet could not be found for the replacement order.",
                { old_order_id: orderId }
            );
        }
        const wallet = walletRows[0];
        if (wallet.status !== "ACTIVE") {
            await rollback(placeConnection);
            return sendResponse(res, 403, false,
                "The original order was cancelled, but your spot wallet is blocked — the replacement order was not placed.",
                { old_order_id: orderId }
            );
        }
        walletId = wallet.wallet_id;

        try {
            await lockForOrder(placeConnection, {
                walletId: wallet.wallet_id,
                side: packet.side,
                symbol: packet.symbol,
                quantity: packet.quantity,
                estimatedPrice: packet.entry_price_reference,
            });
        } catch (lockErr) {
            await rollback(placeConnection);
            return sendResponse(res, 400, false,
                `The original order was cancelled, but the replacement could not be placed: ${lockErr.message}`,
                { old_order_id: orderId }
            );
        }

        newOrderId = await generateUniqueWalletId(placeConnection, "spot_orders", "order_id", "SPO");

        await txQuery(
            placeConnection,
            `INSERT INTO spot_orders
                (order_id, user_id, wallet_id, symbol, side, order_type, quantity, remaining_quantity,
                 limit_price, locked_price, stop_price, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN')`,
            [
                newOrderId, userId, wallet.wallet_id, packet.symbol, packet.side, packet.order_type,
                packet.quantity, packet.quantity, packet.limit_price, packet.entry_price_reference,
                packet.stop_price,
            ]
        );

        await commit(placeConnection);
    } catch (dbErr) {
        await rollback(placeConnection);
        return sendResponse(res, 500, false,
            "The original order was cancelled, but a database error occurred while placing the replacement order.",
            { old_order_id: orderId }
        );
    } finally {
        placeConnection.release();
    }

    const enginePacket = {
        action: "PLACE_ORDER",
        order_id: newOrderId,
        user_id: userId,
        wallet_id: walletId,
        symbol: toEnginePair(packet.symbol),
        side: packet.side,
        order_type: packet.order_type,
        quantity: packet.quantity,
        limit_price: packet.limit_price,
        stop_price: packet.stop_price,
    };

    let engineReply;
    try {
        engineReply = await sendOrderToEngine(enginePacket);
    } catch (engineErr) {
        return sendResponse(res, 502, false,
            `The original order was cancelled. Trade engine unavailable while placing the replacement: ${engineErr.message}. The replacement (#${newOrderId}) was saved and will be retried automatically.`,
            { old_order_id: orderId, new_order_id: newOrderId }
        );
    }

    if (!engineReply.accepted) {
        await releaseRejectedOrder(newOrderId, packet.side, packet.symbol, packet.quantity, packet.entry_price_reference, walletId);
        return sendResponse(res, 400, false,
            "The original order was cancelled, but the trade engine rejected the replacement order",
            { old_order_id: orderId, new_order_id: newOrderId, errors: engineReply.errors || [] }
        );
    }

    return sendResponse(res, 200, true, "Order modified", {
        old_order_id: orderId,
        order_id: newOrderId,
        engine_order_id: engineReply.engine_order_id,
        wallet_id: walletId,
        symbol: packet.symbol,
        side: packet.side,
        order_type: packet.order_type,
        quantity: packet.quantity,
        limit_price: packet.limit_price,
        stop_price: packet.stop_price,
        entry_price_reference: packet.entry_price_reference,
        market_price_reference: packet.market_price_reference,
        status: "OPEN",
    });
});

/* ═══════════════════════════════════════════════════════════════════════
   FILL PERSISTENCE  (driven by the engine's EXECUTION push events)
   ───────────────────────────────────────────────────────────────────────
   ID-FORMAT SCHEMA CHANGE: both spot_trades.trade_id AND
   spot_holdings.holding_id are all app-generated PREFIX-###-AAA-###
   strings (VARCHAR PK, no AUTO_INCREMENT). Neither was ever selected by
   this file before (spot_trades used a bare INSERT with no id column,
   spot_holdings relied on an implicit default on first insert) — both
   would now throw a "doesn't have a default value" error, since the
   columns are NOT NULL PKs with no default. Fixed in persistFill() below:
   trade_id is generated once per fill and used for the single
   spot_trades INSERT; holding_id is generated before each
   INSERT ... ON DUPLICATE KEY UPDATE against spot_holdings — the
   generated id is only actually used on the INSERT branch (first time
   this wallet/symbol pair is touched); on the UPDATE branch (row already
   exists) it's simply not selected in the SET clause, so the existing
   holding_id is left untouched.
   ═══════════════════════════════════════════════════════════════════════ */
async function handleExecution(msg) {
    let connection;
    try {
        connection = await getConnection();
        await beginTransaction(connection);

        const symbol = fromEnginePair(msg.symbol);
        const fillQty = msg.fill_quantity;
        const fillPrice = msg.fill_price;

        await persistFill(connection, msg, symbol, fillQty, fillPrice);

        await commit(connection);

        // Fire only after the transaction actually commits — no point
        // telling the browser to refresh balances that aren't updated yet.
        try {
            notifyUserTradeUpdate(msg.user_id, {
                order_id: msg.order_id,
                symbol,
                side: msg.side,
                order_type: msg.order_type,
                status: msg.status,
                is_oco_leg: !!msg.is_oco_leg,
                oco_leg: msg.oco_leg || null,
                fill_quantity: fillQty,
                fill_price: fillPrice,
            });
        } catch (notifyErr) {
            // Never let a broadcast failure look like a persistence
            // failure — the fill is safely committed either way.
            console.error(`Failed to push trade_update for order_id=${msg.order_id}:`, notifyErr);
        }
    } catch (err) {
        if (connection) await rollback(connection);
        // Deliberately do not throw further — this runs off an event
        // emitter with no caller to catch it. Log loudly so a failed
        // persistence step (e.g. a transient DB blip) is visible instead
        // of silently losing a fill.
        console.error(`Failed to persist EXECUTION for order_id=${msg.order_id}:`, err);
    } finally {
        if (connection) connection.release();
    }
}

async function persistFill(connection, msg, symbol, fillQty, fillPrice) {
    const orderRows = await txQuery(
        connection,
        `SELECT order_id, user_id, wallet_id, symbol, side, status, remaining_quantity, locked_price
         FROM spot_orders WHERE order_id = ? FOR UPDATE`,
        [msg.order_id]
    );
    if (!orderRows.length) {
        console.error(`EXECUTION for unknown order_id=${msg.order_id} — ignoring`);
        return;
    }
    const order = orderRows[0];
    if (order.status === "FILLED" || order.status === "CANCELLED") {
        console.error(`Duplicate EXECUTION for order_id=${msg.order_id} (already ${order.status}) — ignoring`);
        return;
    }

    const newRemaining = Math.max(0, parseFloat(order.remaining_quantity) - fillQty);
    const newStatus = newRemaining > 0 ? "PARTIALLY_FILLED" : "FILLED";

    await txQuery(connection, "UPDATE spot_orders SET remaining_quantity = ?, status = ? WHERE order_id = ?", [newRemaining, newStatus, msg.order_id]);

    // trade_id: app-generated, no AUTO_INCREMENT — generate + collision-
    // check on this same transactional connection before the INSERT.
    const tradeId = await generateUniqueWalletId(connection, "spot_trades", "trade_id", "SPT");

    await txQuery(
        connection,
        `INSERT INTO spot_trades (trade_id, order_id, user_id, symbol, quantity, price, commission)
         VALUES (?, ?, ?, ?, ?, ?, 0)`,
        [tradeId, msg.order_id, msg.user_id, symbol, fillQty, fillPrice]
    );

    if (msg.side === "BUY") {
        const lockedPrice = parseFloat(order.locked_price);
        const releaseAmount = fillQty * lockedPrice; // exactly what was reserved for this slice
        const actualCost = fillQty * fillPrice;       // what actually got spent

        // Release the USDT lock for this filled slice first — credits
        // releaseAmount back into available_quantity — then the debit
        // below takes actualCost back out. When lockedPrice === fillPrice
        // (the normal case) those cancel out to a net-zero change beyond
        // the original reservation; any slippage flows through correctly.
        await releaseOnFill(connection, { walletId: msg.wallet_id, lockSymbol: "USDT", filledLockAmount: releaseAmount });
        await txQuery(
            connection,
            `UPDATE spot_holdings SET available_quantity = available_quantity - ?
             WHERE wallet_id = ? AND symbol = 'USDT'`,
            [actualCost, msg.wallet_id]
        );

        const cost = fillQty * fillPrice;
        // holding_id only gets used if this INSERT actually inserts (first
        // time this wallet/symbol pair is seen); on the ON DUPLICATE KEY
        // UPDATE path the row (and its existing holding_id) is untouched.
        const buyHoldingId = await generateUniqueWalletId(connection, "spot_holdings", "holding_id", "HLD");
        await txQuery(
            connection,
            `INSERT INTO spot_holdings (holding_id, wallet_id, symbol, available_quantity, locked_quantity, average_buy_price, total_cost)
             VALUES (?, ?, ?, ?, 0, ?, ?)
             ON DUPLICATE KEY UPDATE
                total_cost = total_cost + VALUES(total_cost),
                available_quantity = available_quantity + VALUES(available_quantity),
                average_buy_price = total_cost / (available_quantity + locked_quantity)`,
            [buyHoldingId, msg.wallet_id, symbol, fillQty, fillPrice, cost]
        );
    } else {
        // SELL fill — plain SELL, LIMIT SELL, or an OCO leg. The asset
        // was already moved from available_quantity into locked_quantity
        // at placement time. Release the lock for this fill — credits
        // fillQty back into available_quantity — then immediately debit
        // that same fillQty back out, since it's being sold, not
        // returned. Net effect on available_quantity is a drop of
        // fillQty overall, with nothing left dangling in locked_quantity.
        await releaseOnFill(connection, { walletId: msg.wallet_id, lockSymbol: symbol, filledLockAmount: fillQty });
        await txQuery(
            connection,
            `UPDATE spot_holdings SET available_quantity = available_quantity - ?
             WHERE wallet_id = ? AND symbol = ?`,
            [fillQty, msg.wallet_id, symbol]
        );

        const usdtHoldingId = await generateUniqueWalletId(connection, "spot_holdings", "holding_id", "HLD");
        await txQuery(
            connection,
            `INSERT INTO spot_holdings (holding_id, wallet_id, symbol, available_quantity)
             VALUES (?, ?, 'USDT', ?)
             ON DUPLICATE KEY UPDATE available_quantity = available_quantity + VALUES(available_quantity)`,
            [usdtHoldingId, msg.wallet_id, fillQty * fillPrice]
        );
    }
}

engineEvents.on("execution", handleExecution);

/* ═══════════════════════════════════════════════════════════════════════
   ORDER BOOK RECOVERY
   ───────────────────────────────────────────────────────────────────────
   order_id here is read straight back off existing spot_orders rows and
   forwarded to the engine as-is — no id generation happens in this path,
   so no change needed for the migration.
   ═══════════════════════════════════════════════════════════════════════ */
async function recoverOpenOrdersToEngine() {
    let rows;
    try {
        rows = await query(
            `SELECT order_id, user_id, wallet_id, symbol, side, order_type, remaining_quantity,
                    limit_price, stop_price
             FROM spot_orders
             WHERE status IN ('OPEN', 'PARTIALLY_FILLED')`
        );
    } catch (err) {
        console.error("Order book recovery: failed to load open orders from MySQL:", err);
        return;
    }

    if (!rows.length) {
        console.log("Order book recovery: no open spot orders to resubmit.");
        return;
    }

    console.log(`Order book recovery: resubmitting ${rows.length} open spot order(s) to the engine…`);

    for (const row of rows) {
        const enginePacket = {
            action: "PLACE_ORDER",
            order_id: row.order_id,
            user_id: row.user_id,
            wallet_id: row.wallet_id,
            symbol: toEnginePair(row.symbol),
            side: row.side,
            order_type: row.order_type,
            quantity: parseFloat(row.remaining_quantity),
            limit_price: row.limit_price !== null ? parseFloat(row.limit_price) : null,
            stop_price: row.stop_price !== null ? parseFloat(row.stop_price) : null,
        };

        try {
            const ack = await sendOrderToEngine(enginePacket);
            if (!ack.accepted) {
                console.error(`Order book recovery: engine rejected order_id=${row.order_id}:`, ack.errors);
            }
        } catch (err) {
            console.error(`Order book recovery: failed to resubmit order_id=${row.order_id}:`, err.message);
        }
    }
}

engineEvents.once("connected", recoverOpenOrdersToEngine);

module.exports = router;

/* ═══════════════════════════════════════════════════════════════════════
   SCHEMA

   Apply the migration that ships alongside this file (drops
   take_profit_price/stop_loss_price and spot_positions, adds stop_price,
   widens order_type to include 'OCO'). See that migration for the full
   from-scratch CREATE TABLE reference too.

   WIRE-UP (in your main server file, next to the other routers):
     const spotTradeRoutes = require("./routes/spotPanel_Route");
     app.use("/", spotTradeRoutes);

   Requires Node 18+ for the global `fetch` used in getMarketPrice().
   Requires the C++ engine (trade_engine.cpp) running and reachable.
   This file registers engineEvents listeners as a side effect of being
   required — require it exactly once per process.

   Requires Web_Sockets/marketData_ws.js to export `notifyUserTradeUpdate`
   (added alongside this file) so fills can push a 'trade_update' event to
   the placing user's browser(s) over the existing market-data WebSocket.

   ID-FORMAT MIGRATION NOTE: spot_orders.order_id, spot_trades.trade_id,
   and spot_holdings.holding_id are all app-generated PREFIX-###-AAA-###
   strings now (VARCHAR PK, no AUTO_INCREMENT) — see
   Wallets_Config/walletIdGenerator.js's ALLOWED_TARGETS whitelist, which
   already covers all three (ORD / SPT / HLD prefixes).

   HISTORY QUERY NOTE: the /api/spot/trades handler now does a UNION ALL
   across spot_trades and spot_orders so cancelled-with-zero-fills orders
   show up in trade history too. Both branches read against user_id-
   scoped, indexed columns (spot_trades.user_id, spot_orders.user_id +
   status), so this stays cheap even as history grows — no new indexes
   required beyond what these tables already need for their primary
   lookups.

   ORDER MODIFICATION NOTE (new): POST /api/spot/order/:order_id/modify
   adds "edit" support for resting LIMIT/OCO orders. It is a cancel-then-
   recreate against the engine (the engine has no atomic amend), reusing
   validateOrderRequest, lockForOrder/unlockOnCancel, and the same
   PLACE_ORDER/CANCEL_ORDER engine calls already used elsewhere in this
   file. GET /api/spot/orders now also returns `is_modifiable` per row
   (true only for OPEN LIMIT/OCO orders) so the frontend can decide when
   to render the edit icon without re-deriving that rule itself.
   ═══════════════════════════════════════════════════════════════════════ */