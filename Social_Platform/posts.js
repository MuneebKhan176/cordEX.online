const express  = require('express');
const router   = express.Router();
const path     = require('path');

const verifyToken = require('../middle/middleware');
const { Post, Like, Hashtag, SENTIMENT_TYPES } = require('../Databases/MongoDB/social_models');
const feedService = require('./services/Feed_Engine/feedService'); // PHASE 10.1 — was direct Post/ranking queries
const { enrichPosts } = require('./services/Post_Services/enrichService');
const bookmarkService = require('./services/Post_Services/bookmarkService'); // PHASE 12
const likeHandler = require('./socket/handlers/likeHandler'); // PHASE 11 Part 1 — real-time likes
const postHandler = require('./socket/handlers/postHandler'); // PHASE 11 Part 2 — new-post fan-out to followers

// The five independent post-creation side effects, each in its own service.
const { increasePostCount } = require('./services/Post_Services/postStatsService');
const { createNotifications } = require('./services/Post_Services/notificationService');
const { updateTrending } = require('./services/Feed_Engine/trendingCreators');
const { updateRecommendations } = require('./services/Feed_Engine/recommendationService');

const PAGE_SIZE = 5;
const MAX_HASHTAGS_PER_POST = 10;
const MAX_IMAGES_PER_POST = 4;
const MAX_VIDEOS_PER_POST = 1; // PHASE 8 — down from 2

function sendResponse(res, statusCode, success, message, data = null) {
    return res.status(statusCode).json({ success, message, data });
}

function handleServiceError(res, err, fallbackMessage) {
    if (err.status) return sendResponse(res, err.status, false, err.message);
    console.error(`⚠️ ${fallbackMessage}:`, err);
    return sendResponse(res, 500, false, fallbackMessage);
}

function enrichPostsForFeed(posts, myUsername) {
    return enrichPosts(posts, myUsername, {
        authorProjection: 'username displayName avatarUrl followersCount',
        includeFollowersCount: true,
        followingFieldName: 'isFollowingAuthor',
    });
}

function parseSentiment(raw) {
    const val = String(raw || '').trim().toLowerCase();
    return SENTIMENT_TYPES.includes(val) ? val : null;
}

