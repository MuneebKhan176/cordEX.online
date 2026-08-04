/* ============================================================================
 *  Social_Platform/services/followService.js
 * ----------------------------------------------------------------------------
 *  PHASE 6 — pulled out of enrichPosts(). Owns exactly one job: figure out
 *  who the current viewer follows. Kept as a live Mongo query (not cached)
 *  since follow state is per-viewer relationship data that changes on every
 *  follow/unfollow — caching it risks showing a stale Follow/Following
 *  button.
 * ==========================================================================*/

const { Follow } = require('../../social_models');

// Returns a Set<username> of everyone `myUsername` currently follows.
async function getFollows(myUsername) {
    if (!myUsername) return new Set();

    const myFollows = await Follow.find({ followerUsername: myUsername })
        .select('followingUsername')
        .lean();

    return new Set(myFollows.map(f => f.followingUsername));
}

module.exports = { getFollows };