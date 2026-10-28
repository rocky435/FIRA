const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const { Readable } = require('stream');

// Configure Cloudinary
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// Multer memory storage (files stored in buffer)
const storage = multer.memoryStorage();
const upload = multer({
    storage,
    limits: {
        fileSize: 10 * 1024 * 1024, // 10MB limit
    },
    fileFilter: (req, file, cb) => {
        // Accept images only
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are allowed!'), false);
        }
    }
});

// Folders whose files are private: stored as Cloudinary "authenticated"
// assets, which cannot be opened from their URL. Government ID documents used
// to be ordinary public images - anyone with the link could see them.
const PRIVATE_FOLDERS = new Set(['gov-ids']);

// Upload buffer to Cloudinary
const uploadToCloudinary = (buffer, folder = 'events') => {
    return new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
            {
                folder: `fira/${folder}`,
                resource_type: 'image',
                type: PRIVATE_FOLDERS.has(folder) ? 'authenticated' : 'upload',
            },
            (error, result) => {
                if (error) reject(error);
                else resolve(result);
            }
        );

        // Create readable stream from buffer
        const readableStream = new Readable();
        readableStream.push(buffer);
        readableStream.push(null);
        readableStream.pipe(uploadStream);
    });
};

// Upload single image
const uploadSingle = async (file, folder = 'events') => {
    const result = await uploadToCloudinary(file.buffer, folder);
    return {
        url: result.secure_url,
        publicId: result.public_id,
    };
};

// Upload multiple images
const uploadMultiple = async (files, folder = 'events') => {
    const uploadPromises = files.map(file => uploadToCloudinary(file.buffer, folder));
    const results = await Promise.all(uploadPromises);

    return results.map(result => ({
        url: result.secure_url,
        publicId: result.public_id,
    }));
};

// Delete image from Cloudinary
const deleteImage = async (publicId) => {
    try {
        await cloudinary.uploader.destroy(publicId);
        return { success: true };
    } catch (error) {
        console.error('Error deleting image:', error);
        throw error;
    }
};

/**
 * The Cloudinary public id inside one of our image URLs:
 * ".../image/upload/v123/fira/venues/abc.jpg" -> "fira/venues/abc". Null for any
 * other URL (an outside link, a seed image), which is never ours to delete.
 */
const publicIdFromUrl = (url) => {
    const match = typeof url === 'string' && url.match(/\/image\/upload\/(?:v\d+\/)?(fira\/[^?#]+?)\.[a-z0-9]+(?:[?#].*)?$/i);
    return match ? match[1] : null;
};

/**
 * Delete from Cloudinary the images a listing had before an edit and no longer
 * has after it. Runs in the background and never fails the edit: an image that
 * cannot be deleted only costs storage.
 */
/**
 * A link that opens a private document for 10 minutes, for an admin checking
 * it. `url` is what was stored at upload. A document uploaded before uploads
 * became private is still a public URL and is returned as it is (run
 * scripts/encryptSensitiveFields.js to make those private too).
 */
const privateDocumentLink = (url) => {
    if (typeof url !== 'string') return null;
    const match = url.match(/\/image\/authenticated\/(?:s--[^/]+--\/)?(?:v\d+\/)?(fira\/[^?#]+?)\.([a-z0-9]+)(?:[?#].*)?$/i);
    if (!match) return url;
    return cloudinary.utils.private_download_url(match[1], match[2], {
        type: 'authenticated',
        resource_type: 'image',
        expires_at: Math.floor(Date.now() / 1000) + 10 * 60,
    });
};

const deleteRemovedImages = (before = [], after = []) => {
    const kept = new Set((after || []).filter(Boolean));
    for (const url of new Set((before || []).filter(Boolean))) {
        if (kept.has(url)) continue;
        const publicId = publicIdFromUrl(url);
        if (publicId) {
            deleteImage(publicId).catch(err => console.error(`Could not delete image ${publicId}:`, err.message));
        }
    }
};

module.exports = {
    upload,
    uploadSingle,
    uploadMultiple,
    deleteImage,
    publicIdFromUrl,
    deleteRemovedImages,
    privateDocumentLink,
};
