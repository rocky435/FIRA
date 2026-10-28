/**
 * One-time migration for data saved before encryption at rest:
 *   1. encrypts bank account numbers and government ID numbers that are still
 *      plaintext (users and payouts);
 *   2. makes government ID documents uploaded as public images private.
 * Safe to run more than once: encrypted values and private documents are skipped.
 * Without ENCRYPTION_KEY only step 2 runs.
 *
 * Run on the server, with the production .env (ENCRYPTION_KEY, MONGODB_URI,
 * CLOUDINARY_*) in place:
 *   node scripts/encryptSensitiveFields.js --dry-run   # report only
 *   node scripts/encryptSensitiveFields.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const { seal, isSealed, hasEncryptionKey } = require('../utils/fieldEncryption');

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
    const encrypt = hasEncryptionKey();
    if (!encrypt) {
        console.warn('ENCRYPTION_KEY is not set - skipping encryption, only making ID documents private.');
    }
    await mongoose.connect(process.env.MONGODB_URI);
    const db = mongoose.connection.db;
    const counts = { users: 0, payouts: 0, documents: 0, documentErrors: 0 };

    // 1. Users: bank accounts, default account mirror, gov ID number.
    const users = db.collection('users').find(!encrypt ? { _id: null } : {
        $or: [
            { 'bankAccounts.accountNumber': { $exists: true } },
            { 'bankDetails.accountNumber': { $nin: [null, ''] } },
            { govIdNumber: { $nin: [null, ''] } },
        ],
    });
    for await (const user of users) {
        const $set = {};
        (user.bankAccounts || []).forEach((account, i) => {
            if (account.accountNumber && !isSealed(account.accountNumber)) {
                $set[`bankAccounts.${i}.accountNumber`] = seal(account.accountNumber);
            }
        });
        if (user.bankDetails?.accountNumber && !isSealed(user.bankDetails.accountNumber)) {
            $set['bankDetails.accountNumber'] = seal(user.bankDetails.accountNumber);
        }
        if (user.govIdNumber && !isSealed(user.govIdNumber)) {
            $set.govIdNumber = seal(user.govIdNumber);
        }
        if (Object.keys($set).length) {
            counts.users++;
            if (!DRY_RUN) await db.collection('users').updateOne({ _id: user._id }, { $set });
        }
    }

    // 2. Payouts: the account each payout went to.
    const payouts = db.collection('payouts').find(!encrypt ? { _id: null } : { 'bankDetails.accountNumber': { $nin: [null, ''] } });
    for await (const payout of payouts) {
        if (isSealed(payout.bankDetails.accountNumber)) continue;
        counts.payouts++;
        if (!DRY_RUN) {
            await db.collection('payouts').updateOne(
                { _id: payout._id },
                { $set: { 'bankDetails.accountNumber': seal(payout.bankDetails.accountNumber) } }
            );
        }
    }

    // 3. Government ID documents still stored as public images.
    const cloudinary = require('cloudinary').v2;
    cloudinary.config({
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key: process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET,
    });
    const owners = db.collection('users').find({ govIdDocument: { $regex: '/image/upload/' } });
    for await (const user of owners) {
        const match = user.govIdDocument.match(/\/image\/upload\/(?:v\d+\/)?(fira\/[^?#]+?)\.[a-z0-9]+(?:[?#].*)?$/i);
        if (!match) continue;
        counts.documents++;
        if (DRY_RUN) continue;
        try {
            const moved = await cloudinary.uploader.rename(match[1], match[1], {
                type: 'upload', to_type: 'authenticated', overwrite: true, resource_type: 'image',
            });
            await db.collection('users').updateOne({ _id: user._id }, { $set: { govIdDocument: moved.secure_url } });
        } catch (err) {
            counts.documentErrors++;
            console.error(`Could not make ${match[1]} private:`, err.message || err);
        }
    }

    console.log(`${DRY_RUN ? '[dry run] would update' : 'Updated'}: ${counts.users} users, ${counts.payouts} payouts, ${counts.documents} ID documents`
        + (counts.documentErrors ? ` (${counts.documentErrors} documents failed - see above)` : ''));
    await mongoose.disconnect();
}

main().catch(err => {
    console.error(err.message || err);
    process.exit(1);
});
