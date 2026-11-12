const jwt = require("jsonwebtoken");
const { jwtSecret } = require("../Databases/MySQL/db_connection"); // was: process.env.JWT_SECRET — must match middleware.js
const { SOCIAL_EVENTS: EVENTS } = require("../Social_Platform/constants/events"); // PHASE 11 Part 2 — single source of truth

const WS_PATH = "/ws/social";
const HEARTBEAT_INTERVAL_MS = 30 * 1000;

const connectionsByUser = new Map();

function addConnection(username, ws) {

    if (!connectionsByUser.has(username)) {

        connectionsByUser.set(username, new Set());

    }

    connectionsByUser.get(username).add(ws);

}

function removeConnection(username, ws) {

    const set = connectionsByUser.get(username);

    if (!set) {

        return;
    }

    set.delete(ws);

    if (set.size === 0) {

        connectionsByUser.delete(username);

    }

}

function isUserOnline(username) {

    return connectionsByUser.has(username);

}

function getOnlineUsernames() {

    return [...connectionsByUser.keys()];

}

function sendToUser(username, payload) {

    const sockets = connectionsByUser.get(username);

    if (!sockets || sockets.size === 0) {

        return false;

    }

    const message = JSON.stringify(payload);

    let delivered = false;

    for (const socket of sockets) {

        if (socket.readyState === socket.OPEN) {

            socket.send(message);

            delivered = true;

        }

    }

    return delivered;

}

function broadcast(payload, excludeUsername = null) {

    const message = JSON.stringify(payload);

    for (const [username, sockets] of connectionsByUser.entries()) {

        if (username === excludeUsername) {

            continue;

        }

        for (const socket of sockets) {

            if (socket.readyState === socket.OPEN) {

                socket.send(message);

            }

        }

    }

}

function authenticateSocket(request) {

    try {

        const url = new URL(
            request.url,
            "http://localhost"
        );

        const token = url.searchParams.get("token");

        if (!token) {

            return null;

        }

        if (!jwtSecret) {

            console.error("jwtSecret is not configured (check db_connection.js / .env)");

            return null;

        }

        const decoded = jwt.verify(token, jwtSecret);

        if (!decoded || !decoded.username) {

            return null;

        }

        return decoded;

    } catch (err) {

        return null;

    }

}

function handleConnection(ws, user) {

    const username = user.username;

    ws.isAlive = true;

    ws.username = username;

    ws.on("pong", () => {

        ws.isAlive = true;

    });

    const alreadyOnline = isUserOnline(username);

    addConnection(username, ws);

    if (!alreadyOnline) {

        broadcast(

            {

                event: EVENTS.USER_ONLINE,

                data: {

                    username,

                    at: new Date().toISOString()

                }

            },

            username

        );

    }

    ws.on("message", (raw) => {

        try {

            const message = JSON.parse(raw);

            if (message?.type === "ping") {

                ws.send(

                    JSON.stringify({

                        type: "pong"

                    })

                );

            }

        } catch (err) {

            // ignore malformed messages

        }

    });

    ws.on("close", () => {

        removeConnection(username, ws);

        if (!isUserOnline(username)) {

            broadcast(

                {

                    event: EVENTS.USER_OFFLINE,

                    data: {

                        username,

                        at: new Date().toISOString()

                    }

                },

                username

            );

        }

    });

    ws.on("error", (err) => {

        console.error(

            `WebSocket error for ${username}:`,

            err.message

        );

    });

}

function initialize(wss) {

    wss.on("connection", (ws, req) => {

        const user = authenticateSocket(req);

        if (!user) {

            ws.close(1008, "Unauthorized");

            return;

        }

        handleConnection(ws, user);

    });

    const heartbeatTimer = setInterval(() => {

        wss.clients.forEach((ws) => {

            if (ws.isAlive === false) {

                ws.terminate();

                return;

            }

            ws.isAlive = false;

            ws.ping();

        });

    }, HEARTBEAT_INTERVAL_MS);

    wss.on("close", () => {

        clearInterval(heartbeatTimer);

    });

}

module.exports = {

    WS_PATH,

    EVENTS,

    initialize,

    sendToUser,

    broadcast,

    isUserOnline,

    getOnlineUsernames

};