
const express = require('express');
const path = require('path');
const http = require('http');

// Load environment variables BEFORE importing modules
require('dotenv').config({
    path: path.join(__dirname, '.env')
});

// ---------------- Database Connections ----------------

const mongoConnection = require('./Databases/MongoDB/mongo_connection');
const mongoose = require('mongoose');
const { conn: mysqlPool } = require('./Databases/MySQL/db_connection');
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

const attachWebSocketManager = require('./Web_Sockets/ws_manager');

const {
    bootstrap: bootstrapFutures
} = require('./Futures_Engine/futuresBootstrap');

// ---------------- Application Configuration ----------------

const app = express();

const PORT = Number(process.env.PORT || 7070);
const HOST = process.env.HOST || '0.0.0.0';

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    throw new Error(`Invalid PORT value: ${process.env.PORT}`);
}

if (process.env.TRUST_PROXY) {
    app.set('trust proxy', process.env.TRUST_PROXY);
}

// ---------------- Middleware ----------------

const cookieParser = require('cookie-parser');

app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '5mb' }));

// ---------------- Static Files ----------------

app.use(
    '/uploads',
    express.static(path.join(__dirname, 'uploads'))
);

app.use(
    express.static(path.join(__dirname, 'Frontend'), {
        index: false
    })
);

// ---------------- Health Check ----------------

app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'healthy'
    });
});

// ---------------- Routes ----------------

app.use(homeRoutes);
app.use(authRoutes);
app.use(transferRoutes);
app.use(chatRoutes);

// ---------------- AI Service ----------------

const AI_SERVICE_URL = process.env.AI_SERVICE_URL
    ? process.env.AI_SERVICE_URL.replace(/\/+$/, '')
    : null;

if (AI_SERVICE_URL) {

    app.post('/api/ai-chatbot/message', async (req, res) => {

        try {

            const aiResponse = await fetch(
                `${AI_SERVICE_URL}/api/ai-chatbot/message`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(req.body || {})
                }
            );

            const responseBody = await aiResponse.text();

            res.status(aiResponse.status);

            res.type(
                aiResponse.headers.get('content-type') ||
                'application/json'
            );

            return res.send(responseBody);

        } catch (error) {

            console.error(
                '[AI proxy] AI service request failed:',
                error.message
            );

            return res.status(503).json({
                success: false,
                fallback: true,
                reply: 'Sorry, the AI assistant is temporarily unavailable. Please try again in a moment.'
            });
        }
    });

} else {

    app.use(aiChatbotRoutes);

}

// ---------------- Remaining Routes ----------------

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

app.use(commentRoutes);

app.use(mediaUploadRoutes);
app.use(mediaRoutes);

// ---------------- 404 Handler ----------------

app.use((req, res) => {

    res.status(404).json({
        success: false,
        message: 'Route not found'
    });

});

// ---------------- HTTP + WebSocket Server ----------------

const server = http.createServer(app);

attachWebSocketManager(server);

// Initialize futures listeners before accepting traffic
bootstrapFutures();

// ---------------- Startup ----------------

async function startServer() {

    try {

        console.log('Starting CORDEX backend...');

        // 1. Initialize MongoDB
        console.log('Connecting to MongoDB...');

        await mongoConnection();

        console.log('MongoDB connected successfully.');

        // 2. Initialize chat system ONCE
        console.log('Initializing chat system...');

        await RoomManager.init();

        console.log('Chat system initialized successfully.');

        // 3. Start HTTP server
        server.listen(PORT, HOST, () => {

            console.log('-----------------------------------');

            console.log(
                `CORDEX backend listening on http://${HOST}:${PORT}`
            );

            console.log(
                `AI chatbot mode: ${
                    AI_SERVICE_URL
                        ? 'separate service'
                        : 'in-process'
                }`
            );

            console.log('-----------------------------------');

        });

    } catch (error) {

        console.error('Failed to start CORDEX backend:', error);

        process.exit(1);

    }

}

// ---------------- Graceful Shutdown ----------------

function shutdown(signal) {

    console.log(
        `${signal} received. Closing CORDEX HTTP server...`
    );

    server.close(async () => {

        try {

            await mongoose.disconnect();

            mysqlPool.end(() => {
                process.exit(0);
            });

        } catch (error) {

            console.error('Error during shutdown:', error);

            process.exit(1);

        }

    });

    setTimeout(() => {
        process.exit(1);
    }, 10000).unref();

}

process.once('SIGTERM', () => shutdown('SIGTERM'));

process.once('SIGINT', () => shutdown('SIGINT'));

// ---------------- Start Application ----------------

startServer();
