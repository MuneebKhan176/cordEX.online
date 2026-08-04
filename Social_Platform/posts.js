const express  = require('express');
const router   = express.Router();
const path     = require('path');
const multer   = require('multer');

const verifyToken = require('../middle/middleware');
const { SocialProfile, Post, Follow, Like, Hashtag, SENTIMENT_TYPES } = require('./social_models');
const { uploadPostMedia } = require('../chat/services/uploadService');
const { calculateScore } = require('./services/feedScore');
const { trackActivity, getInterestMap, TRACKABLE_ACTIVITY_TYPES } = require('./services/interestTracker');
const { getManyProfiles } = require('./cache/profileCache');
const { enrichPosts } = require('./services/Post_Services/enrichService'); // PHASE 6

// PHASE 7 — the five independent post-creation side effects, each in its
// own service. See the Promise.all block inside POST /api/posts below.
const { increasePostCount } = require('./services/postStatsService');
const { createNotifications } = require('./services/notificationService');
const { updateTrending } = require('./services/trendingCreators');
const { updateRecommendations } = require('./services/recommendationService');

const PAGE_SIZE = 5;
const MAX_HASHTAGS_PER_POST = 10;

function sendResponse(res, statusCode, success, message, data = null) {
    return res.status(statusCode).json({ success, message, data });
}

/* ============================================================================
 * MEDIA UPLOAD (multer, in-memory — CHANGED from disk storage)
 * ----------------------------------------------------------------------------
 * Files are held in memory just long enough to validate/resize/thumbnail
 * them via uploadPostMedia() and push them to Cloudflare R2 — nothing is
 * ever written to local disk anymore. Post.media[].url and .thumbUrl now
 * store R2 CDN URLs (posts/{username}/{id}.jpg + _thumb.jpg), same pattern
 * already used for avatars and chat attachments.
 * ==========================================================================*/

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024, files: 6 }, // 20MB per file, 6 files max total
    fileFilter: (req, file, cb) => {
        if (file.fieldname === 'images' && !file.mimetype.startsWith('image/'))
            return cb(new Error('Only image files are allowed in the photos field'));
        if (file.fieldname === 'videos' && !file.mimetype.startsWith('video/'))
            return cb(new Error('Only video files are allowed in the videos field'));
        cb(null, true);
    },
});

/* ============================================================================
 * HELPERS
 * ----------------------------------------------------------------------------
 * PHASE 6 — enrichPosts() used to live here as a monolithic function doing
 * three separate lookups (authors/likes/follows) inline. That logic now
 * lives in services/enrichService.js, which delegates each concern to its
 * own service (authorService / likeService / followService) and merges the
 * results. Here we just call it with this router's field-naming needs:
 * followersCount on the author object + "isFollowingAuthor" flag.
 * ==========================================================================*/
function enrichPostsForFeed(posts, myUsername) {
    return enrichPosts(posts, myUsername, {
        authorProjection: 'username displayName avatarUrl followersCount',
        includeFollowersCount: true,
        followingFieldName: 'isFollowingAuthor',
    });
}

// Normalizes the raw "sentiment" field from the composer into either
// "bullish", "bearish", or null (anything else is silently dropped).
function parseSentiment(raw) {
    const val = String(raw || '').trim().toLowerCase();
    return SENTIMENT_TYPES.includes(val) ? val : null;
}

