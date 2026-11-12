/* ============================================================================
 *  Social_Platform/services/Feed_Engine/interestTracker.js
 * ----------------------------------------------------------------------------
 *  Turns raw UserActivity events into a personalized interest profile per
 *  user, stored as { username, hashtag, score } rows in UserInterest (e.g.
 *  { username: "muneeb", hashtag: "crypto", score: 35 }). feedRanking.js
 *  reads that profile back out (via getInterestMap -> interestScore()) to
 *  boost posts a given user is likely to care about — this is what makes
 *  the discover feeds show a different ranking per person instead of the
 *  same feed for everyone.
 *
 *  PHASE 11 — added `comment` as a scored activity type. Posting a comment
 *  or reply (services/commentService.js) is a much stronger intent signal
 *  than a passive view, so it's weighted above watch_video/open_profile.
 *  This reuses the `"comment"` value already present in
 *  UserActivitySchema.activityType's enum (social_models.js) — no schema
 *  change required. Hashtags are resolved the same generic way
 *  watch_video/open_profile already work: whatever tags the post being
 *  commented on carries (see resolveHashtags() below).
 * ==========================================================================*/

const { UserActivity, UserInterest } = require('../../../Databases/MongoDB/social_models');

// Activity types whose hashtag is implied by the type itself
// ("view_crypto" always scores the "crypto" hashtag).
const FIXED_HASHTAG_ACTIVITIES = {
    view_crypto: 'crypto',
    view_btc: 'btc',
    view_eth: 'eth',
};

// How many points each activity type contributes per matched hashtag —
// mirrors the "if (interest === 'crypto') score += 50;" rule, kept in one
// place so tuning personalization stays a one-line change, same spirit as
// feedRanking.js's engagement weights.
const ACTIVITY_SCORE_WEIGHTS = {
    view_crypto: 50,
    view_btc: 50,
    view_eth: 50,
    comment: 40,       // PHASE 11 — commenting/replying: stronger intent than a passive view
    watch_video: 30,   // stronger intent than a passive view
    open_profile: 15,  // curiosity about the author, weaker than a direct view
};

const TRACKABLE_ACTIVITY_TYPES = Object.keys(ACTIVITY_SCORE_WEIGHTS);

// Works out which hashtag(s) a given activity should feed points into.
//  - view_crypto/view_btc/view_eth are fixed to their own hashtag, but only
//    score if the post actually carries that tag (no free points for
//    viewing an untagged post).
//  - watch_video/open_profile/comment inherit whatever hashtags the
//    triggering post already has.
function resolveHashtags(activityType, post) {
    const postTags = post?.hashtags || [];

    const fixedTag = FIXED_HASHTAG_ACTIVITIES[activityType];
    if (fixedTag) {
        return postTags.includes(fixedTag) ? [fixedTag] : [];
    }

    return postTags;
}

// Logs the raw event to UserActivity (always, for auditing/analytics) and
// bumps UserInterest scores for any matched hashtags (only for recognized,
// weighted activity types). `post` is a plain object/doc with `hashtags`.
async function trackActivity({ username, activityType, post = null, targetType = null, targetId = null, metadata = {} }) {
    if (!username || !activityType) return;

    await UserActivity.create({ username, activityType, targetType, targetId, metadata }).catch(err =>
        console.error('⚠️ trackActivity UserActivity.create error:', err)
    );

    const weight = ACTIVITY_SCORE_WEIGHTS[activityType];
    if (!weight) return; // logged above, but not a scored/personalization-relevant type

    const hashtags = resolveHashtags(activityType, post);
    if (!hashtags.length) return;

    await Promise.all(hashtags.map(hashtag =>
        UserInterest.findOneAndUpdate(
            { username, hashtag },
            { $inc: { score: weight } },
            { upsert: true }
        ).catch(err => console.error('⚠️ trackActivity UserInterest bump error:', err))
    ));
}

// Returns a Map<hashtag, score> for a user's current interest profile —
// consumed by feedRanking.js's calculateScore() to personalize ranking.
async function getInterestMap(username) {
    if (!username) return new Map();
    const rows = await UserInterest.find({ username }).select('hashtag score').lean();
    return new Map(rows.map(r => [r.hashtag, r.score]));
}

module.exports = {
    trackActivity,
    getInterestMap,
    resolveHashtags,
    TRACKABLE_ACTIVITY_TYPES,
    ACTIVITY_SCORE_WEIGHTS,
};