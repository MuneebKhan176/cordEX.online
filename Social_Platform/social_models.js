/* ============================================================================
 *  Social_Platform/social_models.js
 * ----------------------------------------------------------------------------
 *   const {
 *     SocialProfile, Post, Comment, Reply, Follow, Like,
 *     Poll, Hashtag, Media, UserActivity, Notification
 *   } = require('./social_models');
 * ----------------------------------------------------------------------------
 *  CHANGELOG (this revision):
 *   - SocialProfile.avatarVersion -> NEW. Monotonically increasing counter,
 *                                bumped once per avatar upload (see
 *                                Social_Platform routes: POST
 *                                /api/profile/avatar). Used to build a
 *                                unique, cache-bustable R2 object key
 *                                (`avatars/{userId}_v{version}.jpg`) so
 *                                avatarUrl can be cached immutably forever
 *                                on the CDN/browser and still update
 *                                instantly whenever someone changes their
 *                                photo. avatarUrl itself now stores a
 *                                Cloudflare R2 URL rather than a raw
 *                                base64 data string, which is what makes
 *                                profile photos load quickly wherever
 *                                they're shown (feed, profile, chat).
 *   - Post.sentiment          -> "bullish" | "bearish" | null (the button the
 *                                 user taps on the composer; rendered as a
 *                                 green ▲ / red ▼ pill next to the display
 *                                 name on the profile page).
 *   - Post.hashtags           -> already existed, kept + indexed. Frontend
 *                                 now renders these as pill tags at the very
 *                                 end of the post (after the media block).
 *   - Post.viewsCount         -> added so the "views" icon in the engagement
 *                                 bar reflects a real number instead of
 *                                 permanently showing 0. Incremented once per
 *                                 viewer via POST /api/posts/:id/view
 *                                 (IntersectionObserver on the frontend).
 *   - Post.sharesCount        -> NEW. Times this post has been shared/reposted.
 *                                 Feeds into feedScore.js — Facebook-style
 *                                 ranking weights shares above comments and
 *                                 likes, so this is the single highest engagement
 *                                 signal.
 *   - Post.saveCount          -> NEW. Times this post has been bookmarked/saved
 *                                 by a viewer. Strong intent signal, ranked
 *                                 below shares/comments but above raw likes.
 *   - Post.clickCount         -> NEW. Times a viewer clicked into the post
 *                                 (e.g. to open the full picture, a link, or
 *                                 a "read more"). Weak/soft engagement signal.
 *   - Post.watchSeconds       -> NEW. Cumulative seconds of video watch-time
 *                                 across all viewers. Used for video-heavy
 *                                 posts as an attention signal in feedScore.js.
 *   - MediaAttachmentSchema   -> width/height kept so the frontend slider can
 *                                 reserve the correct box before the image
 *                                 loads (no layout jump) and render the
 *                                 picture in full with object-fit: contain
 *                                 instead of a cropping object-fit: cover.
 *   - Post.hashtags/sentiment -> both indexed for discovery / filtering.
 * ==========================================================================*/

const mongoose = require("mongoose");
const { Schema } = mongoose;

const TARGET_TYPES = ["Post", "Comment", "Reply"];
const SENTIMENT_TYPES = ["bullish", "bearish"];

const MediaAttachmentSchema = new Schema(
  {
    url: { type: String, required: true },
    thumbUrl: { type: String, default: null }, // NEW — R2 grid-thumbnail URL for images
    type: { type: String, enum: ["image", "video"], required: true },
    width: Number,
    height: Number,
    durationSeconds: Number, // for video
    order: { type: Number, default: 0 }, // slide order in the picture slider
  },
  { _id: false }
);

/* ============================================================================
 * 1. SOCIAL PROFILE
 * ==========================================================================*/
