/* ============================================================================
 *  cache/profileCache.js
 * ----------------------------------------------------------------------------
 *  PHASE 4 — in-memory profile cache.
 *  ----------------------------------------------------------------------------
 *  Every feed/profile endpoint used to re-run SocialProfile.find(...) on
 *  every single request just to grab a handful of cheap, slow-changing
 *  fields (avatarUrl, displayName, followersCount) for a batch of authors.
 *  This is a plain Node Map acting as a simple read-through cache in front
 *  of those lookups — no Redis, no external process, just process memory.
 *
 *  NOTE: this is per-process memory. If you ever run more than one Node
 *  instance behind a load balancer, each instance keeps its own cache —
 *  fine for now (a TTL + explicit invalidation on writes keeps things close
 *  enough to correct), but it's the first thing to swap for Redis if you
 *  scale out horizontally.
 * ==========================================================================*/

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min safety net in case we ever miss an invalidation call

// username -> { userId, username, displayName, avatarUrl, bio,
//               followersCount, followingCount, postsCount, cachedAt }
const profileCache = new Map();

function isFresh(entry) {
    return !!entry && (Date.now() - entry.cachedAt) < CACHE_TTL_MS;
}

// Returns the cached entry for a username, or null if missing/expired.
function getCached(username) {
    const entry = profileCache.get(username);
    if (!isFresh(entry)) {
        if (entry) profileCache.delete(username);
        return null;
    }
    return entry;
}

// Writes/replaces the full cached entry for a username.
function setCached(username, data) {
    profileCache.set(username, { ...data, cachedAt: Date.now() });
}

// Patches specific fields on an already-cached entry (e.g. bump
// followersCount by 1 after a follow) without a full re-fetch. If the
// username isn't cached yet, this is a no-op — the next read just fetches
// fresh from Mongo and populates it.
function patchCached(username, fields) {
    const entry = profileCache.get(username);
    if (!entry) return;
    profileCache.set(username, { ...entry, ...fields, cachedAt: Date.now() });
}

// Drops a username from the cache entirely — call this whenever a profile
// write happens somewhere we didn't bother patching field-by-field.
function invalidate(username) {
    profileCache.delete(username);
}

// Batch fetch: returns a Map<username, profileData> for every requested
// username, serving whatever's already cached and hitting Mongo only for
// the ones that are missing or stale. `SocialProfile` is passed in rather
// than required here to avoid a require-cycle with social_models.js.
async function getManyProfiles(
    usernames,
    SocialProfile,
    projection = 'userId username displayName avatarUrl bio followersCount followingCount postsCount'
) {
    const result = new Map();
    const missing = [];

    for (const username of usernames) {
        const cached = getCached(username);
        if (cached) result.set(username, cached);
        else missing.push(username);
    }

    if (missing.length) {
        const docs = await SocialProfile.find({ username: { $in: missing } }, projection).lean();
        docs.forEach(doc => {
            setCached(doc.username, {
                userId: doc.userId,
                username: doc.username,
                displayName: doc.displayName,
                avatarUrl: doc.avatarUrl,
                bio: doc.bio,
                followersCount: doc.followersCount,
                followingCount: doc.followingCount,
                postsCount: doc.postsCount,
            });
            result.set(doc.username, getCached(doc.username));
        });
    }

    return result;
}

// Single-profile convenience wrapper around getManyProfiles.
async function getOneProfile(username, SocialProfile, projection) {
    const map = await getManyProfiles([username], SocialProfile, projection);
    return map.get(username) || null;
}

module.exports = {
    getCached,
    setCached,
    patchCached,
    invalidate,
    getManyProfiles,
    getOneProfile,
    profileCache, // exported for debugging/tests only
};