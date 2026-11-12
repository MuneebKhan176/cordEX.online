/* ============================================================================
 *  Social_Platform/services/Feed_Engine/friendshipService.js
 * ----------------------------------------------------------------------------
 *  PHASE 9 — "friendship" factor in the ranking formula. Cheap proxy off
 *  the existing Follow collection:
 *    - mutual follow (they follow you AND you follow them)  -> 1
 *    - one-way follow (either direction only)                -> 0.5
 *    - no relationship                                       -> 0
 *
 *  Batched per-viewer against a list of candidate author usernames, same
 *  pattern already used by cache/profileCache.getManyProfiles() and
 *  interestTracker.getInterestMap() — one call, two indexed Follow queries,
 *  no N+1.
 * ==========================================================================*/

const { Follow } = require('../../../Databases/MongoDB/social_models');

// Returns Map<authorUsername, 0 | 0.5 | 1> for the given viewer against
// each username in authorUsernames.
async function getFriendshipMap(myUsername, authorUsernames) {
    if (!authorUsernames || !authorUsernames.length) return new Map();

    const [iFollow, followMe] = await Promise.all([
        Follow.find({ followerUsername: myUsername, followingUsername: { $in: authorUsernames } })
            .select('followingUsername').lean(),
        Follow.find({ followingUsername: myUsername, followerUsername: { $in: authorUsernames } })
            .select('followerUsername').lean(),
    ]);

    const iFollowSet = new Set(iFollow.map(f => f.followingUsername));
    const followMeSet = new Set(followMe.map(f => f.followerUsername));

    const map = new Map();
    authorUsernames.forEach(u => {
        const mutual = iFollowSet.has(u) && followMeSet.has(u);
        const oneWay = iFollowSet.has(u) || followMeSet.has(u);
        map.set(u, mutual ? 1 : oneWay ? 0.5 : 0);
    });
    return map;
}

module.exports = { getFriendshipMap };