const SocialProfileSchema = new Schema(
  {
    userId: { type: String, required: true, unique: true, index: true }, // FK -> mysql users.id (VARCHAR(20), e.g. "UID-726-WXJ-085")
    username: { type: String, required: true, unique: true, index: true }, // FK -> mysql accounts.username
    email: { type: String, required: true, unique: true, index: true }, // FK -> mysql accounts.email

    displayName: { type: String, default: "", trim: true, maxlength: 60 },
    bio: { type: String, default: "", maxlength: 300 },

    avatarUrl: { type: String, default: "" },
    avatarVersion: { type: Number, default: 0 },

    coverUrl: { type: String, default: "" },

    isVerified: { type: Boolean, default: false },

    followersCount: { type: Number, default: 0 },
    followingCount: { type: Number, default: 0 },
    postsCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

/* ============================================================================
 * 2. POST
 * ==========================================================================*/
const PostSchema = new Schema(
  {
    username: { type: String, required: true, index: true }, // author, FK -> SocialProfile.username

    content: { type: String, default: "", maxlength: 2000 },
    media: { type: [MediaAttachmentSchema], default: [] },

    // Quick market-sentiment button chosen on the composer. Independent of
    // the more detailed `signal` block below — sentiment is just the
    // green/red pill shown next to the author's name; `signal` is optional
    // structured trade data for posts that want to go further.
    sentiment: { type: String, enum: [...SENTIMENT_TYPES, null], default: null, index: true },

    hashtags: { type: [String], default: [], index: true }, // lowercase, no '#'

    poll: { type: Schema.Types.ObjectId, ref: "Poll", default: null },

    // ---- optional trade-signal fields (only set when isSignal = true) ----
    isSignal: { type: Boolean, default: false },
    signal: {
      symbol: { type: String, default: "" },
      direction: { type: String, enum: ["long", "short", null], default: null },
      entryPrice: { type: Number, default: null },
      targetPrice: { type: Number, default: null },
      stopLoss: { type: Number, default: null },
    },

    // Denormalized counters
    likesCount: { type: Number, default: 0 },
    commentsCount: { type: Number, default: 0 },
    viewsCount: { type: Number, default: 0 },

    // NEW — engagement-ranking counters (see services/feedScore.js).
    // Facebook-style priority: shares > comments > likes, with saves,
    // clicks, and watch-time as supporting signals.
    sharesCount: { type: Number, default: 0 },
    saveCount: { type: Number, default: 0 },
    clickCount: { type: Number, default: 0 },
    watchSeconds: { type: Number, default: 0 },

    isEdited: { type: Boolean, default: false },
    isDeleted: { type: Boolean, default: false }, // soft delete
  },
  { timestamps: true }
);
PostSchema.index({ username: 1, createdAt: -1 });
PostSchema.index({ hashtags: 1, createdAt: -1 });

/* ============================================================================
 * 3. COMMENT
 * ==========================================================================*/
const CommentSchema = new Schema(
  {
    post: { type: Schema.Types.ObjectId, ref: "Post", required: true, index: true },
    username: { type: String, required: true, index: true },
    content: { type: String, required: true, maxlength: 1000 },
    likesCount: { type: Number, default: 0 },
    repliesCount: { type: Number, default: 0 },
    isEdited: { type: Boolean, default: false },
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);
CommentSchema.index({ post: 1, createdAt: -1 });

/* ============================================================================
 * 4. REPLY
 * ==========================================================================*/
const ReplySchema = new Schema(
  {
    comment: { type: Schema.Types.ObjectId, ref: "Comment", required: true, index: true },
    post: { type: Schema.Types.ObjectId, ref: "Post", required: true, index: true },
    username: { type: String, required: true, index: true },
    content: { type: String, required: true, maxlength: 1000 },
    likesCount: { type: Number, default: 0 },
    isEdited: { type: Boolean, default: false },
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);
ReplySchema.index({ comment: 1, createdAt: 1 });

/* ============================================================================
 * 5. FOLLOW
 * ==========================================================================*/
const FollowSchema = new Schema(
  {
    followerUsername: { type: String, required: true, index: true },
    followingUsername: { type: String, required: true, index: true },
  },
  { timestamps: true }
);
FollowSchema.index({ followerUsername: 1, followingUsername: 1 }, { unique: true });

/* ============================================================================
 * 6. LIKE
 * ==========================================================================*/
const LikeSchema = new Schema(
  {
    username: { type: String, required: true, index: true },
    targetType: { type: String, enum: TARGET_TYPES, required: true },
    targetId: { type: Schema.Types.ObjectId, required: true, index: true },
  },
  { timestamps: true }
);
LikeSchema.index({ username: 1, targetType: 1, targetId: 1 }, { unique: true });

/* ============================================================================
 * 7. POLL
 * ==========================================================================*/
const PollOptionSchema = new Schema(
  {
    text: { type: String, required: true, maxlength: 100 },
    votesCount: { type: Number, default: 0 },
  },
  { _id: true }
);

const PollSchema = new Schema(
  {
    post: { type: Schema.Types.ObjectId, ref: "Post", required: true, index: true },
    question: { type: String, required: true, maxlength: 200 },
    options: { type: [PollOptionSchema], required: true },
    voters: {
      type: [
        {
          username: { type: String, required: true },
          optionId: { type: Schema.Types.ObjectId, required: true },
          _id: false,
        },
      ],
      default: [],
    },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

/* ============================================================================
 * 8. HASHTAG (trending hashtags)
 * ==========================================================================*/
const HashtagSchema = new Schema(
  {
    tag: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    postsCount: { type: Number, default: 0 },
    trendScore: { type: Number, default: 0 },
    lastUsedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

/* ============================================================================
 * 9. MEDIA (upload registry)
 * ==========================================================================*/
const MediaSchema = new Schema(
  {
    username: { type: String, required: true, index: true },
    url: { type: String, required: true },
    type: { type: String, enum: ["image", "video"], required: true },
    width: Number,
    height: Number,
    durationSeconds: Number,
    sizeBytes: Number,
    attachedToType: { type: String, enum: ["Post", null], default: null },
    attachedToId: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: true }
);

/* ============================================================================
 * 10. USER ACTIVITY
 * ----------------------------------------------------------------------------
 *  activityType additions (Phase 3 — personalized discover feed):
 *    view_crypto / view_btc / view_eth -> fired when a user views a post
 *                                          tagged with that hashtag (see
 *                                          POST /api/posts/:id/view).
 *    watch_video                       -> fired when a user actually plays
 *                                          a video attached to a post (see
 *                                          POST /api/posts/:id/activity).
 *    open_profile                      -> fired when a user taps into a
 *                                          post's author (same endpoint).
 *  These raw events are what services/interestTracker.js reads to build
 *  each user's UserInterest score profile.
 * ==========================================================================*/
const UserActivitySchema = new Schema(
  {
    username: { type: String, required: true, index: true },
    activityType: {
      type: String,
      enum: [
        "view_post", "like", "comment", "follow", "search",
        "view_crypto", "view_btc", "view_eth", "watch_video", "open_profile",
      ],
      required: true,
    },
    targetType: { type: String, enum: TARGET_TYPES, default: null },
    targetId: { type: Schema.Types.ObjectId, default: null },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);
UserActivitySchema.index({ username: 1, createdAt: -1 });

/* ============================================================================
 * 10b. USER INTEREST (Phase 3 — personalization score per user+hashtag)
 * ----------------------------------------------------------------------------
 *  Derived from UserActivity by services/interestTracker.js. One row per
 *  (username, hashtag) pair, e.g. { username: "muneeb", hashtag: "crypto",
 *  score: 35 }. feedScore.js reads this back out to boost posts a given
 *  user is likely to care about, so /api/posts/discover and
 *  /api/insights/discover show a different ranking per person.
 * ==========================================================================*/
const UserInterestSchema = new Schema(
  {
    username: { type: String, required: true, index: true },
    hashtag: { type: String, required: true, index: true },
    score: { type: Number, default: 0 },
  },
  { timestamps: true }
);
UserInterestSchema.index({ username: 1, hashtag: 1 }, { unique: true });

/* ============================================================================
 * 11. NOTIFICATION
 * ==========================================================================*/
const NotificationSchema = new Schema(
  {
    recipientUsername: { type: String, required: true, index: true },
    actorUsername: { type: String, required: true },
    type: { type: String, enum: ["like", "comment", "reply", "follow", "mention"], required: true },
    targetType: { type: String, enum: TARGET_TYPES, default: null },
    targetId: { type: Schema.Types.ObjectId, default: null },
    isRead: { type: Boolean, default: false },
  },
  { timestamps: true }
);
NotificationSchema.index({ recipientUsername: 1, createdAt: -1 });

/* ============================================================================
 * MODEL EXPORTS
 * ==========================================================================*/
module.exports = {
  SENTIMENT_TYPES,
  SocialProfile: mongoose.model("SocialProfile", SocialProfileSchema),
  Post: mongoose.model("Post", PostSchema),
  Comment: mongoose.model("Comment", CommentSchema),
  Reply: mongoose.model("Reply", ReplySchema),
  Follow: mongoose.model("Follow", FollowSchema),
  Like: mongoose.model("Like", LikeSchema),
  Poll: mongoose.model("Poll", PollSchema),
  Hashtag: mongoose.model("Hashtag", HashtagSchema),
  Media: mongoose.model("Media", MediaSchema),
  UserActivity: mongoose.model("UserActivity", UserActivitySchema),
  UserInterest: mongoose.model("UserInterest", UserInterestSchema),
  Notification: mongoose.model("Notification", NotificationSchema),
};