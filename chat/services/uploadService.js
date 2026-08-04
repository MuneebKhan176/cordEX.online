/**
 * uploadService.js
 * -----------------------------------------------------------------------
 * Validates and uploads chat attachments, profile avatars, AND post
 * media (images/videos) to Cloudflare R2 (S3-compatible).
 *
 *   - uploadAvatar(buffer, mimetype, userId, version): square 512x512
 *     avatar under `avatars/{userId}_v{version}.jpg`.
 *   - uploadOne / uploadAttachments: chat attachments under
 *     `chat/{roomId}/{id}...` (unchanged behavior).
 *   - uploadPostMedia: NEW — post images/videos under
 *     `posts/{username}/{id}...`, same validation/thumbnailing pipeline
 *     as chat attachments (display image capped at 1600px, 480x480 grid
 *     thumbnail, blurred LQIP placeholder for images).
 *
 * Both uploadOne and uploadPostMedia now delegate to a shared internal
 * uploadMediaFile({ buffer, mimetype, originalName, folder }) helper so
 * there's exactly one place that does resizing/thumbnailing/R2 puts.
 * -----------------------------------------------------------------------
 * Requires: npm install sharp @aws-sdk/client-s3
 * -----------------------------------------------------------------------
 */

const {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} = require('@aws-sdk/client-s3');
const crypto = require('crypto');
const sharp = require('sharp');

const {
  CLOUD_ACCOUNT_ID,
  BUCKET_NAME,
  CLOUD_PUBLIC_URI,
  ACCESS_KEY_ID,
  SECRET_ACCESS_KEY,
} = process.env;

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${CLOUD_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: ACCESS_KEY_ID,
    secretAccessKey: SECRET_ACCESS_KEY,
  },
});

const LIMITS = {
  image: 5 * 1024 * 1024,     // 5MB
  video: 200 * 1024 * 1024,   // 200MB
  document: 50 * 1024 * 1024, // 50MB
};

const ALLOWED_MIME = {
  image: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
  video: ['video/mp4', 'video/webm', 'video/quicktime'],
  document: [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain',
  ],
};

// Cache forever — filenames are content-addressed (random UUID), so
// there is never a "stale" version to worry about invalidating.
const CACHE_CONTROL = 'public, max-age=31536000, immutable';

function classify(mimetype) {
  for (const kind of Object.keys(ALLOWED_MIME)) {
    if (ALLOWED_MIME[kind].includes(mimetype)) return kind;
  }
  return null;
}

function extFor(originalName) {
  return (originalName.split('.').pop() || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10);
}

async function putObject(key, buffer, mimetype) {
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      Body: buffer,
      ContentType: mimetype,
      CacheControl: CACHE_CONTROL,
    })
  );
  return `${CLOUD_PUBLIC_URI.replace(/\/$/, '')}/${key}`;
}

/**
 * Builds the "display" image (what the lightbox/full view loads) capped
 * at 1600px on the long edge, re-encoded at sane quality.
 */
async function buildDisplayImage(buffer, mimetype) {
  const img = sharp(buffer, { failOn: 'none' }).rotate(); // auto-applies EXIF orientation
  const meta = await img.metadata();

  let pipeline = img.resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true });
  if (mimetype === 'image/png') {
    pipeline = pipeline.png({ quality: 82, compressionLevel: 9 });
  } else if (mimetype === 'image/webp') {
    pipeline = pipeline.webp({ quality: 82 });
  } else {
    pipeline = pipeline.jpeg({ quality: 82, mozjpeg: true });
  }
  const out = await pipeline.toBuffer();
  return { buffer: out, width: meta.width, height: meta.height };
}

/** Small grid thumbnail — chat bubble / post card thumbnail. */
async function buildThumb(buffer) {
  return sharp(buffer, { failOn: 'none' })
    .rotate()
    .resize({ width: 480, height: 480, fit: 'cover' })
    .jpeg({ quality: 70 })
    .toBuffer();
}

/** Tiny blurred base64 placeholder, inlined directly in the JSON response. */
async function buildLqip(buffer) {
  const tiny = await sharp(buffer, { failOn: 'none' })
    .rotate()
    .resize({ width: 24, fit: 'inside' })
    .blur(2)
    .jpeg({ quality: 40 })
    .toBuffer();
  return `data:image/jpeg;base64,${tiny.toString('base64')}`;
}

/**
 * Shared core: validates, resizes/thumbnails (images only), uploads to
 * R2 under `${folder}/${randomId}...`. Used by both chat uploads
 * (folder = `chat/{roomId}`) and post uploads (folder = `posts/{username}`).
 */
