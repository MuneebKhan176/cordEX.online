const express = require('express');
const router = express.Router();
const path = require('path');

const verifyToken = require('../middle/middleware');
const notificationService = require('./services/Post_Services/notificationService');

function sendResponse(res, statusCode, success, message, data = null) {
    return res.status(statusCode).json({ success, message, data });
}

// PAGE
router.get('/notifications', verifyToken, (req, res) => {
    res.sendFile(path.join(__dirname, '../Frontend/Square_UI/notifications.html'));
});

// LIST (paginated, newest first)
router.get('/api/notifications', verifyToken, async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const { notifications, hasMore } = await notificationService.getNotifications(req.user.username, { page });
        return sendResponse(res, 200, true, 'Notifications fetched', { notifications, page, hasMore });
    } catch (err) {
        console.error('⚠️ GET /api/notifications error:', err);
        return sendResponse(res, 500, false, 'Failed to load notifications');
    }
});

router.get('/api/notifications/unread-count', verifyToken, async (req, res) => {
    try {
        const count = await notificationService.getUnreadCount(req.user.username);
        return sendResponse(res, 200, true, 'ok', { count });
    } catch (err) {
        console.error('⚠️ GET /api/notifications/unread-count error:', err);
        return sendResponse(res, 500, false, 'Failed to load unread count');
    }
});

router.post('/api/notifications/:id/read', verifyToken, async (req, res) => {
    try {
        await notificationService.markAsRead(req.params.id, req.user.username);
        return sendResponse(res, 200, true, 'Marked as read');
    } catch (err) {
        console.error('⚠️ POST /api/notifications/:id/read error:', err);
        return sendResponse(res, 500, false, 'Failed to mark as read');
    }
});

router.post('/api/notifications/read-all', verifyToken, async (req, res) => {
    try {
        await notificationService.markAllAsRead(req.user.username);
        return sendResponse(res, 200, true, 'All marked as read');
    } catch (err) {
        console.error('⚠️ POST /api/notifications/read-all error:', err);
        return sendResponse(res, 500, false, 'Failed to mark all as read');
    }
});

module.exports = router;