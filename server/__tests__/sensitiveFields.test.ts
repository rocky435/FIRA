/**
 * Bank account and government ID numbers are encrypted in the database and
 * read back as plaintext everywhere the app uses them: documents, lean
 * queries, JSON responses, populated owners. Values saved before encryption
 * (plaintext) still read correctly.
 */
import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import './setup';

// Encryption is on only when a key is set.
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'b'.repeat(64);

// Signing an expiring document link needs Cloudinary credentials (dummy here).
process.env.CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || 'demo';
process.env.CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY || '123';
process.env.CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET || 'secret';

const User = require('../models/User');
const Venue = require('../models/Venue');
const Payout = require('../models/Payout');
const { isSealed } = require('../utils/fieldEncryption');
const { publicIdFromUrl, privateDocumentLink } = require('../services/uploadService');

const raw = (collection: string, _id: any) => mongoose.connection.db!.collection(collection).findOne({ _id });

async function owner() {
    return User.create({
        name: 'Owner', email: `o${Date.now()}${Math.random()}@x.test`, password: 'x'.repeat(10),
        govIdType: 'pan', govIdNumber: 'ABCDE1234F',
        bankAccounts: [{ accountName: 'O', accountNumber: '123456789012', ifscCode: 'HDFC0001234', bankName: 'HDFC', isDefault: true }],
        bankDetails: { accountName: 'O', accountNumber: '123456789012', ifscCode: 'HDFC0001234', bankName: 'HDFC' },
    });
}

describe('sensitive fields are encrypted at rest', () => {
    it('stores ciphertext, never the numbers', async () => {
        const u = await owner();
        const stored: any = await raw('users', u._id);
        expect(isSealed(stored.govIdNumber)).toBe(true);
        expect(isSealed(stored.bankDetails.accountNumber)).toBe(true);
        expect(isSealed(stored.bankAccounts[0].accountNumber)).toBe(true);
        expect(JSON.stringify(stored)).not.toContain('123456789012');
        expect(JSON.stringify(stored)).not.toContain('ABCDE1234F');
    });

    it('reads back as plaintext from documents, lean queries, JSON and populated owners', async () => {
        const u = await owner();
        const doc = await User.findById(u._id);
        expect(doc.govIdNumber).toBe('ABCDE1234F');
        expect(doc.bankAccounts[0].accountNumber).toBe('123456789012');
        expect(JSON.parse(JSON.stringify(doc)).bankDetails.accountNumber).toBe('123456789012');
        expect(doc.toObject().bankAccounts[0].accountNumber).toBe('123456789012');

        const lean = await User.findById(u._id).lean();
        expect(lean.bankDetails.accountNumber).toBe('123456789012');
        expect(lean.bankAccounts[0].accountNumber).toBe('123456789012');
        const many = await User.find({ _id: u._id }).lean();
        expect(many[0].govIdNumber).toBe('ABCDE1234F');

        const venue = await Venue.create({ owner: u._id, name: 'V', description: 'd', capacity: { max: 10 },
            pricing: { basePrice: 100, pricePerDay: 100 }, address: { street: 's', city: 'c', state: 's', pincode: '500001' } });
        const populated = await Venue.findById(venue._id).populate('owner', 'name bankDetails');
        expect(JSON.parse(JSON.stringify(populated)).owner.bankDetails.accountNumber).toBe('123456789012');
        const populatedLean = await Venue.findById(venue._id).populate('owner', 'name bankDetails').lean();
        expect(populatedLean.owner.bankDetails.accountNumber).toBe('123456789012');
    });

    it('still reads values saved before encryption', async () => {
        const _id = new mongoose.Types.ObjectId();
        await mongoose.connection.db!.collection('users').insertOne({ _id, name: 'Old', email: 'old@x.test',
            bankDetails: { accountNumber: '999988887777' }, govIdNumber: 'OLD123' });
        const lean = await User.findById(_id).lean();
        expect(lean.bankDetails.accountNumber).toBe('999988887777');
        expect((await User.findById(_id)).govIdNumber).toBe('OLD123');
    });

    it('encrypts the account a payout was sent to', async () => {
        const p = await Payout.create({
            recipient: new mongoose.Types.ObjectId(), type: 'venue_booking', referenceId: new mongoose.Types.ObjectId(),
            referenceModel: 'Booking', grossAmount: 100, platformCommission: 5, netAmount: 95,
            bankDetails: { accountName: 'O', accountNumber: '123456789012', ifscCode: 'HDFC0001234', bankName: 'HDFC' },
        });
        expect(isSealed((await raw('payouts', p._id) as any).bankDetails.accountNumber)).toBe(true);
        expect((await Payout.findById(p._id).lean()).bankDetails.accountNumber).toBe('123456789012');
    });

    it('stores plaintext when no key is set (encryption is optional)', async () => {
        const saved = process.env.ENCRYPTION_KEY;
        delete process.env.ENCRYPTION_KEY;
        try {
            const u = await owner();
            const stored: any = await raw('users', u._id);
            expect(stored.govIdNumber).toBe('ABCDE1234F');
            expect((await User.findById(u._id)).govIdNumber).toBe('ABCDE1234F');
        } finally {
            process.env.ENCRYPTION_KEY = saved;
        }
    });
});

describe('uploaded images', () => {
    it('finds the real storage id of an image from its URL', () => {
        expect(publicIdFromUrl('https://res.cloudinary.com/x/image/upload/v1700/fira/venues/abc_1.jpg')).toBe('fira/venues/abc_1');
        expect(publicIdFromUrl('https://example.com/a.jpg')).toBeNull();
    });

    it('gives a private ID document out only as an expiring link', () => {
        const link = privateDocumentLink('https://res.cloudinary.com/x/image/authenticated/s--abc--/v1700/fira/gov-ids/doc1.jpg');
        expect(link).toContain('expires_at=');
        expect(link).not.toContain('/image/authenticated/');
    });
});
