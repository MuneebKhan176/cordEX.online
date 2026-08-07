/* ============================================================================
 *  Social_Platform/services/Feed_Engine/trendingCreators.js
 * ----------------------------------------------------------------------------
 *  PHASE 5 — keeps the TrendingCreator collection (username, followersCount,
 *  score) in sync so /api/top-creators never has to pull every
 *  SocialProfile into memory and quickselect over it. Instead the top 10
 *  is just:
 *
 *      TrendingCreator.find().sort({ score: -1 }).limit(10)
 *
 *  ...which Mongo answers straight off a { score: -1 } index regardless of
 *  whether there are 1,000 users or 1,000,000.
 *
 *  syncTrendingCreator(username) re-reads that one user's current
 *  followersCount/postsCount from SocialProfile and upserts their
 *  TrendingCreator row. Call it right after anything that could move
 *  someone's ranking:
 *    - POST   /api/follow     (target's followersCount went up)
 *    - POST   /api/unfollow   (target's followersCount went down)
 *    - POST   /api/posts      (author's postsCount went up)
 *    - DELETE /api/posts/:id  (author's postsCount went down)
 *
 *  PHASE 7 — `updateTrending` is exported as an alias of the same function,
 *  so the create-post route's parallel dispatch (increasePostCount /
 *  registerHashtags / createNotifications / updateTrending /
 *  updateRecommendations) can read as a flat list of named steps without
 *  renaming anything top-creators.js or profile.js already depend on.
 * ==========================================================================*/

const { SocialProfile, TrendingCreator } = require('../../social_models');

// Simple, tunable ranking formula — followers dominate (mirrors the old
// "top creators by followersCount" behavior); postsCount is a small
// secondary nudge so active posters edge out equally-followed lurkers.
function computeScore({ followersCount = 0, postsCount = 0 }) {
    return followersCount * 10 + postsCount;
}

async function syncTrendingCreator(username) {
    if (!username) return;

    try {
        const profile = await SocialProfile.findOne(
            { username },
            'username followersCount postsCount'
        ).lean();

        if (!profile) return;

        const followersCount = profile.followersCount || 0;
        const score = computeScore({ followersCount, postsCount: profile.postsCount || 0 });

        await TrendingCreator.findOneAndUpdate(
            { username },
            { $set: { followersCount, score } },
            { upsert: true }
        );
    } catch (err) {
        console.error('⚠️ syncTrendingCreator error:', err);
    }
}

module.exports = {
    syncTrendingCreator,
    updateTrending: syncTrendingCreator, // PHASE 7 alias
    computeScore,
};