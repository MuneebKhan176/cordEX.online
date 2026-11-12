const express = require('express');
const router = express.Router();
const path = require('path');

const verifyToken = require('../middle/middleware');
const { Post } = require('../Databases/MongoDB/social_models');
const { enrichPosts } = require('./services/Post_Services/enrichService');

function sendResponse(res, statusCode, success, message, data = null) {
    return res.status(statusCode).json({ success, message, data });
}

// PAGE — full single-post view with comments (Frontend/Square_UI/post.html)
router.get('/post/:id', verifyToken, (req, res) => {
    res.sendFile(path.join(__dirname, '../Frontend/Square_UI/post.html'));
});

// SINGLE POST DATA — named /single to avoid colliding with the existing
// DELETE /api/posts/:id in profile.js
router.get('/api/posts/:id/single', verifyToken, async (req, res) => {
    try {
        const myUsername = req.user.username;
        const post = await Post.findOne({ _id: req.params.id, isDeleted: false }).lean();
        if (!post) return sendResponse(res, 404, false, 'Post not found');

        const [enriched] = await enrichPosts([post], myUsername, {
            authorProjection: 'username displayName avatarUrl followersCount',
            includeFollowersCount: true,
            followingFieldName: 'isFollowingAuthor',
        });

        return sendResponse(res, 200, true, 'Post fetched', { post: enriched });
    } catch (err) {
        console.error('⚠️ GET /api/posts/:id/single error:', err);
        return sendResponse(res, 500, false, 'Failed to load post');
    }
});

module.exports = router;