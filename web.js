const express = require('express');
const path = require('path');
const http = require('http');

// Load deployment environment variables before importing modules that read them
// (database pools, MongoDB, trading-engine TCP clients, and the AI service).
require('dotenv').config({
    path: path.join(__dirname, '.env'),
});

const mongoConnection = require('./Social_Platform/mongo_connection');
const mongoose = require('mongoose');
const { conn: mysqlPool } = require('./db_connection');
const verifyToken = require('./middle/middleware');

// ---------------- Routes ----------------

const authRoutes = require('./routes/authRoutes');
const homeRoutes = require('./routes/homeRoutes');
const transferRoutes = require('./routes/bankingAuth');
const chatRoutes = require('./routes/chatRoom_Routes');
const aiChatbotRoutes = require('./AI_chatbot/chatbotController');
const walletRoutes = require('./routes/walletRoutes');
const socialProfile = require('./Social_Platform/profile');
const follow_Unfollow = require('./Social_Platform/follow_unfollow');
const create_Post = require('./Social_Platform/posts');
const crypto_square = require('./Social_Platform/insights');
const spotPanel = require('./routes/spotPanel_Route');
const futuresPanel = require('./routes/futuresPanel_Route');
const uploadRoutes = require('./routes/uploadRoutes');
const commentRoutes = require('./Social_Platform/Social_Routes_Utils/comments');
const mediaUploadRoutes = require('./Social_Platform/Social_Routes_Utils/upload');
const mediaRoutes = require('./Social_Platform/Social_Routes_Utils/media');
const postView = require('./Social_Platform/postView');
const notificationRoutes = require('./Social_Platform/notifications');
const wsAuthRoutes = require('./routes/ws_auth');

// ---------------- Managers ----------------

const RoomManager = require('./chat/managers/RoomManager');

// ---------------- WebSocket Manager ----------------

const attachWebSocketManager = require('./Web_Sockets/ws_manager');
const { bootstrap: bootstrapFutures } = require('./Futures_Engine/futuresBootstrap');

const app = express();
const PORT = Number.parseInt(process.env.PORT || '7070', 10);
const HOST = process.env.HOST || '0.0.0.0';

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    throw new Error(`Invalid PORT value: ${process.env.PORT}`);
}

// If TLS terminates at an Oracle/Nginx reverse proxy, set TRUST_PROXY=1
// in the container environment so Express can interpret forwarded headers.
if (process.env.TRUST_PROXY) {
    app.set('trust proxy', process.env.TRUST_PROXY);
}

// ---------------- Middleware ----------------

const cookieParser = require('cookie-parser');

app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '5mb' }));

// ---------------- Static Files ----------------

// Keep user uploads in their own persistent mount/volume.
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Serve only the actual frontend directory. Do not expose the repository root:
// it contains server code, configuration, package files, and internal modules.
app.use(express.static(path.join(__dirname, 'Frontend'), { index: false }));

// ---------------- Health Check ----------------

// Container/orchestrator liveness check. Database readiness is checked during
// startup; this endpoint intentionally does not disclose connection details.
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'healthy' });
});

// ---------------- Routes ----------------

app.use(homeRoutes);
app.use(authRoutes);
app.use(transferRoutes);
app.use(chatRoutes);

// When AI_SERVICE_URL is configured, forward the existing public chatbot
// endpoint to the separate AI container. Without it, keep the current
// in-process chatbot router so local development remains backward compatible.
const AI_SERVICE_URL = process.env.AI_SERVICE_URL
    ? process.env.AI_SERVICE_URL.replace(/\/+$/, '')
    : null;

if (AI_SERVICE_URL) {
    app.post('/api/ai-chatbot/message', async (req, res) => {
        try {
            const aiResponse = await fetch(`${AI_SERVICE_URL}/api/ai-chatbot/message`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(req.body || {}),
            });

            const responseBody = await aiResponse.text();
            res.status(aiResponse.status);
            res.type(aiResponse.headers.get('content-type') || 'application/json');
            return res.send(responseBody);
        } catch (error) {
            console.error('[AI proxy] AI service request failed:', error.message);
            return res.status(503).json({
                success: true,
                fallback: true,
                reply: "Sorry, the AI assistant is temporarily unavailable. Please try again in a moment.",
            });
        }
    });
} else {
    app.use(aiChatbotRoutes);
}

app.use(walletRoutes);
app.use(socialProfile);
app.use(follow_Unfollow);
app.use(create_Post);
app.use(crypto_square);
app.use(spotPanel);
app.use(futuresPanel);
app.use(postView);
app.use(notificationRoutes);
app.use('/api/chat', verifyToken, uploadRoutes);
app.use(wsAuthRoutes);

// comments.js already defines its own full paths, so mount it at the root.
app.use(commentRoutes);

// These routes must be registered before the 404 handler.
app.use(mediaUploadRoutes);
app.use(mediaRoutes);

// ---------------- 404 ----------------
// Keep this as the final HTTP middleware.
app.use((req, res) => {
    res.status(404).json({ success: false, message: 'Route not found' });
});

// ---------------- HTTP + WebSocket Server ----------------

const server = http.createServer(app);
attachWebSocketManager(server);

// Wire up futures live-state/persistence listeners before accepting traffic.
bootstrapFutures();

// ---------------- Startup ----------------

<<<<<<< HEAD
// ---------------- Start Server ----------------npm 

RoomManager.init()
    .then(() => {

        server.listen(port_num);
    })
    .catch((err) => {
        console.error('Failed to initialize chat system:', err);
        process.exit(1);
    });
=======
async function startServer() {
    try {
        // Do not accept application traffic until external persistence and the
        // chat-room database initialization have completed successfully.
        await mongoConnection();
        await RoomManager.init();

        server.listen(PORT, HOST, () => {
            console.log(`CORDEX backend listening on http://${HOST}:${PORT}`);
            console.log(`AI chatbot mode: ${AI_SERVICE_URL ? 'separate service' : 'in-process'}`);
        });
    } catch (error) {
        console.error('Failed to start CORDEX backend:', error);
        process.exit(1);
    }
}

// Allow Docker/Oracle to stop the process cleanly after in-flight HTTP
// requests have completed. WebSocket clients will be disconnected on shutdown.
function shutdown(signal) {
    console.log(`${signal} received. Closing CORDEX HTTP server...`);

    server.close(async () => {
        try {
            await mongoose.disconnect();
            mysqlPool.end(() => process.exit(0));
        } catch (error) {
            console.error('Error during shutdown:', error);
            process.exit(1);
        }
    });

    // Do not leave the container stuck forever if an HTTP/WebSocket client
    // never closes its connection.
    setTimeout(() => process.exit(1), 10000).unref();
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

startServer();
>>>>>>> 0c77061652e2cad406845236246dea825793926f
