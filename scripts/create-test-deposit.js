#!/usr/bin/env node

/**
 * Create a test deposit job in Redis (Upstash) for the watcher.
 *
 * Env:
 *   KV_REST_API_URL
 *   KV_REST_API_TOKEN
 *   TICKER=zano|fusd
 *   ADDRESS=<deposit address>
 *   TXID=<unique id or known tx hash>
 *   JOB_ID=<optional, defaults to TXID>
 *   EXPECTED_AMOUNT=<optional decimal string>
 *   MIN_CONF=<optional int>
 *   SESSION_ID=<optional>
 */

const fetch = require('node-fetch');

const {
  KV_REST_API_URL,
  KV_REST_API_TOKEN,
  WATCHER_KEY_PREFIX = 'zano',
  TICKER = 'zano',
  ADDRESS,
  TXID,
  JOB_ID,
  EXPECTED_AMOUNT,
  MIN_CONF,
  SESSION_ID
} = process.env;

if (!KV_REST_API_URL || !KV_REST_API_TOKEN) {
  console.error('KV_REST_API_URL and KV_REST_API_TOKEN are required');
  process.exit(1);
}
if (!ADDRESS || !TXID) {
  console.error('ADDRESS and TXID are required');
  process.exit(1);
}

const jobId = JOB_ID || TXID;
const key = `${WATCHER_KEY_PREFIX}:deposit:${TICKER}:${jobId}`;

const value = {
  address: ADDRESS,
  txId: TXID,
  jobId,
  expectedAmount: EXPECTED_AMOUNT,
  minConf: MIN_CONF ? Number(MIN_CONF) : undefined,
  sessionId: SESSION_ID,
  createdAt: new Date().toISOString()
};

async function main() {
  const res = await fetch(`${KV_REST_API_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${KV_REST_API_TOKEN}`
    }
  });

  if (!res.ok) {
    const txt = await res.text();
    console.error('Failed to set key:', res.status, txt);
    process.exit(1);
  }

  console.log(`Set ${key}`);
  console.log(JSON.stringify(value, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
