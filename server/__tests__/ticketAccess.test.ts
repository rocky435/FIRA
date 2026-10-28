/**
 * Access control on the ticket routes, and single-use check-in.
 *
 * The list, read, stats, validate and scan routes were public: anyone could pull
 * every buyer's name, email and QR code, or mark any ticket used. Check-in also
 * read-checked-then-saved, so one QR scanned at two gates at once admitted twice.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import express from 'express';
import jwt from 'jsonwebtoken';
import './setup';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
delete process.env.REDIS_HOST;

const Event = require('../models/Event');
const Ticket = require('../models/Ticket');
const ScanningCode = require('../models/ScanningCode');

let app: express.Express;
let holder: string, organizer: string, stranger: string, admin: string;
let eventId: mongoose.Types.ObjectId;
const tokens: Record<string, string> = {};

async function makeUser(name: string, role = 'user') {
    const _id = new mongoose.Types.ObjectId();
    await mongoose.connection.db!.collection('users').insertOne({
        _id, name, email: `${name}@x.test`, role, roles: [role],
    });
    const id = _id.toString();
    tokens[id] = jwt.sign({ userId: id, role }, process.env.JWT_SECRET!);
    return id;
}

const bearer = (id: string) => `Bearer ${tokens[id]}`;

async function makeTicket(ticketId = 'TKT-ABC123') {
    return Ticket.create({
        user: holder, event: eventId, ticketId, quantity: 1, ticketType: 'general',
        qrCode: 'data:image/png;base64,xyz', price: 0, status: 'active',
    });
}

beforeEach(async () => {
    holder = await makeUser('holder');
    organizer = await makeUser('organizer');
    stranger = await makeUser('stranger');
    admin = await makeUser('admin', 'admin');
    const ev = await Event.create({
        organizer, name: 'Gig', description: 'd', maxAttendees: 10, status: 'approved',
        startDateTime: new Date(Date.now() + 3600000), endDateTime: new Date(Date.now() + 7200000),
    });
    eventId = ev._id;

    app = express();
    app.use(express.json());
    const routes = await import('../routes/ticket');
    app.use('/tickets', (routes as any).default || routes);
    const scanRoutes = await import('../routes/scan');
    app.use('/scan', (scanRoutes as any).default || scanRoutes);
});

describe('reading tickets', () => {
    it('GET /tickets is admin-only', async () => {
        await makeTicket();
        expect((await request(app).get('/tickets')).status).toBe(401);
        expect((await request(app).get('/tickets').set('Authorization', bearer(stranger))).status).toBe(403);
        const ok = await request(app).get('/tickets').set('Authorization', bearer(admin));
        expect(ok.status).toBe(200);
        expect(ok.body.tickets.length).toBe(1);
    });

    it("GET /tickets/event/:id and its stats are the organizer's", async () => {
        await makeTicket();
        for (const path of [`/tickets/event/${eventId}`, `/tickets/event/${eventId}/stats`]) {
            expect((await request(app).get(path)).status).toBe(401);
            expect((await request(app).get(path).set('Authorization', bearer(stranger))).status).toBe(403);
            expect((await request(app).get(path).set('Authorization', bearer(holder))).status).toBe(403);
            expect((await request(app).get(path).set('Authorization', bearer(organizer))).status).toBe(200);
            expect((await request(app).get(path).set('Authorization', bearer(admin))).status).toBe(200);
        }
    });

    it('GET /tickets/:id is visible to the holder and organizer only', async () => {
        const t = await makeTicket();
        expect((await request(app).get(`/tickets/${t._id}`)).status).toBe(401);
        expect((await request(app).get(`/tickets/${t._id}`).set('Authorization', bearer(stranger))).status).toBe(403);
        const own = await request(app).get(`/tickets/${t._id}`).set('Authorization', bearer(holder));
        expect(own.status).toBe(200);
        expect(own.body.qrCode).toBeTruthy();
        expect((await request(app).get(`/tickets/${t._id}`).set('Authorization', bearer(organizer))).status).toBe(200);
    });
});

describe('checking tickets in', () => {
    it('POST /tickets/:id/validate refuses anyone but the organizer', async () => {
        const t = await makeTicket();
        expect((await request(app).post(`/tickets/${t._id}/validate`).send({})).status).toBe(401);
        expect((await request(app).post(`/tickets/${t._id}/validate`).set('Authorization', bearer(holder)).send({})).status).toBe(403);
        expect((await Ticket.findById(t._id).lean()).isUsed).toBe(false);
        const ok = await request(app).post(`/tickets/${t._id}/validate`).set('Authorization', bearer(organizer)).send({});
        expect(ok.status).toBe(200);
        expect((await Ticket.findById(t._id).lean()).isUsed).toBe(true);
    });

    it('POST /tickets/scan refuses anyone but the organizer and records the real scanner', async () => {
        await makeTicket();
        const qrData = JSON.stringify({ ticketId: 'TKT-ABC123' });
        expect((await request(app).post('/tickets/scan').send({ qrData, eventId: String(eventId) })).status).toBe(401);
        const spoof = await request(app).post('/tickets/scan').set('Authorization', bearer(stranger))
            .send({ qrData, eventId: String(eventId), scannerId: organizer });
        expect(spoof.status).toBe(403);
        expect((await Ticket.findOne({ ticketId: 'TKT-ABC123' }).lean()).isUsed).toBe(false);

        const ok = await request(app).post('/tickets/scan').set('Authorization', bearer(organizer))
            .send({ qrData, eventId: String(eventId), scannerId: 'spoofed' });
        expect(ok.status).toBe(200);
        expect(ok.body.success).toBe(true);
        expect(ok.body.ticket.user.name).toBe('holder');
        expect((await Ticket.findOne({ ticketId: 'TKT-ABC123' }).lean()).checkedInBy).toBe(organizer);
    });

    it('admits a ticket once when two organizer scanners scan it at the same moment', async () => {
        await makeTicket();
        const qrData = JSON.stringify({ ticketId: 'TKT-ABC123' });
        const scans = await Promise.all(Array.from({ length: 5 }, () =>
            request(app).post('/tickets/scan').set('Authorization', bearer(organizer))
                .send({ qrData, eventId: String(eventId) })));
        expect(scans.filter(r => r.status === 200).length).toBe(1);
        expect(scans.filter(r => r.status === 400).length).toBe(4);
    });

    it('admits a ticket once when two scanning-link doors scan it at the same moment', async () => {
        await makeTicket();
        await ScanningCode.create({ code: 'door-1', event: eventId, createdBy: organizer, label: 'Door', allTiers: true });
        const scans = await Promise.all(Array.from({ length: 5 }, () =>
            request(app).post('/scan/door-1/checkin').send({ ticketId: 'TKT-ABC123' })));
        expect(scans.filter(r => r.status === 200).length).toBe(1);
        expect(scans.filter(r => r.status === 400).length).toBe(4);
    });

    it('does not check in a cancelled ticket', async () => {
        const t = await makeTicket();
        await Ticket.updateOne({ _id: t._id }, { $set: { status: 'cancelled' } });
        const res = await request(app).post(`/tickets/${t._id}/validate`).set('Authorization', bearer(organizer)).send({});
        expect(res.status).toBe(400);
        expect((await Ticket.findById(t._id).lean()).isUsed).toBe(false);
    });
});
