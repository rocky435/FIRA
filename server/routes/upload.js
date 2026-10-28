const express = require('express');
const router = express.Router();
const { upload, uploadSingle, uploadMultiple, deleteImage, publicIdFromUrl } = require('../services/uploadService');
const auth = require('../middleware/auth');
const { hasRole } = require('../utils/roleUtils');
const { escapeRegex } = require('../utils/escapeRegex');

/*
 * Upload and delete were public: anyone could host files on our Cloudinary
 * account, or delete any image by its publicId. Both now need a session, and a
 * non-admin may only delete an image used by a venue or event they own.
 */

// Folders the client actually uploads into. Anything else lands in 'general'
// rather than letting a caller pick an arbitrary path in our Cloudinary account.
const ALLOWED_FOLDERS = new Set(['general', 'events', 'venues', 'brands', 'brand-posts', 'posts', 'gov-ids']);
const safeFolder = (folder) => (ALLOWED_FOLDERS.has(folder) ? folder : 'general');

/**
 * The URL of the image `publicId` names on a venue or event the user owns, or
 * null. Matched on the image URL, which ends in `/<publicId>.<ext>`.
 */
async function ownedImageUrl(userId, publicId) {
    const Venue = require('../models/Venue');
    const Event = require('../models/Event');
    const pattern = new RegExp(`/${escapeRegex(publicId)}\\.[a-z0-9]+$`, 'i');
    const [venue, event] = await Promise.all([
        Venue.findOne({ owner: userId, images: pattern }).select('images').lean(),
        Event.findOne({ organizer: userId, $or: [{ images: pattern }, { coverPhoto: pattern }] }).select('images coverPhoto').lean(),
    ]);
    const urls = [...(venue?.images || []), ...(event?.images || []), event?.coverPhoto].filter(Boolean);
    return urls.find(url => pattern.test(url)) || null;
}

// POST /api/upload/single - Upload single image
router.post('/single', auth, upload.single('image'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No image file provided' });
        }

        const folder = safeFolder(req.body.folder || 'general');
        const result = await uploadSingle(req.file, folder);

        res.json({
            success: true,
            url: result.url,
            publicId: result.publicId,
        });
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: error.message || 'Upload failed' });
    }
});

// POST /api/upload/multiple - Upload multiple images
router.post('/multiple', auth, upload.array('images', 5), async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: 'No image files provided' });
        }

        const folder = safeFolder(req.body.folder || 'general');
        const results = await uploadMultiple(req.files, folder);

        res.json({
            success: true,
            images: results,
        });
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: error.message || 'Upload failed' });
    }
});

// DELETE /api/upload/delete - Delete image from Cloudinary (owner of the listing using it, or admin)
router.delete('/delete', auth, async (req, res) => {
    try {
        const { publicId } = req.body;
        if (!publicId || typeof publicId !== 'string') {
            return res.status(400).json({ error: 'Public ID is required' });
        }
        const ownedUrl = await ownedImageUrl(req.user._id, publicId);
        if (!hasRole(req.user, 'admin') && !ownedUrl) {
            return res.status(403).json({ error: 'You can only delete images from your own listings' });
        }
        // The website sent "venues/abc" for an image stored as "fira/venues/abc",
        // so nothing was ever deleted. The real id comes from the stored URL.
        await deleteImage((ownedUrl && publicIdFromUrl(ownedUrl)) || publicId);
        res.json({ success: true, message: 'Image deleted successfully' });
    } catch (error) {
        console.error('Delete error:', error);
        res.status(500).json({ error: error.message || 'Delete failed' });
    }
});

module.exports = router;