// Splits a free-typed hashtag string ("#btc, eth  #trading") into a clean,
// deduplicated, lowercase array with no leading '#' — capped so one post
// can't spam hundreds of tags.
function parseHashtags(raw) {
    if (!raw) return [];
    const tags = String(raw)
        .split(/[\s,]+/)
        .map(t => t.replace(/^#/, '').trim().toLowerCase())
        .filter(t => t.length > 0 && t.length <= 30 && /^[a-z0-9_]+$/i.test(t));
    return [...new Set(tags)].slice(0, MAX_HASHTAGS_PER_POST);
}

// Upserts the Hashtag registry (postsCount / trendScore / lastUsedAt) for
// every tag used on a new post.
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

/* ============================================================================
 * CREATE POST PAGE
 * ==========================================================================*/
router.get('/create-post', verifyToken, (req, res) => {
    res.sendFile(path.join(__dirname, '../Frontend/Square_UI/create-post.html'));
});

/* ============================================================================
 * CREATE POST — media uploaded to R2 instead of local disk
 * ----------------------------------------------------------------------------
 * PHASE 7 — post-creation side effects fan out in parallel instead of the
 * old two-item Promise.all:
 *
 *      Upload
 *        ↓
 *   ┌────┼────┬────┬────┐
 *   ↓    ↓    ↓    ↓    ↓
 * Stats Tags Notify Trend Recs
 *   └────┼────┴────┴────┘
 *        ↓
 *     Response
 *
 * Stats  -> increasePostCount()      (services/postStatsService.js)
 * Tags   -> registerHashtags()       (this file, unchanged)
 * Notify -> createNotifications()    (services/notificationService.js)
 * Trend  -> updateTrending()         (services/trendingCreators.js)
 * Recs   -> updateRecommendations()  (services/recommendationService.js)
 *
 * Trend depends on Stats having landed first (it reads the just-updated
 * postsCount back out of SocialProfile to compute the new score), so those
 * two are chained with .then() — everything else has no dependency on any
 * other branch and runs fully in parallel with that chain.
 * ==========================================================================*/
router.post('/api/posts', verifyToken, upload.fields([
    { name: 'images', maxCount: 4 },
    { name: 'videos', maxCount: 2 },
]), async (req, res) => {

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

        const imageFiles = req.files?.images || [];
        const videoFiles = req.files?.videos || [];

        // Upload every image/video to R2 in parallel via uploadPostMedia()
        // (validates size/type, builds a 1600px display version + 480px
        // thumbnail + LQIP for images, stores raw for video).
        const media = [];
        try {
            const uploadedImages = await Promise.all(
                imageFiles.map(f =>
                    uploadPostMedia({
                        buffer: f.buffer,
                        mimetype: f.mimetype,
                        originalName: f.originalname,
                        username: myUsername,
                    })
                )
            );
            uploadedImages.forEach((u, i) => media.push({
                url: u.url,
                thumbUrl: u.thumbUrl,
                type: 'image',
                width: u.width,
                height: u.height,
                order: i,
            }));

            const uploadedVideos = await Promise.all(
                videoFiles.map(f =>
                    uploadPostMedia({
                        buffer: f.buffer,
                        mimetype: f.mimetype,
                        originalName: f.originalname,
                        username: myUsername,
                    })
                )
            );
            uploadedVideos.forEach((u, i) => media.push({
                url: u.url,
                thumbUrl: null,
                type: 'video',
                width: null,
                height: null,
                order: media.length + i,
            }));
        } catch (uploadErr) {
            const status = uploadErr.code === 'TOO_LARGE' || uploadErr.code === 'UNSUPPORTED_TYPE' ? 400 : 500;
            console.error('⚠️ POST /api/posts media upload error:', uploadErr);
            return sendResponse(res, status, false, uploadErr.message || 'Failed to upload media');
        }

        const newPost = await Post.create({
            username: myUsername,
            content: bodyWithTitle,
            media,
            sentiment,
            hashtags,
        });

        // PHASE 7 — fan out the five post-creation side effects. Each is
        // wrapped in its own .catch() so one branch failing (e.g. a bad
        // mention lookup) never fails the whole post creation — the post
        // itself is already committed above by this point.
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
        ]);

        return sendResponse(res, 201, true, 'Post created successfully', { post: newPost });

    } catch (err) {
        console.error('⚠️ POST /api/posts error:', err);
        const isUploadError = err.message && /allowed|File too large|Unexpected field/i.test(err.message);
        return sendResponse(res, isUploadError ? 400 : 500, false, err.message || 'Failed to create post');
    }
});

/* ============================================================================
 * DISCOVER FEED
 * ----------------------------------------------------------------------------
 * Ranking goes through the shared calculateScore() helper (see
 * services/feedScore.js). We pull the candidate posts + their authors'
 * followersCount, score each post in application code, then sort/paginate
 * over that in-memory list.
 *
 * PHASE 3 — personalized via the viewer's interest profile (see
 * services/interestTracker.js).
 *
 * PHASE 4 — author followersCount for scoring comes from the shared profile
 * cache (via authorService, PHASE 6) instead of its own SocialProfile.find().
 * ==========================================================================*/
