#!/usr/bin/env node

/**
 * Lightweight sanity tests for the /zano endpoint.
 * Requires the proxy to be running locally (or reachable) and Zano RPC available.
 *
 * Env vars:
 * - ZANO_TEST_URL: override target URL (default http://localhost:3000/zano)
 * - ZANO_TEST_API_KEY: API key for Zano endpoint (falls back to ZANO_API_KEY or API_KEY)
 */

const axios = require('axios');

const TARGET = process.env.ZANO_TEST_URL || 'http://localhost:3000/zano';
const API_KEY = (process.env.ZANO_TEST_API_KEY || process.env.ZANO_API_KEY || process.env.API_KEY || '').trim();
const REQUIRE_API_KEY = true;

const results = [];

const record = (name, ok, info = '') => {
  results.push({ name, ok, info });
  const icon = ok ? '✅' : '❌';
  console.log(`${icon} ${name}${info ? ` - ${info}` : ''}`);
};

const post = async (body, includeKey = true) => {
  const headers = { 'Content-Type': 'application/json' };
  if (includeKey && API_KEY) {
    headers['X-API-Key'] = API_KEY;
  }
  return axios.post(TARGET, body, { headers, validateStatus: () => true, timeout: 10000 });
};

const testMissingKey = async () => {
  if (!REQUIRE_API_KEY) {
    record('Missing API key blocked', true, 'skipped (API key not required)');
    return;
  }

  const res = await post({ jsonrpc: '2.0', id: 1, method: 'get_info', params: {} }, false);
  const ok = res.status === 401;
  record('Missing API key blocked', ok, `status=${res.status}`);
};

const testBlockedMethod = async () => {
  if (!API_KEY && REQUIRE_API_KEY) {
    record('Blocked method denied', false, 'no API key configured for test');
    return;
  }

  const res = await post({ jsonrpc: '2.0', id: 2, method: 'stop_daemon', params: {} });
  const ok = res.status === 403;
  record('Non-allowlisted method blocked', ok, `status=${res.status}`);
};

const testAllowedMethod = async () => {
  if (!API_KEY && REQUIRE_API_KEY) {
    record('Allowed method succeeds', false, 'no API key configured for test');
    return;
  }

  const res = await post({ jsonrpc: '2.0', id: 3, method: 'make_integrated_address', params: {} });
  const ok = res.status === 200 && res.data && !res.data.error;
  record('Allowed method succeeds', ok, `status=${res.status}`);
};

(async () => {
console.log(`Target: ${TARGET}`);
console.log(`API key provided: ${API_KEY ? 'yes' : 'no'}`);
console.log('Require API key: true');
  console.log('---');

  try {
    await testMissingKey();
    await testBlockedMethod();
    await testAllowedMethod();
  } catch (err) {
    record('Unexpected error', false, err.message);
  }

  const passed = results.filter(r => r.ok).length;
  const total = results.length;
  console.log('---');
  console.log(`Summary: ${passed}/${total} passed`);
  process.exitCode = passed === total ? 0 : 1;
})();
