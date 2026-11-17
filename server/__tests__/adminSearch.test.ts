/**
 * The admin's universal search: one box that finds people (by name, email or
 * phone), events, venues and creators. Moderators cannot open user accounts,
 * so people are left out of their results.
 */
import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import './setup';

const adminService = require('../services/adminService');

const db = () => mongoose.connection.db!;
const oid = () => new mongoose.Types.ObjectId();

async function seed() {
    const priya = oid();
    await db().collection('users').insertMany([
        { _id: priya, name: 'Priya Lotus', email: 'priya@x.test', phone: '9876500001' },
        { _id: oid(), name: 'Ravi', email: 'ravi@x.test', phone: '9876500002' },
    ]);
    await db().collection('events').insertMany([
        { _id: oid(), name: 'Lotus Jazz Night', status: 'approved', startDateTime: new Date() },
        { _id: oid(), name: 'Gone Lotus', status: 'approved', isDeleted: true },
    ]);
    await db().collection('venues').insertMany([
        { _id: oid(), name: 'Lotus Hall', status: 'approved', address: { city: 'Indore' } },
        { _id: oid(), name: 'Garden', status: 'approved', address: { city: 'Lotusnagar' } },
    ]);
    await db().collection('brandprofiles').insertOne({ _id: oid(), user: priya, name: 'Lotus Beats', type: 'band', status: 'approved' });
}

describe('admin universal search', () => {
    it('finds people, events, venues and creators in one go', async () => {
        await seed();
        const r = await adminService.search('lotus', 'super_admin');
        expect(r.users.map((u: any) => u.name)).toEqual(['Priya Lotus']);
        expect(r.events.map((e: any) => e.name)).toEqual(['Lotus Jazz Night']); // deleted one left out
        expect(r.venues.map((v: any) => v.name).sort()).toEqual(['Garden', 'Lotus Hall']); // name or city
        expect(r.brands.map((b: any) => b.name)).toEqual(['Lotus Beats']);
    });

    it('finds a person by phone number', async () => {
        await seed();
        const r = await adminService.search('500002', 'admin');
        expect(r.users.map((u: any) => u.name)).toEqual(['Ravi']);
    });

    it('leaves people out for moderators', async () => {
        await seed();
        const r = await adminService.search('lotus', 'moderator');
        expect(r.users).toEqual([]);
        expect(r.events).toHaveLength(1);
    });

    it('needs at least two characters', async () => {
        await seed();
        const r = await adminService.search('l', 'admin');
        expect(r).toEqual({ users: [], events: [], venues: [], brands: [] });
    });
});

describe('Users page search', () => {
    it('matches phone numbers as well as name and email', async () => {
        await seed();
        const { users } = await adminService.getAllUsers({ search: '500001' });
        expect(users.map((u: any) => u.name)).toEqual(['Priya Lotus']);
    });
});
