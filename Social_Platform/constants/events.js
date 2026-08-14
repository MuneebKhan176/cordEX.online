/* ============================================================================
 *  Social_Platform/constants/events.js
 * ----------------------------------------------------------------------------
 *  PHASE 11 Part 2 — single source of truth for every WS event name and
 *  Notification "type" value. Previously these were hardcoded strings
 *  scattered across websocketService.js, the handlers, and the frontend
 *  <script> blocks — easy to typo, impossible to grep for confidently.
 * ==========================================================================*/

const SOCIAL_EVENTS = {
    POST_LIKED:     'post_liked',
    NEW_COMMENT:    'new_comment',
    NEW_REPLY:      'new_reply',
    COMMENT_LIKED:  'comment_liked',
    REPLY_LIKED:    'reply_liked',
    NEW_FOLLOWER:   'new_follower',
    USER_ONLINE:    'user_online',
    USER_OFFLINE:   'user_offline',

    // PHASE 11 Part 2 — additions
    NOTIFICATION:   'notification',   // generic "you have a new notification" push -> bell/notifications.html
    NEW_POST:       'new_post',       // pushed to followers when someone they follow posts
};

const NOTIFICATION_TYPES = {
    LIKE:    'like',
    COMMENT: 'comment',
    REPLY:   'reply',
    FOLLOW:  'follow',
    MENTION: 'mention',
};

module.exports = { SOCIAL_EVENTS, NOTIFICATION_TYPES };