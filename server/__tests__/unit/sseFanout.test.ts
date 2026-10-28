/**
 * Live updates across server instances.
 *
 * Under PM2 cluster mode a user's stream lives on one instance; an event raised
 * on the other never reached them. send() now goes through a Redis channel that
 * every instance relays from. Two copies of lib/sse stand in for two instances,
 * sharing an in-memory stand-in for Redis pub/sub.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'events';

const redisConfig = require('../../config/redis');
const realGetClient = redisConfig.getRedisClient;
const realAvailable = redisConfig.isRedisAvailable;

/** Minimal publish/subscribe double for an ioredis client. */
function fakeRedis() {
    const bus = new EventEmitter();
    return {
        publish: async (channel: string, message: string) => { bus.emit('msg', channel, message); return 1; },
        duplicate: () => {
            const sub: any = new EventEmitter();
            sub.subscribe = async (channel: string) => {
                bus.on('msg', (ch: string, msg: string) => { if (ch === channel) sub.emit('message', ch, msg); });
            };
            return sub;
        },
    };
}

/** A fresh copy of lib/sse - what a separate PM2 instance would load. */
function loadInstance() {
    const path = require.resolve('../../lib/sse');
    delete require.cache[path];
    return require(path);
}

function fakeResponse() {
    const frames: string[] = [];
    return { frames, writeHead() {}, write(chunk: string) { frames.push(chunk); } };
}

const flush = () => new Promise(r => setImmediate(r));
const teardowns: Array<() => void> = [];

afterEach(() => {
    teardowns.splice(0).forEach(fn => fn());
    redisConfig.getRedisClient = realGetClient;
    redisConfig.isRedisAvailable = realAvailable;
});

describe('sse.send', () => {
    it('reaches a user connected to a different instance when Redis is up', async () => {
        const redis = fakeRedis();
        redisConfig.getRedisClient = () => redis;
        redisConfig.isRedisAvailable = () => true;

        const instanceA = loadInstance();
        const instanceB = loadInstance();
        const res = fakeResponse();
        teardowns.push(instanceA.register('user-1', res));
        await flush();

        instanceB.send('user-1', { type: 'message:new', text: 'hi' });
        await flush();

        const data = res.frames.filter(f => f.startsWith('data:'));
        expect(data).toEqual([`data: ${JSON.stringify({ type: 'message:new', text: 'hi' })}\n\n`]);
    });

    it('delivers in-process when Redis is not available', async () => {
        redisConfig.getRedisClient = () => null;
        redisConfig.isRedisAvailable = () => false;

        const instance = loadInstance();
        const res = fakeResponse();
        teardowns.push(instance.register('user-2', res));
        instance.send('user-2', { type: 'notification' });

        expect(res.frames.filter(f => f.startsWith('data:')).length).toBe(1);
    });
});
