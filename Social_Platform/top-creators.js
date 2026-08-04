const express = require('express');
const router = express.Router();
const path = require('path');

const verifyToken = require('../middle/middleware');
const { SocialProfile, Follow } = require('./social_models');
const { syncTrendingCreator } = require('./services/trendingCreators');
const { getManyProfiles, patchCached, invalidate } = require('./cache/profileCache');

// NOTE: SocialProfile is still required for both models AND the
// TrendingCreator model, imported directly below since it's a separate
// export from social_models.
const { TrendingCreator } = require('./social_models');

function sendResponse(res, statusCode, success, message, data = null) {
    return res.status(statusCode).json({ success, message, data });
}

const TOP_CREATORS_LIMIT = 10;

/* ============================================================================
 * PHASE 5 — REMOVED: quickselect over every SocialProfile in the database.
 * ----------------------------------------------------------------------------
 * The old approach pulled `SocialProfile.find({})` on every request and ran
 * quickselect to get the top 10 by followersCount. That's fine at ~1,000
 * users but becomes an O(n) full-collection scan + partition pass per
 * request at 100,000+ users.
 *
 * Instead, a precomputed TrendingCreator leaderboard (username,
 * followersCount, score) is kept in sync by services/trendingCreators.js
 * every time someone follows, unfollows, or posts. This endpoint now just
 * does TrendingCreator.find().sort({score:-1}).limit(10) — an index scan
 * that costs the same whether there are 1,000 or 1,000,000 users.
 * ==========================================================================*/

// ================= TOP CREATORS PAGE =================
// Serves the standalone top-creators.html page (Frontend/Square_UI/top-creators.html).
router.get('/top-creators', verifyToken, (req, res) => {
    res.sendFile(path.join(__dirname, '../Frontend/Square_UI/top-creators.html'));
});

// ================= GET TOP 10 CREATORS (from the TrendingCreator leaderboard) =================
router.get('/api/top-creators', verifyToken, async (req, res) => {

    try {
        const myUsername = req.user.username;

        const leaders = await TrendingCreator.find({})
            .sort({ score: -1 })
            .limit(TOP_CREATORS_LIMIT)
            .lean();

        if (!leaders.length) {
            return sendResponse(res, 200, true, 'Top creators fetched successfully', { creators: [] });
        }

        const usernames = leaders.map(l => l.username);

        // PHASE 4 — profile display fields (displayName/avatarUrl/bio/etc)
        // come from the shared in-memory cache instead of a fresh
        // SocialProfile.find() on every request.
        const [profileMap, myFollows] = await Promise.all([
            getManyProfiles(usernames, SocialProfile),
            Follow.find({ followerUsername: myUsername }).select('followingUsername').lean(),
        ]);

        const followingSet = new Set(myFollows.map(f => f.followingUsername));

        const creators = leaders.map((leader, index) => {
            const p = profileMap.get(leader.username) || {};
            return {
                rank: index + 1,
                userId: p.userId,
                username: leader.username,
                displayName: p.displayName || leader.username,
                avatarUrl: p.avatarUrl || '',
                bio: p.bio || '',
                // followersCount comes off the leaderboard row first (it's
                // the field that drives ranking) and falls back to the
                // profile cache if for some reason it's missing there.
                followersCount: leader.followersCount ?? p.followersCount ?? 0,
                followingCount: p.followingCount || 0,
                postsCount: p.postsCount || 0,
                isFollowing: followingSet.has(leader.username),
                isSelf: leader.username === myUsername,
            };
        });

        return sendResponse(res, 200, true, 'Top creators fetched successfully', { creators });

    } catch (err) {
        console.error('⚠️ GET /api/top-creators error:', err);
        return sendResponse(res, 500, false, 'Failed to load top creators');
    }
});

// ================= FOLLOW A USER =================
router.post('/api/follow', verifyToken, async (req, res) => {

    try {
        const myUsername = req.user.username;
        const targetUsername = req.body.username?.trim();

        if (!targetUsername)
            return sendResponse(res, 400, false, 'Target username is required');

        if (targetUsername === myUsername)
            return sendResponse(res, 400, false, 'You cannot follow yourself');

        const targetProfile = await SocialProfile.findOne({ username: targetUsername });
        if (!targetProfile)
            return sendResponse(res, 404, false, 'User to follow was not found');

        try {
            await Follow.create({ followerUsername: myUsername, followingUsername: targetUsername });
        } catch (dupErr) {
            // Unique compound index on (followerUsername, followingUsername)
            if (dupErr.code === 11000)
                return sendResponse(res, 409, false, 'You are already following this user');
            throw dupErr;
        }

        const [updatedTarget] = await Promise.all([
            SocialProfile.findOneAndUpdate(
                { username: targetUsername },
                { $inc: { followersCount: 1 } },
                { new: true }
            ),
            SocialProfile.findOneAndUpdate(
                { username: myUsername },
                { $inc: { followingCount: 1 } }
            ),
        ]);

        // PHASE 4 — keep the cache honest instead of leaving a stale
        // followersCount/followingCount sitting there for up to 5 minutes.
        patchCached(targetUsername, { followersCount: updatedTarget?.followersCount ?? 0 });
        invalidate(myUsername); // followingCount changed — cheap to drop and refetch next read

        // PHASE 5 — target's followersCount moved, so their leaderboard
        // position might have too. Fire-and-forget-safe (awaited here so
        // errors are caught, but it never touches the follow itself).
        await syncTrendingCreator(targetUsername);

        return sendResponse(res, 200, true, `You are now following ${targetUsername}`, {
            followersCount: updatedTarget?.followersCount ?? 0,
        });

    } catch (err) {
        console.error('⚠️ POST /api/follow error:', err);
        return sendResponse(res, 500, false, 'Failed to follow user');
    }
});

// ================= UNFOLLOW A USER =================
router.post('/api/unfollow', verifyToken, async (req, res) => {

    try {
        const myUsername = req.user.username;
        const targetUsername = req.body.username?.trim();

        if (!targetUsername)
            return sendResponse(res, 400, false, 'Target username is required');

        const deleted = await Follow.findOneAndDelete({
            followerUsername: myUsername,
            followingUsername: targetUsername,
        });

        if (!deleted)
            return sendResponse(res, 404, false, 'You are not following this user');

        const [updatedTarget] = await Promise.all([
            SocialProfile.findOneAndUpdate(
                { username: targetUsername, followersCount: { $gt: 0 } },
                { $inc: { followersCount: -1 } },
                { returnDocument: 'after' }
            ),
            SocialProfile.findOneAndUpdate(
                { username: myUsername, followingCount: { $gt: 0 } },
                { $inc: { followingCount: -1 } }
            ),
        ]);

        patchCached(targetUsername, { followersCount: updatedTarget?.followersCount ?? 0 });
        invalidate(myUsername);

        await syncTrendingCreator(targetUsername);

        return sendResponse(res, 200, true, `You unfollowed ${targetUsername}`, {
            followersCount: updatedTarget?.followersCount ?? 0,
        });

    } catch (err) {
        console.error('⚠️ POST /api/unfollow error:', err);
        return sendResponse(res, 500, false, 'Failed to unfollow user');
    }
});

module.exports = router;