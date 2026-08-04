/* ============================================================================
 *  Social_Platform/services/postStatsService.js
 * ----------------------------------------------------------------------------
 *  PHASE 7 — pulled the "bump postsCount" half of what used to be an inline
 *  SocialProfile.findOneAndUpdate() call inside the create-post route. Owns
 *  exactly one job: increment an author's postsCount and keep the profile
 *  cache (Phase 4) in sync with the result, so callers never have to
 *  remember to patch the cache themselves.
 * ==========================================================================*/

const { SocialProfile } = require('../social_models');
const { patchCached } = require('../cache/profileCache');

// Increments postsCount for `username` and returns the updated profile doc
// (lean-ish plain object). Patches the profile cache with the new count so
// feeds/profile reads don't serve a stale value until the TTL expires.
async function increasePostCount(username) {
    const updated = await SocialProfile.findOneAndUpdate(
        { username },
        { $inc: { postsCount: 1 } },
        { new: true }
    );

    if (updated) {
        patchCached(username, { postsCount: updated.postsCount });
    }

    return updated;
}

module.exports = { increasePostCount };