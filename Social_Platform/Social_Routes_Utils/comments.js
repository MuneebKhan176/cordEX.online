/* ============================================================================
 *  Social_Platform/routes/comments.js
 * ----------------------------------------------------------------------------
 *  PHASE 11 — Comments API. Lives under routes/ next to upload.js/media.js,
 *  so it uses the same relative require depth those two use.
 *
 *    GET    /api/posts/:postId/comments          -> { comments, page, hasMore }
 *    POST   /api/posts/:postId/comments            { content } -> { comment, commentsCount }
 *    PUT    /api/comments/:commentId                { content } -> { comment }
 *    DELETE /api/comments/:commentId              -> { commentId, commentsCount }
 *    POST   /api/comments/:commentId/like         -> { liked, likesCount }  (like-only, toggles)
 *
 *    GET    /api/comments/:commentId/replies      -> { replies, page, hasMore }
 *    POST   /api/comments/:commentId/replies        { content } -> { reply, repliesCount }
 *    PUT    /api/replies/:replyId                   { content } -> { reply }
 *    DELETE /api/replies/:replyId                 -> { replyId, repliesCount }
 *    POST   /api/replies/:replyId/like            -> { liked, likesCount }  (like-only, toggles)
 *
 *  Mount alongside the other routers, e.g.:
 *      app.use(require('./Social_Platform/routes/comments'));
 * ==========================================================================*/

const express = require('express');
const router = express.Router();

const verifyToken = require('../../middle/middleware');
const commentService = require('../services/Post_Services/commentService');

function sendResponse(res, statusCode, success, message, data = null) {
    return res.status(statusCode).json({ success, message, data });
}

// Service-layer errors carry a `.status` (400/403/404/409) set via
// makeError() in commentService — anything without one is unexpected and
// gets logged + a generic 500, same convention as every other route file.
function handleServiceError(res, err, fallbackMessage) {
    if (err.status) return sendResponse(res, err.status, false, err.message);
    console.error(`⚠️ ${fallbackMessage}:`, err);
    return sendResponse(res, 500, false, fallbackMessage);
}

/* ============================================================================
 * COMMENTS
 * ==========================================================================*/
router.get('/api/posts/:postId/comments', verifyToken, async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const { comments, hasMore } = await commentService.getComments(
            req.params.postId, req.user.username, { page }
        );
        return sendResponse(res, 200, true, 'Comments fetched', { comments, page, hasMore });
    } catch (err) {
        return handleServiceError(res, err, 'Failed to load comments');
    }
});

router.post('/api/posts/:postId/comments', verifyToken, async (req, res) => {
    try {
        const { comment, commentsCount } = await commentService.createComment(
            req.params.postId, req.user.username, req.body.content
        );
        return sendResponse(res, 201, true, 'Comment posted', { comment, commentsCount });
    } catch (err) {
        return handleServiceError(res, err, 'Failed to post comment');
    }
});

router.put('/api/comments/:commentId', verifyToken, async (req, res) => {
    try {
        const comment = await commentService.editComment(
            req.params.commentId, req.user.username, req.body.content
        );
        return sendResponse(res, 200, true, 'Comment updated', { comment });
    } catch (err) {
        return handleServiceError(res, err, 'Failed to update comment');
    }
});

router.delete('/api/comments/:commentId', verifyToken, async (req, res) => {
    try {
        const result = await commentService.deleteComment(req.params.commentId, req.user.username);
        return sendResponse(res, 200, true, 'Comment deleted', result);
    } catch (err) {
        return handleServiceError(res, err, 'Failed to delete comment');
    }
});

// Like-only toggle — no dislike route exists anywhere in this file.
router.post('/api/comments/:commentId/like', verifyToken, async (req, res) => {
    try {
        const { liked, likesCount } = await commentService.toggleCommentLike(req.params.commentId, req.user.username);
        return sendResponse(res, 200, true, liked ? 'Comment liked' : 'Comment unliked', { liked, likesCount });
    } catch (err) {
        return handleServiceError(res, err, 'Failed to like/unlike comment');
    }
});

/* ============================================================================
 * REPLIES
 * ==========================================================================*/
router.get('/api/comments/:commentId/replies', verifyToken, async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const { replies, hasMore } = await commentService.getReplies(
            req.params.commentId, req.user.username, { page }
        );
        return sendResponse(res, 200, true, 'Replies fetched', { replies, page, hasMore });
    } catch (err) {
        return handleServiceError(res, err, 'Failed to load replies');
    }
});

router.post('/api/comments/:commentId/replies', verifyToken, async (req, res) => {
    try {
        const { reply, repliesCount } = await commentService.createReply(
            req.params.commentId, req.user.username, req.body.content
        );
        return sendResponse(res, 201, true, 'Reply posted', { reply, repliesCount });
    } catch (err) {
        return handleServiceError(res, err, 'Failed to post reply');
    }
});

router.put('/api/replies/:replyId', verifyToken, async (req, res) => {
    try {
        const reply = await commentService.editReply(req.params.replyId, req.user.username, req.body.content);
        return sendResponse(res, 200, true, 'Reply updated', { reply });
    } catch (err) {
        return handleServiceError(res, err, 'Failed to update reply');
    }
});

router.delete('/api/replies/:replyId', verifyToken, async (req, res) => {
    try {
        const result = await commentService.deleteReply(req.params.replyId, req.user.username);
        return sendResponse(res, 200, true, 'Reply deleted', result);
    } catch (err) {
        return handleServiceError(res, err, 'Failed to delete reply');
    }
});

// Like-only toggle — no dislike route exists anywhere in this file.
router.post('/api/replies/:replyId/like', verifyToken, async (req, res) => {
    try {
        const { liked, likesCount } = await commentService.toggleReplyLike(req.params.replyId, req.user.username);
        return sendResponse(res, 200, true, liked ? 'Reply liked' : 'Reply unliked', { liked, likesCount });
    } catch (err) {
        return handleServiceError(res, err, 'Failed to like/unlike reply');
    }
});

module.exports = router;