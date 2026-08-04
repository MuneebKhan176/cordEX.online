/* ============================================================================
 *  Social_Platform/services/authorService.js
 * ----------------------------------------------------------------------------
 *  PHASE 6 — pulled out of enrichPosts(). Owns exactly one job: batch-fetch
 *  author display data (displayName / avatarUrl / followersCount) for a set
 *  of usernames. Delegates to the shared in-memory profile cache
 *  (cache/profileCache.js, Phase 4) so this stays a thin wrapper rather than
 *  a duplicate caching layer.
 * ==========================================================================*/

const { SocialProfile } = require('../../social_models');
const { getManyProfiles } = require('../../cache/profileCache');

const DEFAULT_PROJECTION = 'username displayName avatarUrl followersCount';

// Returns a Map<username, { username, displayName, avatarUrl,
// followersCount, ... }> for the given usernames, served from cache where
// possible (see cache/profileCache.js for TTL/invalidation behavior).
async function getAuthors(usernames, projection = DEFAULT_PROJECTION) {
    if (!usernames || !usernames.length) return new Map();
    return getManyProfiles(usernames, SocialProfile, projection);
}

module.exports = { getAuthors };