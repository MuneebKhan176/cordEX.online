/* ============================================================================
 *  Social_Platform/services/likeService.js
 * ----------------------------------------------------------------------------
 *  PHASE 6 — pulled out of enrichPosts(). Owns exactly one job: figure out
 *  which of a given set of posts the current viewer has already liked.
 *  Kept as a live Mongo query (not cached) since like state is per-viewer
 *  and changes constantly — caching it risks showing a stale heart icon.
 * ==========================================================================*/

const { Like } = require('../../social_models');

// Returns a Set<postIdString> of the posts `myUsername` has liked, scoped
// to just the postIds passed in (never the viewer's whole like history).
async function getLikes(myUsername, postIds) {
    if (!myUsername || !postIds || !postIds.length) return new Set();

    const myLikes = await Like.find({
        username: myUsername,
        targetType: 'Post',
        targetId: { $in: postIds },
    }).select('targetId').lean();

    return new Set(myLikes.map(l => String(l.targetId)));
}

module.exports = { getLikes };