async function uploadMediaFile({ buffer, mimetype, originalName, folder }) {
  const kind = classify(mimetype);
  if (!kind) {
    const err = new Error('Unsupported file type');
    err.code = 'UNSUPPORTED_TYPE';
    throw err;
  }
  if (buffer.length > LIMITS[kind]) {
    const err = new Error(`${kind} files must be under ${(LIMITS[kind] / (1024 * 1024)).toFixed(0)}MB`);
    err.code = 'TOO_LARGE';
    throw err;
  }

  const ext = extFor(originalName);
  const id = crypto.randomUUID();
  const base = `${folder}/${id}`;

  if (kind === 'image') {
    const [display, thumb, lqip] = await Promise.all([
      buildDisplayImage(buffer, mimetype),
      buildThumb(buffer),
      buildLqip(buffer),
    ]);
    const url = await putObject(`${base}.jpg`, display.buffer, 'image/jpeg');
    const thumbUrl = await putObject(`${base}_thumb.jpg`, thumb, 'image/jpeg');
    return {
      url,
      thumbUrl,
      lqip,
      kind,
      name: originalName.slice(0, 150),
      size: display.buffer.length,
      mimetype: 'image/jpeg',
      width: display.width || null,
      height: display.height || null,
    };
  }

  // video / document: upload as-is (poster-frame thumbnail via ffmpeg is
  // out of scope here, same as before)
  const url = await putObject(`${base}${ext ? '.' + ext : ''}`, buffer, mimetype);
  return {
    url,
    thumbUrl: null,
    lqip: null,
    kind,
    name: originalName.slice(0, 150),
    size: buffer.length,
    mimetype,
    width: null,
    height: null,
  };
}

/** Chat attachment upload — unchanged public behavior, now backed by uploadMediaFile. */
async function uploadOne({ buffer, mimetype, originalName, roomId }) {
  return uploadMediaFile({ buffer, mimetype, originalName, folder: `chat/${roomId}` });
}

/** Upload 1+ files that belong to a single outgoing chat message. */
async function uploadAttachments(files, { roomId }) {
  const results = [];
  for (const f of files) {
    results.push(
      await uploadOne({
        buffer: f.buffer,
        mimetype: f.mimetype,
        originalName: f.originalname,
        roomId,
      })
    );
  }
  return results;
}

// Back-compat single-file helper (old route signature), now delegates to uploadOne.
async function uploadAttachment({ buffer, mimetype, originalName, roomId }) {
  return uploadOne({ buffer, mimetype, originalName, roomId });
}

/**
 * NEW — Upload a single post image/video to R2 under
 * `posts/{username}/{id}...`. Returns the same shape as a chat upload
 * (url, thumbUrl, lqip, width, height, etc.) so posts.js can build
 * Post.media[] entries directly from the result.
 */
async function uploadPostMedia({ buffer, mimetype, originalName, username }) {
  return uploadMediaFile({ buffer, mimetype, originalName, folder: `posts/${username}` });
}

/**
 * Uploads a profile avatar to R2 as a resized, square 512x512 JPEG under
 * `avatars/{userId}_v{version}.jpg`. Callers bump `version`
 * (SocialProfile.avatarVersion) *before* calling this, so the resulting
 * URL is unique per upload and safe to cache immutably forever.
 */
async function uploadAvatar(buffer, mimetype, userId, version) {
  const kind = classify(mimetype);
  if (kind !== 'image') {
    const err = new Error('Avatar must be an image (png, jpeg, gif, or webp)');
    err.code = 'UNSUPPORTED_TYPE';
    throw err;
  }
  if (buffer.length > LIMITS.image) {
    const err = new Error(`Images must be under ${(LIMITS.image / (1024 * 1024)).toFixed(0)}MB`);
    err.code = 'TOO_LARGE';
    throw err;
  }

  const square = await sharp(buffer, { failOn: 'none' })
    .rotate()
    .resize({ width: 512, height: 512, fit: 'cover' })
    .jpeg({ quality: 85 })
    .toBuffer();

  const key = `avatars/${userId}_v${version}.jpg`;
  return putObject(key, square, 'image/jpeg');
}

/** Wipes every object under chat/{roomId}/ — call this when a room is deleted. */
async function deleteRoomAttachments(roomId) {
  return deleteFolder(`chat/${roomId}/`);
}

/** NEW — wipes every object under posts/{username}/ (e.g. on account deletion). */
async function deleteUserPostMedia(username) {
  return deleteFolder(`posts/${username}/`);
}

/** Shared prefix-delete helper used by both cleanup functions above. */
async function deleteFolder(prefix) {
  let continuationToken;
  let deletedCount = 0;

  do {
    const listed = await s3.send(
      new ListObjectsV2Command({
        Bucket: BUCKET_NAME,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    );

    const objects = (listed.Contents || []).map((o) => ({ Key: o.Key }));
    if (objects.length) {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: BUCKET_NAME,
          Delete: { Objects: objects, Quiet: true },
        })
      );
      deletedCount += objects.length;
    }
    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (continuationToken);

  return deletedCount;
}

module.exports = {
  uploadAttachment,
  uploadAttachments,
  uploadAvatar,
  uploadPostMedia,      // NEW
  deleteRoomAttachments,
  deleteUserPostMedia,  // NEW
  LIMITS,
  ALLOWED_MIME,
  uploadOne,
};