function parseHashtags(raw) {
    if (!raw) return [];
    const tags = String(raw)
        .split(/[\s,]+/)
        .map(t => t.replace(/^#/, '').trim().toLowerCase())
        .filter(t => t.length > 0 && t.length <= 30 && /^[a-z0-9_]+$/i.test(t));
    return [...new Set(tags)].slice(0, MAX_HASHTAGS_PER_POST);
}

async function registerHashtags(tags) {
    if (!tags.length) return;
    const ops = tags.map(tag => ({
        updateOne: {
            filter: { tag },
            update: {
                $inc: { postsCount: 1, trendScore: 1 },
                $set: { lastUsedAt: new Date() },
                $setOnInsert: { tag },
            },
            upsert: true,
        },
    }));
    await Hashtag.bulkWrite(ops, { ordered: false }).catch(err =>
        console.error('⚠️ registerHashtags bulkWrite error:', err)
    );
}

const ALLOWED_MEDIA_FIELDS = new Set([
    'url', 'thumbUrl', 'type', 'width', 'height', 'order',
    'thumbnailUrl', 'compressedUrl', 'blurHash', 'aspectRatio',
    'duration', 'quality', 'video480p', 'video720p',
]);

function cleanMediaArray(rawMedia) {
    if (!Array.isArray(rawMedia)) return [];
    return rawMedia
        .filter(m => m && typeof m.url === 'string' && ['image', 'video'].includes(m.type))
        .map((m, i) => {
            const clean = { order: i };
            for (const key of ALLOWED_MEDIA_FIELDS) {
                if (m[key] !== undefined) clean[key] = m[key];
            }
            return clean;
        });
}

router.get('/create-post', verifyToken, (req, res) => {
    res.sendFile(path.join(__dirname, '../Frontend/Square_UI/create-post.html'));
});

/* ============================================================================
 * CREATE POST
 * ----------------------------------------------------------------------------
 * PHASE 11 Part 2 — added postHandler.emitNewPostToFollowers() as a sixth
 * parallel branch in the fan-out. It's a live-only "new_post" ping to
 * followers (see notificationService.notifyNewPostToFollowers) — NOT a
 * persisted Notification row, same "don't flood the bell with one row per
 * follower per post" reasoning notificationService.js already documents.
 *
 *      Post created
 *        ↓
 *   ┌────┼────┬────┬────┬────┐
 *   ↓    ↓    ↓    ↓    ↓    ↓
 * Stats Tags Notify Trend Recs Fanout
 *   └────┼────┴────┴────┴────┘
 *        ↓
 *     Response
 * ==========================================================================*/
router.post('/api/posts', verifyToken, async (req, res) => {

    try {
        const myUsername = req.user.username;
        const title   = (req.body.title || '').trim();
        const content = (req.body.content || '').trim();

        if (!content)
            return sendResponse(res, 400, false, 'Post content is required');
        if (title.length > 100)
            return sendResponse(res, 400, false, 'Title must be 100 characters or fewer');

        const bodyWithTitle = title ? `## ${title}\n${content}` : content;

        if (bodyWithTitle.length > 2000)
            return sendResponse(res, 400, false, 'Post is too long (max 2000 characters, including the title line)');

        const sentiment = parseSentiment(req.body.sentiment);
        const hashtags  = parseHashtags(req.body.hashtags);
        const media     = cleanMediaArray(req.body.media);

        const imageCount = media.filter(m => m.type === 'image').length;
        if (imageCount > MAX_IMAGES_PER_POST)
            return sendResponse(res, 400, false, `Maximum ${MAX_IMAGES_PER_POST} images per post`);

        const videoCount = media.filter(m => m.type === 'video').length;
        if (videoCount > MAX_VIDEOS_PER_POST)
            return sendResponse(res, 400, false, `Only ${MAX_VIDEOS_PER_POST} video is allowed per post`);

        const unreadyVideo = media.find(m => m.type === 'video' && m.quality !== 'ready');
        if (unreadyVideo)
            return sendResponse(res, 400, false, 'Video is still processing — wait for it to finish before posting');

        const newPost = await Post.create({
            username: myUsername,
            content: bodyWithTitle,
            media,
            sentiment,
            hashtags,
        });

        await Promise.all([
            increasePostCount(myUsername)
                .then(() => updateTrending(myUsername))
                .catch(err => console.error('⚠️ POST /api/posts stats/trending branch error:', err)),

            registerHashtags(hashtags)
                .catch(err => console.error('⚠️ POST /api/posts tags branch error:', err)),

            createNotifications({ post: newPost, authorUsername: myUsername })
                .catch(err => console.error('⚠️ POST /api/posts notify branch error:', err)),

            updateRecommendations(hashtags)
                .catch(err => console.error('⚠️ POST /api/posts recommendations branch error:', err)),

            Promise.resolve(postHandler.emitNewPostToFollowers({ post: newPost, authorUsername: myUsername })) // PHASE 11 Part 2
                .catch(err => console.error('⚠️ POST /api/posts fanout branch error:', err)),
        ]);

        return sendResponse(res, 201, true, 'Post created successfully', { post: newPost });

    } catch (err) {
        console.error('⚠️ POST /api/posts error:', err);
        return sendResponse(res, 500, false, err.message || 'Failed to create post');
    }
});

router.get('/api/posts/discover', verifyToken, async (req, res) => {

    try {
        const myUsername = req.user.username;
        const hashtag = req.query.hashtag
            ? String(req.query.hashtag).toLowerCase().replace(/^#/, '')
            : null;
        const enrich = (pagePosts) => enrichPostsForFeed(pagePosts, myUsername);

        if (req.query.after) {
            const afterDate = new Date(req.query.after);
            const posts = await feedService.getDiscoverFeedAfter(afterDate, { limit: 20, hashtag, myUsername, enrich });
            return sendResponse(res, 200, true, 'Newer discover posts fetched', { posts });
        }

        const page = Math.max(1, parseInt(req.query.page) || 1);
        const { posts, hasMore } = await feedService.getDiscoverFeed(myUsername, { page, pageSize: PAGE_SIZE, hashtag, enrich });

        return sendResponse(res, 200, true, 'Discover feed fetched', { posts, page, hasMore });

    } catch (err) {
        console.error('⚠️ GET /api/posts/discover error:', err);
        return sendResponse(res, 500, false, 'Failed to load discover feed');
    }
});

router.get('/api/posts/following', verifyToken, async (req, res) => {

    try {
        const myUsername = req.user.username;
        const enrich = (pagePosts) => enrichPostsForFeed(pagePosts, myUsername);

        if (req.query.after) {
            const afterDate = new Date(req.query.after);
            const posts = await feedService.getFollowingFeedAfter(myUsername, afterDate, { limit: 20, enrich });
            return sendResponse(res, 200, true, 'Newer following posts fetched', { posts });
        }

        const page = Math.max(1, parseInt(req.query.page) || 1);
        const { posts, hasMore } = await feedService.getFollowingFeed(myUsername, { page, pageSize: PAGE_SIZE, enrich });

        return sendResponse(res, 200, true, 'Following feed fetched', { posts, page, hasMore });

    } catch (err) {
        console.error('⚠️ GET /api/posts/following error:', err);
        return sendResponse(res, 500, false, 'Failed to load following feed');
    }
});

router.get('/api/posts/bookmarks', verifyToken, async (req, res) => {

    try {
        const myUsername = req.user.username;
        const page = Math.max(1, parseInt(req.query.page) || 1);

        const { posts: rawPosts, hasMore } = await bookmarkService.getBookmarkedFeed(myUsername, { page, pageSize: PAGE_SIZE });
        const posts = await enrichPostsForFeed(rawPosts, myUsername);

        return sendResponse(res, 200, true, 'Bookmarks fetched', { posts, page, hasMore });

    } catch (err) {
        console.error('⚠️ GET /api/posts/bookmarks error:', err);
        return sendResponse(res, 500, false, 'Failed to load bookmarks');
    }
});

router.post('/api/posts/:id/bookmark', verifyToken, async (req, res) => {

    try {
        const { bookmarked, saveCount } = await bookmarkService.toggleBookmark(req.params.id, req.user.username);
        return sendResponse(res, 200, true, bookmarked ? 'Post bookmarked' : 'Post unbookmarked', { bookmarked, saveCount });

    } catch (err) {
        return handleServiceError(res, err, 'Failed to bookmark/unbookmark post');
    }
});

router.get('/api/posts/new-count', verifyToken, async (req, res) => {

    try {
        const { feed, since } = req.query;
        if (!since) return sendResponse(res, 400, false, 'since is required');

        const sinceDate = new Date(since);
        if (isNaN(sinceDate.getTime())) return sendResponse(res, 400, false, 'Invalid since timestamp');

        const count = await feedService.getNewPostsCount({ since: sinceDate, feed, myUsername: req.user.username });
        return sendResponse(res, 200, true, 'ok', { count });

    } catch (err) {
        console.error('⚠️ GET /api/posts/new-count error:', err);
        return sendResponse(res, 500, false, 'Failed to check for new posts');
    }
});

router.post('/api/posts/:id/like', verifyToken, async (req, res) => {

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
            likeHandler.emitPostLiked({ post, actorUsername: myUsername, liked: false, likesCount: post.likesCount });
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
        likeHandler.emitPostLiked({ post, actorUsername: myUsername, liked: true, likesCount: post.likesCount });
        return sendResponse(res, 200, true, 'Post liked', { liked: true, likesCount: post.likesCount });

    } catch (err) {
        console.error('⚠️ POST /api/posts/:id/like error:', err);
        return sendResponse(res, 500, false, 'Failed to like/unlike post');
    }
});

router.post('/api/posts/:id/view', verifyToken, async (req, res) => {

    try {
        const postId = req.params.id;
        const post = await Post.findOneAndUpdate(
            { _id: postId, isDeleted: false },
            { $inc: { viewsCount: 1 } },
            { new: true, projection: { viewsCount: 1, hashtags: 1 } }
        );

        if (!post)
            return sendResponse(res, 404, false, 'Post not found');

        const { trackActivity } = require('./services/Feed_Engine/interestTracker');
        ['crypto', 'btc', 'eth'].forEach(tag => {
            if (post.hashtags?.includes(tag)) {
                trackActivity({
                    username: req.user.username,
                    activityType: `view_${tag}`,
                    post,
                    targetType: 'Post',
                    targetId: post._id,
                }).catch(() => {});
            }
        });

        return sendResponse(res, 200, true, 'View registered', { viewsCount: post.viewsCount });

    } catch (err) {
        console.error('⚠️ POST /api/posts/:id/view error:', err);
        return sendResponse(res, 500, false, 'Failed to register view');
    }
});

router.post('/api/posts/:id/activity', verifyToken, async (req, res) => {

    try {
        const myUsername = req.user.username;
        const { activityType } = req.body;
        const { trackActivity, TRACKABLE_ACTIVITY_TYPES } = require('./services/Feed_Engine/interestTracker');

        if (!TRACKABLE_ACTIVITY_TYPES.includes(activityType))
            return sendResponse(res, 400, false, 'Unsupported activity type');

        const post = await Post.findOne({ _id: req.params.id, isDeleted: false })
            .select('hashtags username')
            .lean();

        if (!post)
            return sendResponse(res, 404, false, 'Post not found');

        await trackActivity({
            username: myUsername,
            activityType,
            post,
            targetType: 'Post',
            targetId: post._id,
            metadata: activityType === 'open_profile' ? { authorUsername: post.username } : {},
        });

        return sendResponse(res, 200, true, 'Activity recorded');

    } catch (err) {
        console.error('⚠️ POST /api/posts/:id/activity error:', err);
        return sendResponse(res, 500, false, 'Failed to record activity');
    }
});

module.exports = router;