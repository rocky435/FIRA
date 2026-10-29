/**
 * What actually leaves for the mail server. The ticket email's QR code showed as
 * an empty box (data: images are blocked by most mail apps), and the two venue
 * owner emails - new booking request, new event request - always failed because
 * their templates did not exist.
 */
import { describe, it, expect, beforeEach } from 'vitest';

const emailService = require('../services/emailService');

let sent: any[];
beforeEach(() => {
    sent = [];
    emailService.transporter = { sendMail: async (m: any) => { sent.push(m); return { messageId: 'x' }; } };
});

const event = { _id: 'e1', name: 'Neon Night', startDateTime: new Date('2026-11-20T14:00:00Z'), venue: { name: 'Lotus Hall' } };

describe('emails as sent', () => {
    it('the ticket QR code is attached inline and the email points at it', async () => {
        const ticket = { ticketId: 'TKT-1', qrCode: 'data:image/png;base64,iVBORw0KGgo=', ticketType: 'GA', quantity: 1 };
        expect(await emailService.sendTicketEmail('a@x.in', 'Asha', event, ticket)).toBe(true);
        const [mail] = sent;
        expect(mail.attachments).toHaveLength(1);
        expect(mail.attachments[0]).toMatchObject({ cid: 'ticket-qr-TKT-1@fira', encoding: 'base64', contentType: 'image/png', content: 'iVBORw0KGgo=' });
        expect(mail.html).toContain('src="cid:ticket-qr-TKT-1@fira"');
        expect(mail.html).not.toContain('data:image');
    });

    it('the venue owner gets the new booking request and new event request emails', async () => {
        expect(await emailService.sendVenueBookingEmail('o@x.in', 'Vik', { name: 'Lotus Hall' },
            { date: new Date('2026-11-20'), startTime: '10:00', endTime: '18:00', guestCount: 50, totalPrice: 20000 },
            { name: 'Gita', email: 'g@x.in' })).toBe(true);
        expect(await emailService.sendEventRequestEmail('o@x.in', 'Vik', { name: 'Lotus Hall' }, event, { name: 'Org', email: 'org@x.in' })).toBe(true);
        expect(sent).toHaveLength(2);
        expect(sent[0].html).toContain('New booking request');
        expect(sent[1].html).toContain('New event request');
    });

    it('every email uses the FIRA design', async () => {
        await emailService.sendPasswordResetEmail('a@x.in', '123456', 'Asha');
        await emailService.sendPasswordChangedEmail('a@x.in', 'Asha');
        await emailService.sendPayoutAccountChangedEmail('a@x.in', 'Asha', 'a new account');
        await emailService.sendBookingUpdateEmail('a@x.in', 'Asha', { subject: 's', heading: 'Booking accepted', lines: ['Pay to confirm.'], bookingId: 'b1' });
        await emailService.sendBalanceFinalNoticeEmail('a@x.in', 'Asha', { venueName: 'Lotus Hall', balanceAmount: 900, balanceDueAt: new Date(), bookingId: 'b1' });
        expect(sent).toHaveLength(5);
        for (const mail of sent) {
            expect(mail.html).toContain("Let's Celebrate");
            expect(mail.html).not.toContain('undefined');
        }
    });
});
