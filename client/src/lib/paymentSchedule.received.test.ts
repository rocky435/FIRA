import { describe, it, expect } from 'vitest';
import { amountReceived } from './paymentSchedule';

const installment = (balanceStatus: 'pending' | 'paid') => ({
    type: 'installment' as const, depositAmount: 200, balanceAmount: 1800, balanceDueAt: null, balanceStatus,
});

describe('amountReceived', () => {
    it('is nothing while a booking is only accepted, not paid', () => {
        expect(amountReceived({ paymentStatus: 'pending', totalAmount: 2000, paymentSchedule: installment('pending') })).toBe(0);
    });

    it('is the advance once paid, and the whole amount once the rest is paid too', () => {
        expect(amountReceived({ paymentStatus: 'paid', totalAmount: 2000, paymentSchedule: installment('pending') })).toBe(200);
        expect(amountReceived({ paymentStatus: 'paid', totalAmount: 2000, paymentSchedule: installment('paid') })).toBe(2000);
    });

    it('is the total for a booking paid in full', () => {
        expect(amountReceived({ paymentStatus: 'paid', totalAmount: 1000, paymentSchedule: { type: 'full', depositAmount: 1000 } })).toBe(1000);
        expect(amountReceived({ paymentStatus: 'paid', totalAmount: 1000 })).toBe(1000);
    });
});
