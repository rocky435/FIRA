/**
 * Under PM2 cluster mode every instance used to schedule every job, so each
 * reminder went out once per instance. Only instance 0 schedules them now.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const cron = require('node-cron');
const { initScheduledJobs } = require('../../jobs/scheduledJobs');

describe('initScheduledJobs', () => {
    const original = process.env.NODE_APP_INSTANCE;
    afterEach(() => {
        vi.restoreAllMocks();
        if (original === undefined) delete process.env.NODE_APP_INSTANCE;
        else process.env.NODE_APP_INSTANCE = original;
    });

    it('schedules nothing on a PM2 instance other than 0', () => {
        const schedule = vi.spyOn(cron, 'schedule').mockImplementation(() => ({}) as any);
        process.env.NODE_APP_INSTANCE = '1';
        initScheduledJobs();
        expect(schedule).not.toHaveBeenCalled();
    });
});
