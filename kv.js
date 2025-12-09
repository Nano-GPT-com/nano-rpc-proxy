const axios = require('axios');

const DEFAULT_TIMEOUT_MS = 10000;

const unwrap = (payload) => (payload && typeof payload === 'object' && 'result' in payload ? payload.result : payload);

const normalizeResultArray = (payload) => {
  const result = unwrap(payload);

  if (Array.isArray(result)) {
    return result;
  }

  return [];
};

class KvClient {
  constructor({ url, token, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    if (!url || !token) {
      throw new Error('KV_REST_API_URL and KV_REST_API_TOKEN are required for the watcher.');
    }

    this.url = url.replace(/\/+$/, '');
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  async request(path, { method = 'GET', data, params } = {}) {
    const headers = {
      Authorization: `Bearer ${this.token}`
    };

    if (data !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const response = await axios({
      method,
      url: `${this.url}/${path}`,
      headers,
      data,
      params,
      timeout: this.timeoutMs,
      validateStatus: () => true
    });

    if (response.status >= 400) {
      const err = new Error(`KV request failed: ${response.status} ${response.statusText}`);
      err.response = response;
      throw err;
    }

    return response.data;
  }

  async scan(pattern, count = 100, cursor = '0') {
    const data = await this.request(`scan/${cursor}`, {
      params: {
        match: pattern,
        count
      }
    });

    const [nextCursor = '0', keys = []] = normalizeResultArray(data);
    return { cursor: String(nextCursor), keys };
  }

  async hgetall(key) {
    const data = await this.request(`hgetall/${encodeURIComponent(key)}`);
    const raw = normalizeResultArray(data);

    if (!Array.isArray(raw) || raw.length === 0) {
      return {};
    }

    const obj = {};
    for (let i = 0; i < raw.length; i += 2) {
      const field = raw[i];
      const value = raw[i + 1];
      obj[field] = value;
    }
    return obj;
  }

  async hset(key, obj = {}) {
    const payload = [];
    for (const [field, value] of Object.entries(obj)) {
      payload.push(field, value);
    }

    return this.request(`hset/${encodeURIComponent(key)}`, {
      method: 'POST',
      data: JSON.stringify(payload)
    });
  }

  async expire(key, seconds) {
    return this.request(`expire/${encodeURIComponent(key)}/${seconds}`, { method: 'POST' });
  }

  async ttl(key) {
    const data = unwrap(await this.request(`ttl/${encodeURIComponent(key)}`));
    return typeof data === 'number' ? data : Number(data || -2);
  }

  async del(key) {
    return this.request(`del/${encodeURIComponent(key)}`, { method: 'POST' });
  }

  async set(key, value, { ttlSeconds } = {}) {
    const params = {};
    if (ttlSeconds && Number.isFinite(ttlSeconds)) {
      params.EX = ttlSeconds;
    }

    const stringValue = typeof value === 'string' ? value : JSON.stringify(value);
    const path = `set/${encodeURIComponent(key)}/${encodeURIComponent(stringValue)}`;

    return this.request(path, {
      method: 'POST',
      params
    });
  }

  async setJson(key, value, options = {}) {
    return this.set(key, JSON.stringify(value), options);
  }

  async getJson(key) {
    const raw = await this.get(key);
    if (!raw) return null;

    try {
      return JSON.parse(raw);
    } catch (error) {
      return null;
    }
  }

  async get(key) {
    const data = unwrap(await this.request(`get/${encodeURIComponent(key)}`));
    return data ?? null;
  }

  async exists(key) {
    const data = unwrap(await this.request(`exists/${encodeURIComponent(key)}`));
    return Number(data) === 1;
  }
}

module.exports = {
  KvClient
};
