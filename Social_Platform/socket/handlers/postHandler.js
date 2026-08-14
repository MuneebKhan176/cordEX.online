const notificationService = require('../../services/Post_Services/notificationService');

function emitNewPostToFollowers({ post, authorUsername }) {
    notificationService.notifyNewPostToFollowers({ post, authorUsername })
        .catch(err => console.error('⚠️ emitNewPostToFollowers error:', err));
}

module.exports = { emitNewPostToFollowers };