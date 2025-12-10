#!/usr/bin/env node

const { KvClient } = require('../kv');
const { loadWatcherConfig } = require('../watcher-config');
const { readStatus } = require('../deposits');

const main = async () => {
  const config = loadWatcherConfig();

  if (!config.kvReady) {
    throw new Error('KV_REST_API_URL and KV_REST_API_TOKEN must be set to run backfill.');
  }

  if (!config.tickers || config.tickers.length === 0) {
    console.log('No tickers configured; nothing to backfill.');
    return;
  }

  const kv = new KvClient({ url: config.kvUrl, token: config.kvToken });
  const scanCount = config.scanCount || 100;
  let checked = 0;
  let updated = 0;
  let missing = 0;

  for (const ticker of config.tickers) {
    let cursor = '0';
    const pattern = `${config.keyPrefix}:deposit:${ticker}:*`;
    console.log(`Scanning jobs for ${ticker} with pattern ${pattern}`);

    do {
      const { cursor: nextCursor, keys } = await kv.scan(pattern, scanCount, cursor);
      for (const key of keys) {
        checked += 1;
        const job = await kv.hgetall(key);
        const txId = job?.txId;

        if (!job || !txId) continue;
        if (job.paymentId) continue;

        const status = await readStatus(kv, ticker, txId, config.keyPrefix);
        const paymentId = status?.paymentId || '';

        if (paymentId) {
          await kv.hset(key, { paymentId });
          updated += 1;
          console.log(`Backfilled paymentId for ${key}`, { txId, paymentId });
        } else {
          missing += 1;
          console.log(`No paymentId available for ${key}`, { txId });
        }
      }
      cursor = nextCursor;
    } while (cursor !== '0');
  }

  console.log('Backfill complete', { checked, updated, missing });
};

main().catch((err) => {
  console.error('Backfill failed', err);
  process.exit(1);
});
