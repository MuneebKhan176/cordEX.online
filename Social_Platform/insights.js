const express = require('express');
const router  = express.Router();
const path    = require('path');

const verifyToken = require('../middle/middleware');
const { Post, Like } = require('../Databases/MongoDB/social_models');
const feedService = require('./services/Feed_Engine/feedService'); // PHASE 10.1 — was direct Post/ranking queries
const { enrichPosts } = require('./services/Post_Services/enrichService'); // PHASE 6
const likeHandler = require('./socket/handlers/likeHandler'); // PHASE 11 Part 1 — real-time likes

/* ============================================================================
 *  Social_Platform/insights.js  —  "Crypto Square" backend
 * ----------------------------------------------------------------------------
 *  Powers Frontend/crypto-square.html:
 *    GET  /crypto-square                 -> serves the page (auth required)
 *    GET  /api/insights/discover         -> personalized ranked feed
 *    GET  /api/insights/following        -> posts only from people you follow
 *    POST /api/insights/posts/:id/like   -> toggle like on a post
 *
 *  Reuses the existing SocialProfile / Post / Follow / Like models and the
 *  existing verifyToken auth middleware. Follow/unfollow itself is NOT
 *  duplicated here — the frontend calls the existing POST /api/follow and
 *  POST /api/unfollow endpoints already defined in Social_Platform/
 *  top-creators.js.
 *
 *  PHASE 10.1 — the discover/following query + ranking pipeline that used
 *  to live inline in these two route handlers now lives in
 *  services/feedService.js (shared with Social_Platform/posts.js, which
 *  had its own near-identical copy).
 *
 *  PHASE 6 — this file used to have its own hand-rolled enrichSquarePosts()
 *  (its own SocialProfile/Follow/Like queries, duplicating what
 *  authorService/followService/likeService already do for posts.js). It
 *  now calls the same shared services/Post_Services/enrichService.js that
 *  posts.js uses, just with the field shape Crypto Square needs
 *  (no followersCount on author, "isFollowing" instead of
 *  "isFollowingAuthor") — see enrichSquareFeed() below.
 *
 *  PHASE 10.3 — enrichSquareFeed() is passed into feedService as the
 *  `enrich` callback rather than being called here after the fact, so
 *  feedService owns the full pipeline order (rank -> recommend ->
 *  paginate -> enrich).
 *
 *  PHASE 11 (Part 1) — the like toggle below now also emits a real-time
 *  `post_liked` WebSocket event to the post's author (see
 *  socket/handlers/likeHandler.js), right after the DB write, matching
 *  the flow: Express API -> DB update -> WebSocket server -> target user.
 * ==========================================================================*/

const PAGE_SIZE = 10;

function sendResponse(res, statusCode, success, message, data = null) {
    return res.status(statusCode).json({ success, message, data });
}

/* ============================================================================
 * CRYPTO SQUARE PAGE
 * ==========================================================================*/
router.get('/crypto-square', verifyToken, (req, res) => {
    res.sendFile(path.join(__dirname, '../Frontend/Square_UI/crypto-square.html'));
});

/* ============================================================================
 * HELPERS
 * ----------------------------------------------------------------------------
 * PHASE 6 — thin wrapper around the shared enrichPosts() (see
 * services/Post_Services/enrichService.js), matching how posts.js's
 * enrichPostsForFeed() calls the same function. Crypto Square doesn't show
 * follower counts on the author chip and uses "isFollowing" as its field
 * name (vs posts.js's "isFollowingAuthor") — that's the only difference,
 * expressed here as options rather than a second hand-written enrichment
 * function.
 * ==========================================================================*/
function enrichSquareFeed(posts, myUsername) {
    return enrichPosts(posts, myUsername, {
        authorProjection: 'username displayName avatarUrl',
        includeFollowersCount: false,
        followingFieldName: 'isFollowing',
    });
}

