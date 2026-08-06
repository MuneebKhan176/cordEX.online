/* ============================================================================
 *  Social_Platform/services/likeService.js
 * ----------------------------------------------------------------------------
 *  PHASE 6 — pulled out of enrichPosts(). Owns exactly one job: figure out
 *  which of a given set of targets the current viewer has already liked.
 *  Kept as a live Mongo query (not cached) since like state is per-viewer
 *  and changes constantly — caching it risks showing a stale heart icon.
 *
 *  PHASE 11 — `targetType` is now a parameter (defaults to 'Post' so every
 *  existing caller, e.g. enrichService.js, is unaffected). commentService.js
 *  passes 'Comment' / 'Reply' to reuse this same lookup instead of writing
 *  a near-duplicate query. Like-only across the whole app — this file has
 *  no concept of a dislike/downvote.
 * ==========================================================================*/

const { Like } = require('../../social_models');

// Returns a Set<targetIdString> of the targets `myUsername` has liked,
// scoped to just the targetIds passed in (never the viewer's whole like
// history) and to a single targetType at a time.
async function getLikes(myUsername, targetIds, targetType = 'Post') {
    if (!myUsername || !targetIds || !targetIds.length) return new Set();

    const myLikes = await Like.find({
        username: myUsername,
        targetType,
        targetId: { $in: targetIds },
    }).select('targetId').lean();

    return new Set(myLikes.map(l => String(l.targetId)));
}

module.exports = { getLikes };