/* ============================================================================
 *  routes/ws_auth.js
 * ----------------------------------------------------------------------------
 *  PHASE 11 — PART 1 (frontend wiring): issues a short-lived JWT the browser
 *  can pass as `?token=` on the WebSocket handshake (`wss://host/ws/social`).
 *  Browsers can't set custom headers on a WS upgrade request, so the normal
 *  HTTP auth (whatever verifyToken reads — cookie/header) can't be reused
 *  directly; this endpoint sits behind that same verifyToken middleware and
 *  mints a fresh, narrowly-scoped token just for the socket handshake.
 *
 *  Uses the SAME secret as the rest of the auth system (jwtSecret from
 *  db_connection.js, same as middle/middleware.js) — not a separate env
 *  var read directly, which is what caused the earlier 500.
 * ==========================================================================*/

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');

const verifyToken = require('../middle/middleware');
const { jwtSecret } = require('../Databases/MySQL/db_connection');

const WS_TOKEN_TTL = '5m'; // short-lived — only used to authenticate the socket handshake itself

router.get("/api/ws-token", verifyToken, (req, res) => {

    try {

        if (!jwtSecret) {

            return res.status(500).json({
                success: false,
                message: "JWT secret missing"
            });

        }

        const token = jwt.sign(

            {
                id: req.user.id,
                username: req.user.username
            },

            jwtSecret,

            {
                expiresIn: WS_TOKEN_TTL
            }

        );

        res.json({

            success: true,
            data: {
                token,
                username: req.user.username
            }

        });

    } catch (err) {

        console.error(err);

        res.status(500).json({
            success: false,
            message: err.message
        });

    }

});

module.exports = router;