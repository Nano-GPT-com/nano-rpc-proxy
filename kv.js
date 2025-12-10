const { Redis } = require('@upstash/redis');

class KvClient {
  constructor({ url, token }) {
    if (!url || !token) {
      throw new Error('KV_REST_API_URL and KV_REST_API_TOKEN are required for the watcher.');
    }
    this.redis = new Redis({ url, token });
  }

  async scan(pattern, count = 100, cursor = '0') {
    const [nextCursor, keys] = await this.redis.scan(cursor, { match: pattern, count });
    return { cursor: String(nextCursor), keys: keys || [] };
  }

  async hgetall(key) {
    const data = await this.redis.hgetall(key);
    return data || {};
  }

  async hset(key, obj = {}) {
    if (!obj || Object.keys(obj).length === 0) return;
    return this.redis.hset(key, obj);
  }

  async expire(key, seconds) {
    return this.redis.expire(key, seconds);
  }

  async ttl(key) {
    const t = await this.redis.ttl(key);
    return typeof t === 'number' ? t : Number(t || -2);
  }

  async del(key) {
    return this.redis.del(key);
  }

  async set(key, value, { ttlSeconds } = {}) {
    const expiresIn = ttlSeconds && Number.isFinite(ttlSeconds) ? ttlSeconds : undefined;
    const stringValue = typeof value === 'string' ? value : JSON.stringify(value);
    if (expiresIn) {
      return this.redis.set(key, stringValue, { ex: expiresIn });
    }
    return this.redis.set(key, stringValue);
  }

  async setJson(key, value, options = {}) {
    return this.set(key, JSON.stringify(value), options);
  }

  async getJson(key) {
    const raw = await this.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  async get(key) {
    return this.redis.get(key);
  }

  async exists(key) {
    const exists = await this.redis.exists(key);
    return Number(exists) === 1;
  }
}

module.exports = {
  KvClient
};
