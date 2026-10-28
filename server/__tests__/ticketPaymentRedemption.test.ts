/**
 * Security regression — redeeming a paymentId for tickets.
 *
 * purchaseTicket used to skip payment for ANY supplied paymentId, and never
 * validated quantity. That let a buyer get paid tickets with a made-up id,
 * someone else's payment, a pending payment, one payment replayed for unlimited
 * orders, or a negative/fractional quantity that priced the order at ≤ ₹0.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

const ticketService = require('../services/ticketService');
const Event = require('../models/Event');
const User = require('../models/User');
const Payment = require('../models/Payment');
const Ticket = require('../models/Ticket');
require('../models/Venue');

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create({ instance: { launchTimeout: 60000 } });
  if (mongoose.connection.readyState === 0) await mongoose.connect(mongoServer.getUri());
}, 60000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  const collections = await mongoose.connection.db!.collections();
  for (const collection of collections) await collection.deleteMany({});
});

const future = (days: number) => new Date(Date.now() + days * 24 * 3600 * 1000);

async function makeUser() {
  return User.create({ email: `u_${Math.random().toString(36).slice(2)}@test.com`, password: 'x', name: 'Test User' });
}

async function makeEvent(organizerId: any, overrides: Record<string, any> = {}) {
  return Event.create({
    organizer: organizerId,
    name: 'Paid Event',
    description: 'desc',
    startDateTime: future(7),
    endDateTime: future(8),
    maxAttendees: 100,
    ticketPrice: 500,
    status: 'approved',
    eventType: 'public',
    ...overrides,
  });
}

// A payment as verifyPayment leaves it after a successful checkout.
async function makePayment(userId: any, eventId: any, overrides: Record<string, any> = {}) {
  return Payment.create({
    user: userId,
    type: 'ticket',
    referenceId: eventId,
    referenceModel: 'Event',
    amount: 529.5,
    subtotal: 500,
    totalAmount: 529.5,
    status: 'success',
    metadata: { quantity: 1, ticketType: 'general' },
    ...overrides,
  });
}

const redeem = (userId: any, eventId: any, paymentId: any, extra: Record<string, any> = {}) =>
  ticketService.purchaseTicket({ userId, eventId, quantity: 1, paymentId, ...extra });

describe('purchaseTicket — paymentId must be a real, unused payment for this order', () => {
  it('rejects a made-up paymentId', async () => {
    const buyer = await makeUser();
    const ev = await makeEvent((await makeUser())._id);

    await expect(redeem(buyer._id, ev._id, new mongoose.Types.ObjectId())).rejects.toThrow('could not be verified');
    expect(await Ticket.countDocuments()).toBe(0);
  });

  it("rejects someone else's successful payment", async () => {
    const victim = await makeUser();
    const attacker = await makeUser();
    const ev = await makeEvent((await makeUser())._id);
    const payment = await makePayment(victim._id, ev._id);

    await expect(redeem(attacker._id, ev._id, payment._id)).rejects.toThrow('could not be verified');
    expect(await Ticket.countDocuments()).toBe(0);
  });

  it('rejects a payment that never completed', async () => {
    const buyer = await makeUser();
    const ev = await makeEvent((await makeUser())._id);
    const payment = await makePayment(buyer._id, ev._id, { status: 'pending' });

    await expect(redeem(buyer._id, ev._id, payment._id)).rejects.toThrow('could not be verified');
  });

  it('rejects a payment made for a different event', async () => {
    const buyer = await makeUser();
    const org = await makeUser();
    const cheap = await makeEvent(org._id, { ticketPrice: 500 });
    const other = await makeEvent(org._id, { ticketPrice: 500, name: 'Other' });
    const payment = await makePayment(buyer._id, cheap._id);

    await expect(redeem(buyer._id, other._id, payment._id)).rejects.toThrow('could not be verified');
  });

  it('rejects redeeming a 1-ticket payment for more tickets', async () => {
    const buyer = await makeUser();
    const ev = await makeEvent((await makeUser())._id);
    const payment = await makePayment(buyer._id, ev._id);

    await expect(redeem(buyer._id, ev._id, payment._id, { quantity: 5 })).rejects.toThrow('different ticket selection');
  });

  // A replay by the buyer (an app retry, or the app redeeming after the Razorpay
  // webhook already did) gets the same ticket back - never a second one.
  it('issues once for a valid payment; a replay returns that same ticket', async () => {
    const buyer = await makeUser();
    const ev = await makeEvent((await makeUser())._id);
    const payment = await makePayment(buyer._id, ev._id);

    const result = await redeem(buyer._id, ev._id, payment._id);
    expect(result.success).toBe(true);
    expect(String(result.ticket.payment)).toBe(String(payment._id));

    const replay = await redeem(buyer._id, ev._id, payment._id);
    expect(String(replay.ticket._id)).toBe(String(result.ticket._id));
    expect(await Ticket.countDocuments()).toBe(1);
    expect((await Event.findById(ev._id)).currentAttendees).toBe(1);
  });

  it('issues exactly one order under concurrent replays of the same payment', async () => {
    const buyer = await makeUser();
    const ev = await makeEvent((await makeUser())._id);
    const payment = await makePayment(buyer._id, ev._id);

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => redeem(buyer._id, ev._id, payment._id))
    );
    const fulfilled = results.filter(r => r.status === 'fulfilled') as PromiseFulfilledResult<any>[];
    expect(new Set(fulfilled.map(r => String(r.value.ticket._id))).size).toBe(1);
    expect(await Ticket.countDocuments()).toBe(1);
    expect((await Event.findById(ev._id)).currentAttendees).toBe(1);
  });

  it('frees the payment for retry when the order fails after the claim', async () => {
    const buyer = await makeUser();
    const ev = await makeEvent((await makeUser())._id, { maxAttendees: 1, currentAttendees: 1 });
    const payment = await makePayment(buyer._id, ev._id);

    await expect(redeem(buyer._id, ev._id, payment._id)).rejects.toThrow('Not enough tickets');
    expect((await Payment.findById(payment._id)).consumedAt).toBeNull();
  });

  it("ignores a paymentId on a free event instead of consuming someone else's payment", async () => {
    const victim = await makeUser();
    const attacker = await makeUser();
    const org = await makeUser();
    const paid = await makeEvent(org._id);
    const free = await makeEvent(org._id, { ticketPrice: 0, name: 'Free' });
    const payment = await makePayment(victim._id, paid._id);

    const result = await redeem(attacker._id, free._id, payment._id);
    expect(result.ticket.payment).toBeNull();

    // The victim's payment is still redeemable by the victim.
    const own = await redeem(victim._id, paid._id, payment._id);
    expect(own.success).toBe(true);
  });
});

describe('purchaseTicket — quantity validation', () => {
  for (const quantity of [-5, 0, 0.5, 11, '2abc', null]) {
    it(`rejects quantity ${JSON.stringify(quantity)} without touching capacity`, async () => {
      const buyer = await makeUser();
      const ev = await makeEvent((await makeUser())._id);

      await expect(
        ticketService.purchaseTicket({ userId: buyer._id, eventId: ev._id, quantity })
      ).rejects.toThrow('Quantity must be a whole number');
      expect(await Ticket.countDocuments()).toBe(0);
      expect(await Payment.countDocuments()).toBe(0);
      expect((await Event.findById(ev._id)).currentAttendees).toBe(0);
    });
  }

  it('still issues a normal free ticket', async () => {
    const buyer = await makeUser();
    const ev = await makeEvent((await makeUser())._id, { ticketPrice: 0 });

    const result = await ticketService.purchaseTicket({ userId: buyer._id, eventId: ev._id, quantity: 2 });
    expect(result.success).toBe(true);
    expect((await Event.findById(ev._id)).currentAttendees).toBe(2);
  });
});