router.get('/api/posts/discover', verifyToken, async (req, res) => {

    try {
        const myUsername = req.user.username;
        const baseMatch = { isDeleted: false };

        if (req.query.hashtag) {
            baseMatch.hashtags = String(req.query.hashtag).toLowerCase().replace(/^#/, '');
        }

        if (req.query.after) {
            const afterDate = new Date(req.query.after);
            const posts = await Post.aggregate([
                { $match: { ...baseMatch, createdAt: { $gt: afterDate } } },
                { $sort: { createdAt: -1 } },
                { $limit: 20 },
            ]);
            const enriched = await enrichPostsForFeed(posts, myUsername);
            return sendResponse(res, 200, true, 'Newer discover posts fetched', { posts: enriched });
        }

        const page = Math.max(1, parseInt(req.query.page) || 1);
        const skip = (page - 1) * PAGE_SIZE;

        const candidatePosts = await Post.find(baseMatch).lean();

        const usernames = [...new Set(candidatePosts.map(p => p.username))];
        const [authorMap, interestMap] = await Promise.all([
            getManyProfiles(usernames, SocialProfile, 'username followersCount'),
            getInterestMap(myUsername),
        ]);

        const ranked = candidatePosts
            .map(post => ({ post, score: calculateScore(post, authorMap.get(post.username), interestMap) }))
            .sort((a, b) => b.score - a.score || String(b.post._id).localeCompare(String(a.post._id)));

        const posts = ranked.slice(skip, skip + PAGE_SIZE).map(r => r.post);

        const enriched = await enrichPostsForFeed(posts, myUsername);
        const hasMore = skip + PAGE_SIZE < ranked.length;

        return sendResponse(res, 200, true, 'Discover feed fetched', { posts: enriched, page, hasMore });

    } catch (err) {
        console.error('⚠️ GET /api/posts/discover error:', err);
        return sendResponse(res, 500, false, 'Failed to load discover feed');
    }
});

/* ============================================================================
 * FOLLOWING FEED — unchanged from Phase 6
 * ==========================================================================*/
router.get('/api/posts/following', verifyToken, async (req, res) => {

    try {
        const myUsername = req.user.username;

        const myFollows = await Follow.find({ followerUsername: myUsername }).select('followingUsername').lean();
        const followingUsernames = myFollows.map(f => f.followingUsername);

        if (!followingUsernames.length) {
            return sendResponse(res, 200, true, 'Following feed fetched', { posts: [], page: 1, hasMore: false });
        }

        const baseMatch = { isDeleted: false, username: { $in: followingUsernames } };

        if (req.query.after) {
            const afterDate = new Date(req.query.after);
            const posts = await Post.find({ ...baseMatch, createdAt: { $gt: afterDate } })
                .sort({ createdAt: -1 })
                .limit(20)
                .lean();
            const enriched = await enrichPostsForFeed(posts, myUsername);
            return sendResponse(res, 200, true, 'Newer following posts fetched', { posts: enriched });
        }

        const page = Math.max(1, parseInt(req.query.page) || 1);
        const skip = (page - 1) * PAGE_SIZE;

        const posts = await Post.find(baseMatch)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(PAGE_SIZE)
            .lean();

        const enriched = await enrichPostsForFeed(posts, myUsername);
        const hasMore = posts.length === PAGE_SIZE;

        return sendResponse(res, 200, true, 'Following feed fetched', { posts: enriched, page, hasMore });

    } catch (err) {
        console.error('⚠️ GET /api/posts/following error:', err);
        return sendResponse(res, 500, false, 'Failed to load following feed');
    }
});

/* ============================================================================
 * NEW-POSTS COUNT — unchanged from Phase 6
 * ==========================================================================*/
router.get('/api/posts/new-count', verifyToken, async (req, res) => {

    try {
        const { feed, since } = req.query;
        if (!since) return sendResponse(res, 400, false, 'since is required');

        const sinceDate = new Date(since);
        if (isNaN(sinceDate.getTime())) return sendResponse(res, 400, false, 'Invalid since timestamp');

        const match = { isDeleted: false, createdAt: { $gt: sinceDate } };

        if (feed === 'following') {
            const myUsername = req.user.username;
            const myFollows = await Follow.find({ followerUsername: myUsername }).select('followingUsername').lean();
            const usernames = myFollows.map(f => f.followingUsername);
            if (!usernames.length) return sendResponse(res, 200, true, 'ok', { count: 0 });
            match.username = { $in: usernames };
        }

        const count = await Post.countDocuments(match);
        return sendResponse(res, 200, true, 'ok', { count });

    } catch (err) {
        console.error('⚠️ GET /api/posts/new-count error:', err);
        return sendResponse(res, 500, false, 'Failed to check for new posts');
    }
});

/* ============================================================================
 * LIKE / UNLIKE (toggle) — unchanged from Phase 6
 * ==========================================================================*/
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
        return sendResponse(res, 200, true, 'Post liked', { liked: true, likesCount: post.likesCount });

    } catch (err) {
        console.error('⚠️ POST /api/posts/:id/like error:', err);
        return sendResponse(res, 500, false, 'Failed to like/unlike post');
    }
});

/* ============================================================================
 * REGISTER A VIEW
 * ----------------------------------------------------------------------------
 * PHASE 3 — besides bumping viewsCount, this is also where view_crypto /
 * view_btc / view_eth activity gets logged: if the viewed post carries one
 * of those hashtags, trackActivity() bumps the viewer's UserInterest score
 * for it. Fire-and-forget (doesn't block or affect the response) so a slow
 * activity write never delays the view counter itself.
 * ==========================================================================*/
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

/* ============================================================================
 * TRACK ENGAGEMENT ACTIVITY (Phase 3) — unchanged from Phase 6
 * ----------------------------------------------------------------------------
 * Generic hook the frontend calls for activity types that aren't implied by
 * an existing action:
 *   watch_video   -> fired when a viewer actually plays a video on a post
 *   open_profile  -> fired when a viewer taps into a post's author
 * Both feed into the viewer's UserInterest profile via the post's hashtags
 * (see services/interestTracker.js), same as the view_crypto/btc/eth
 * tracking above.
 * ==========================================================================*/
router.post('/api/posts/:id/activity', verifyToken, async (req, res) => {

    try {
        const myUsername = req.user.username;
        const { activityType } = req.body;

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

/* ============================================================================
 * MULTER ERROR HANDLER (router-level) — unchanged from Phase 6
 * ==========================================================================*/
router.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        return sendResponse(res, 400, false, `Upload error: ${err.message}`);
    }
    if (err) {
        return sendResponse(res, 400, false, err.message || 'Upload failed');
    }
    next();
});

module.exports = router;