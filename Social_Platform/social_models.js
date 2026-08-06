/* ============================================================================
 *  Social_Platform/social_models.js
 * ----------------------------------------------------------------------------
 *   const {
 *     SocialProfile, Post, Comment, Reply, Follow, Like,
 *     Poll, Hashtag, Media, UserActivity, Notification
 *   } = require('./social_models');
 * ----------------------------------------------------------------------------
 *  CHANGELOG (this revision):
 *   - PHASE 8 — MediaAttachmentSchema gained progressive-image fields
 *               (thumbnailUrl, compressedUrl, blurHash, aspectRatio) and
 *               adaptive-video fields (duration, quality, video480p,
 *               video720p). See Social_Platform/routes/upload.js for how
 *               these get populated.
 *   - avatarVersion, sentiment, hashtags, viewsCount, sharesCount,
 *     saveCount, clickCount, watchSeconds — unchanged from prior revision.
 * ==========================================================================*/

const mongoose = require("mongoose");
const { Schema } = mongoose;

const TARGET_TYPES = ["Post", "Comment", "Reply"];
const SENTIMENT_TYPES = ["bullish", "bearish"];

const MediaAttachmentSchema = new Schema(
  {
    url: { type: String, required: true },        // original (image) / source file (video)
    thumbUrl: { type: String, default: null },     // existing small grid thumbnail (backward compat)
    type: { type: String, enum: ["image", "video"], required: true },
    width: Number,
    height: Number,
    durationSeconds: Number, // legacy field, kept for backward compat — use `duration` below going forward
    order: { type: Number, default: 0 }, // slide order in the picture slider

    // ---- PHASE 8: images — progressive loading (blur -> compressed -> original) ----
    thumbnailUrl: { type: String, default: null },  // tiny (~480px), loads first
    compressedUrl: { type: String, default: null }, // ~800px mid-quality, loads second
    blurHash: { type: String, default: null },      // paints instantly before any bytes arrive
    aspectRatio: { type: Number, default: null },   // width/height, prevents layout jump while loading

    // ---- PHASE 8: video — adaptive quality / streaming ----
    duration: { type: Number, default: null },        // seconds
    quality: {
      type: String,
      enum: ["processing", "ready", "failed", null],
      default: null,
    },
    video480p: { type: String, default: null },
    video720p: { type: String, default: null },
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

    // Engagement-ranking counters (see services/feedRanking.js).
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
 * 8b. TRENDING CREATOR (precomputed top-creators leaderboard)
 * ==========================================================================*/
const TrendingCreatorSchema = new Schema(
  {
    username: { type: String, required: true, unique: true, index: true },
    followersCount: { type: Number, default: 0 },
    score: { type: Number, default: 0 },
  },
  { timestamps: true }
);
TrendingCreatorSchema.index({ score: -1 });

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
 * 10b. USER INTEREST (personalization score per user+hashtag)
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
  TrendingCreator: mongoose.model("TrendingCreator", TrendingCreatorSchema),
  UserActivity: mongoose.model("UserActivity", UserActivitySchema),
  UserInterest: mongoose.model("UserInterest", UserInterestSchema),
  Notification: mongoose.model("Notification", NotificationSchema),
};