/* ============================================================================
 * DISCOVER FEED
 * ----------------------------------------------------------------------------
 * PHASE 10.1 — ranking + pagination now happen inside
 * feedService.getDiscoverFeed(); this route only asks for a page, enriches
 * it, and returns it. The Phase 9 formula itself (friendship/interest/
 * engagement/recency) is unchanged — it just moved one layer down.
 * ==========================================================================*/
router.get('/api/insights/discover', verifyToken, async (req, res) => {

    try {
        const myUsername = req.user.username;
        const page = Math.max(1, parseInt(req.query.page) || 1);

        const { posts, hasMore } = await feedService.getDiscoverFeed(myUsername, {
            page,
            pageSize: PAGE_SIZE,
            enrich: (pagePosts) => enrichSquareFeed(pagePosts, myUsername), // PHASE 10.3
        });

        return sendResponse(res, 200, true, 'Discover feed fetched', { posts, page, hasMore });

    } catch (err) {
        console.error('⚠️ GET /api/insights/discover error:', err);
        return sendResponse(res, 500, false, 'Failed to load discover feed');
    }
});

/* ============================================================================
 * FOLLOWING FEED
 * ----------------------------------------------------------------------------
 * PHASE 10.1 — now calls feedService.getFollowingFeed() instead of running
 * Follow.find()/Post.find() inline. Behavior is unchanged (chronological,
 * no ranking).
 * ==========================================================================*/
router.get('/api/insights/following', verifyToken, async (req, res) => {

    try {
        const myUsername = req.user.username;
        const page = Math.max(1, parseInt(req.query.page) || 1);

        const { posts, hasMore } = await feedService.getFollowingFeed(myUsername, {
            page,
            pageSize: PAGE_SIZE,
            enrich: (pagePosts) => enrichSquareFeed(pagePosts, myUsername), // PHASE 10.3
        });

        return sendResponse(res, 200, true, 'Following feed fetched', { posts, page, hasMore });

    } catch (err) {
        console.error('⚠️ GET /api/insights/following error:', err);
        return sendResponse(res, 500, false, 'Failed to load following feed');
    }
});

/* ============================================================================
 * LIKE / UNLIKE (toggle)
 * ----------------------------------------------------------------------------
 * PHASE 11 (Part 1) — added likeHandler.emitPostLiked() right after each
 * DB write commits, so the post's author gets a real-time `post_liked`
 * event if they're currently connected. No-op (silently) if they're not.
 * ==========================================================================*/
router.post('/api/insights/posts/:id/like', verifyToken, async (req, res) => {

    try {
        const myUsername = req.user.username;
        const postId = req.params.id;

        const post = await Post.findById(postId);
        if (!post || post.isDeleted)
            return sendResponse(res, 404, false, 'Post not found');

        const existingLike = await Like.findOne({ username: myUsername, targetType: 'Post', targetId: postId });

        if (existingLike) {
            await Like.deleteOne({ _id: existingLike._id });
            post.likesCount = Math.max(0, post.likesCount - 1);
            await post.save();
            likeHandler.emitPostLiked({ post, actorUsername: myUsername, liked: false, likesCount: post.likesCount }); // PHASE 11 Part 1
            return sendResponse(res, 200, true, 'Post unliked', { liked: false, likesCount: post.likesCount });
        }

        try {
            await Like.create({ username: myUsername, targetType: 'Post', targetId: postId });
        } catch (dupErr) {
            if (dupErr.code === 11000)
                return sendResponse(res, 409, false, 'Already liked');
            throw dupErr;
        }

        post.likesCount += 1;
        await post.save();
        likeHandler.emitPostLiked({ post, actorUsername: myUsername, liked: true, likesCount: post.likesCount }); // PHASE 11 Part 1
        return sendResponse(res, 200, true, 'Post liked', { liked: true, likesCount: post.likesCount });

    } catch (err) {
        console.error('⚠️ POST /api/insights/posts/:id/like error:', err);
        return sendResponse(res, 500, false, 'Failed to like/unlike post');
    }
});

module.exports = router;