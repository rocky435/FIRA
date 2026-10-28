/**
 * Encryption at rest for sensitive fields (bank account numbers, government ID
 * numbers). A field is stored as "enc:v1:<iv>:<tag>:<ciphertext>" (AES-256-GCM),
 * so a leaked database dump or backup does not leak the numbers.
 *
 * `encryptFields(schema, paths)` makes it transparent to the app:
 *   - writing the field encrypts it (a setter);
 *   - reading it from a document, or from its toJSON/toObject, decrypts it;
 *   - lean queries are decrypted in a post-query hook.
 * Values written before this existed are plaintext and read back unchanged;
 * scripts/encryptSensitiveFields.js encrypts them in place.
 *
 * The key is ENCRYPTION_KEY: 64 hex characters (32 bytes). It is optional:
 * without it values are stored as plaintext (index.js logs a warning). Once it
 * is set, new values are encrypted and the script above encrypts the rest.
 * Losing it makes encrypted fields unreadable, so it must be backed up with
 * the other secrets.
 */
const crypto = require('crypto');

const PREFIX = 'enc:v1:';
const ALGORITHM = 'aes-256-gcm';

let cachedKey = null;

function key() {
    if (cachedKey) return cachedKey;
    if (!hasEncryptionKey()) throw new Error('ENCRYPTION_KEY is not set');
    cachedKey = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
    return cachedKey;
}

/** Whether ENCRYPTION_KEY is set and well-formed. */
function hasEncryptionKey() {
    return /^[0-9a-fA-F]{64}$/.test(process.env.ENCRYPTION_KEY || '');
}

/** Encrypt a string for storage. Empty, null and already-encrypted values pass through, as does everything without a key. */
function seal(value) {
    if (typeof value !== 'string' || value === '' || value.startsWith(PREFIX)) return value;
    if (!hasEncryptionKey()) return value;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGORITHM, key(), iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return PREFIX + [iv, cipher.getAuthTag(), ciphertext].map(b => b.toString('base64')).join(':');
}

/** Decrypt a stored value. Plaintext (written before encryption) passes through. */
function open(value) {
    if (typeof value !== 'string' || !value.startsWith(PREFIX)) return value;
    try {
        const [iv, tag, ciphertext] = value.slice(PREFIX.length).split(':').map(part => Buffer.from(part, 'base64'));
        const decipher = crypto.createDecipheriv(ALGORITHM, key(), iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch (err) {
        console.error('Could not decrypt a stored field (wrong ENCRYPTION_KEY?):', err.message);
        return null;
    }
}

/** Whether a stored value is encrypted. */
function isSealed(value) {
    return typeof value === 'string' && value.startsWith(PREFIX);
}

/** Apply `fn` to the value at a dotted path in a plain object, through arrays. */
function mapPath(obj, segments, fn) {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
        obj.forEach(item => mapPath(item, segments, fn));
        return;
    }
    const [head, ...rest] = segments;
    if (!(head in obj)) return;
    if (rest.length === 0) obj[head] = fn(obj[head]);
    else mapPath(obj[head], rest, fn);
}

/**
 * Encrypt these paths of `schema` at rest. A path inside an array of
 * subdocuments is written "bankAccounts.accountNumber".
 *
 * @param {import('mongoose').Schema} schema
 * @param {string[]} paths
 */
function encryptFields(schema, paths) {
    for (const path of paths) {
        let owner = schema;
        let local = path;
        const [first, ...rest] = path.split('.');
        const arrayPath = schema.path(first);
        if (rest.length && arrayPath && arrayPath.schema) {
            owner = arrayPath.schema;
            local = rest.join('.');
        }
        const schemaType = owner.path(local);
        if (!schemaType) throw new Error(`encryptFields: no path ${path}`);
        schemaType.set(seal);
        schemaType.get(open);
        // Decrypt in toJSON/toObject too (path getters only, no `id` virtual).
        for (const s of new Set([schema, owner])) {
            s.set('toJSON', { ...(s.get('toJSON') || {}), getters: true, virtuals: false });
            s.set('toObject', { ...(s.get('toObject') || {}), getters: true, virtuals: false });
        }
    }

    // Lean queries skip getters, so decrypt their plain results here.
    schema.post(['find', 'findOne', 'findOneAndUpdate', 'findOneAndDelete', 'findOneAndReplace'], function decryptLean(result) {
        if (!result || !this.mongooseOptions().lean) return;
        for (const path of paths) mapPath(result, path.split('.'), open);
    });
}

module.exports = { encryptFields, seal, open, isSealed, hasEncryptionKey, PREFIX };
