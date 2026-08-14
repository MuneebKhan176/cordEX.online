const express = require('express');
const path = require('path');
const http = require('http');

const mongoConnection = require('./Social_Platform/mongo_connection');
const verifyToken = require('./middle/middleware');

// ---------------- MongoDB ----------------

mongoConnection();

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
const crypto_square=require('./Social_Platform/insights')
const spotPanel = require('./routes/spotPanel_Route');
const futuresPanel= require('./routes/futuresPanel_Route');
const uploadRoutes = require('./routes/uploadRoutes');
const commentRoutes = require('./Social_Platform/Social_Routes_Utils/comments');
const mediaUploadRoutes = require('./Social_Platform/Social_Routes_Utils/upload');
const mediaRoutes = require('./Social_Platform/Social_Routes_Utils/media');
const postView= require('./Social_Platform/postView');
const notificationRoutes = require('./Social_Platform/notifications');

const wsAuthRoutes = require("./routes/ws_auth");

// ---------------- Managers ----------------

const RoomManager = require('./chat/managers/RoomManager');

// ---------------- WebSocket Manager ----------------

const attachWebSocketManager = require('./Web_Sockets/ws_manager');
const { bootstrap: bootstrapFutures } = require('./Futures_Engine/futuresBootstrap');

const app = express();
const port_num = 7070;

// ---------------- Middleware ----------------

const cookieParser = require('cookie-parser');

app.use(cookieParser());

app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '5mb' }));

// ---------------- Static Files ----------------

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static(path.join(__dirname), { index: false }));


// ---------------- Routes ----------------

app.use(homeRoutes);
app.use(authRoutes);
app.use(transferRoutes);
app.use(chatRoutes);
app.use(aiChatbotRoutes);
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

// FIX 1 — comments.js already defines its own full paths
// (/api/posts/:postId/comments, /api/comments/:commentId/like, etc),
// same as socialProfile/create_Post/crypto_square above. Mounting it at
// '/api/comments' was double-prefixing every route inside it
// (-> /api/comments/api/posts/.../comments, which never matches what the
// frontend calls), which is what produced the 404s / "Route not found"
// SyntaxErrors in the console.
app.use(commentRoutes);

// FIX 2 — these were previously registered AFTER the 404 catch-all, so
// Express never reached them; every /api/upload/* and /api/media/*
// request was silently falling into "Route not found" too. Moved above
// the catch-all so they're actually live.
app.use(mediaUploadRoutes);
app.use(mediaRoutes);


// ---------------- 404 ----------------
// Must be the LAST app.use() — anything registered after this point is
// unreachable, since Express stops at the first middleware that sends a
// response.
app.use((req, res) => {
    res.status(404).json({ success: false, message: 'Route not found' });
});


// ---------------- HTTP Server ----------------

const server = http.createServer(app);

// Attach ALL websocket gateways
attachWebSocketManager(server);


// Wire up the futures engine's live-state + persistence listeners.
// Must happen before the server starts accepting traffic, since a
// client could open /ws/futures-data (or the C++ engine could push a
// MARK_PRICE_UPDATE-triggered event) the instant listen() resolves.
bootstrapFutures();


// ---------------- Start Server ----------------

RoomManager.init()
    .then(() => {

        server.listen(port_num);

    })
    .catch((err) => {

        console.error('Failed to initialize chat system:', err);

        process.exit(1);

    });