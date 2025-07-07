#!/usr/bin/env node

const https = require('https');
const fs = require('fs');

const RPC_URL = 'https://node.somenano.com/proxy';

// Well-known test data for RPC calls
const TEST_DATA = {
  account: 'nano_1ipx847tk8o46pwxt5qjdbncjqcbwcc1rrmqnkztrfjy5k7z4imsrata9est', // Known account with history
  genesis_account: 'nano_3t6k35gi95xu6tergt6p69ck76ogmitsa8mnijtpxm9fkcm736xtoncuohr3', // Genesis account
  block_hash: '991CF190094C00F0B68E2E5F75F6BEE95A2E0BD93CEAA4A6734DB9F19B728948', // Known block hash
  genesis_block: 'E89208DD038FBB269987689621D52292AE9C35941A7484756ECCED92A65093BA', // Genesis block
  frontier: '991CF190094C00F0B68E2E5F75F6BEE95A2E0BD93CEAA4A6734DB9F19B728948',
  representative: 'nano_1stofnrxuz3cai7ze75o174bpm7scwj9jn3nxsn8ntzg784jf1gzn1jjdkou', // Known representative
  wallet_id: '000D1BAEC8EC208142C99059B393051BAC8380F9B5A2E6B2489A277D81789F3F', // Test wallet ID
  work: 'fb4548bb4db64b06',
  amount_raw: '1000000000000000000000000000000', // 1 NANO in raw
  amount_nano: '1'
};

// Track results
const results = {
  passed: 0,
  failed: 0,
  tests: []
};

function makeRpcCall(action, params = {}) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ action, ...params });
    
    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(RPC_URL, options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          resolve(response);
        } catch (e) {
          reject(new Error(`Invalid JSON response: ${data}`));
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.write(postData);
    req.end();
  });
}

async function testRpcAction(name, action, params = {}, expectError = false) {
  try {
    console.log(`\n📋 Testing: ${name} (${action})`);
    console.log(`   Params: ${JSON.stringify(params)}`);
    
    const response = await makeRpcCall(action, params);
    
    if (response.error && !expectError) {
      console.log(`   ❌ FAILED: ${response.error}`);
      results.failed++;
      results.tests.push({ name, action, status: 'FAILED', error: response.error });
    } else if (!response.error && expectError) {
      console.log(`   ⚠️  UNEXPECTED SUCCESS: Expected error but got success`);
      console.log(`   Response: ${JSON.stringify(response).substring(0, 200)}...`);
      results.failed++;
      results.tests.push({ name, action, status: 'UNEXPECTED_SUCCESS', response });
    } else {
      console.log(`   ✅ PASSED`);
      console.log(`   Response: ${JSON.stringify(response).substring(0, 200)}...`);
      results.passed++;
      results.tests.push({ name, action, status: 'PASSED', response });
    }
  } catch (error) {
    console.log(`   ❌ ERROR: ${error.message}`);
    results.failed++;
    results.tests.push({ name, action, status: 'ERROR', error: error.message });
  }
}

async function runAllTests() {
  console.log('🚀 Starting comprehensive Nano RPC testing');
  console.log(`📡 Target endpoint: ${RPC_URL}`);
  console.log('=' .repeat(80));

  // Node RPCs - Core query operations
  console.log('\n🔍 NODE RPCs - Core Query Operations');
  console.log('-'.repeat(50));
  
  await testRpcAction('Account Balance', 'account_balance', { account: TEST_DATA.account });
  await testRpcAction('Account Block Count', 'account_block_count', { account: TEST_DATA.account });
  await testRpcAction('Account Get', 'account_get', { key: 'E89208DD038FBB269987689621D52292AE9C35941A7484756ECCED92A65093BA' });
  await testRpcAction('Account History', 'account_history', { account: TEST_DATA.account, count: 5 });
  await testRpcAction('Account Info', 'account_info', { account: TEST_DATA.account });
  await testRpcAction('Account Key', 'account_key', { account: TEST_DATA.account });
  await testRpcAction('Account Representative', 'account_representative', { account: TEST_DATA.account });
  await testRpcAction('Account Weight', 'account_weight', { account: TEST_DATA.representative });
  
  await testRpcAction('Accounts Balances', 'accounts_balances', { 
    accounts: [TEST_DATA.account, TEST_DATA.genesis_account] 
  });
  await testRpcAction('Accounts Frontiers', 'accounts_frontiers', { 
    accounts: [TEST_DATA.account, TEST_DATA.genesis_account] 
  });
  await testRpcAction('Accounts Receivable', 'accounts_receivable', { 
    accounts: [TEST_DATA.account] 
  });
  await testRpcAction('Accounts Representatives', 'accounts_representatives', { 
    accounts: [TEST_DATA.account, TEST_DATA.genesis_account] 
  });

  await testRpcAction('Available Supply', 'available_supply');
  await testRpcAction('Block Account', 'block_account', { hash: TEST_DATA.block_hash });
  await testRpcAction('Block Count', 'block_count');
  await testRpcAction('Block Hash', 'block_hash', { 
    type: 'state',
    account: TEST_DATA.account,
    previous: '0',
    representative: TEST_DATA.representative,
    balance: '0',
    link: '0'
  });
  await testRpcAction('Block Info', 'block_info', { hash: TEST_DATA.block_hash });
  await testRpcAction('Blocks', 'blocks', { hashes: [TEST_DATA.block_hash] });
  await testRpcAction('Blocks Info', 'blocks_info', { hashes: [TEST_DATA.block_hash] });

  await testRpcAction('Chain', 'chain', { block: TEST_DATA.block_hash, count: 5 });
  await testRpcAction('Confirmation Active', 'confirmation_active');
  await testRpcAction('Confirmation History', 'confirmation_history');
  await testRpcAction('Confirmation Info', 'confirmation_info', { hash: TEST_DATA.block_hash });
  await testRpcAction('Confirmation Quorum', 'confirmation_quorum');

  await testRpcAction('Delegators', 'delegators', { account: TEST_DATA.representative });
  await testRpcAction('Delegators Count', 'delegators_count', { account: TEST_DATA.representative });
  
  await testRpcAction('Frontier Count', 'frontier_count');
  await testRpcAction('Frontiers', 'frontiers', { account: TEST_DATA.account, count: 5 });
  
  await testRpcAction('Node ID', 'node_id');
  await testRpcAction('Peers', 'peers');
  
  await testRpcAction('Receivable', 'receivable', { account: TEST_DATA.account, count: 5 });
  await testRpcAction('Receivable Exists', 'receivable_exists', { 
    hash: TEST_DATA.block_hash 
  });
  
  await testRpcAction('Representatives', 'representatives');
  await testRpcAction('Representatives Online', 'representatives_online');
  
  await testRpcAction('Stats', 'stats', { type: 'counters' });
  await testRpcAction('Successors', 'successors', { block: TEST_DATA.block_hash, count: 5 });
  await testRpcAction('Telemetry', 'telemetry');
  
  await testRpcAction('Validate Account Number', 'validate_account_number', { 
    account: TEST_DATA.account 
  });
  await testRpcAction('Version', 'version');
  
  await testRpcAction('Unchecked', 'unchecked', { count: 5 });
  await testRpcAction('Unopened', 'unopened');
  await testRpcAction('Uptime', 'uptime');

  // Utility RPCs
  console.log('\n🔧 UTILITY RPCs');
  console.log('-'.repeat(50));
  
  await testRpcAction('Deterministic Key', 'deterministic_key', { seed: 'A'.repeat(64), index: 0 });
  await testRpcAction('Key Create', 'key_create');
  await testRpcAction('Key Expand', 'key_expand', { key: 'E89208DD038FBB269987689621D52292AE9C35941A7484756ECCED92A65093BA' });
  await testRpcAction('Sign', 'sign', { 
    key: 'E89208DD038FBB269987689621D52292AE9C35941A7484756ECCED92A65093BA',
    hash: TEST_DATA.block_hash 
  });
  
  // Work RPCs
  await testRpcAction('Work Generate', 'work_generate', { hash: TEST_DATA.block_hash });
  await testRpcAction('Work Validate', 'work_validate', { 
    work: TEST_DATA.work,
    hash: TEST_DATA.block_hash 
  });

  // Unit Conversion RPCs
  console.log('\n💱 UNIT CONVERSION RPCs');
  console.log('-'.repeat(50));
  
  await testRpcAction('Nano to Raw', 'nano_to_raw', { amount: TEST_DATA.amount_nano });
  await testRpcAction('Raw to Nano', 'raw_to_nano', { amount: TEST_DATA.amount_raw });

  // Wallet RPCs (these likely won't work on public nodes)
  console.log('\n👛 WALLET RPCs (likely to fail on public nodes)');
  console.log('-'.repeat(50));
  
  await testRpcAction('Wallet Create', 'wallet_create', {}, true);
  await testRpcAction('Account Create', 'account_create', { wallet: TEST_DATA.wallet_id }, true);
  await testRpcAction('Account List', 'account_list', { wallet: TEST_DATA.wallet_id }, true);
  await testRpcAction('Wallet Balances', 'wallet_balances', { wallet: TEST_DATA.wallet_id }, true);
  await testRpcAction('Wallet Info', 'wallet_info', { wallet: TEST_DATA.wallet_id }, true);
  await testRpcAction('Send', 'send', { 
    wallet: TEST_DATA.wallet_id,
    source: TEST_DATA.account,
    destination: TEST_DATA.genesis_account,
    amount: '1000000000000000000000000'
  }, true);

  // Administrative RPCs (likely to fail)
  console.log('\n⚙️  ADMINISTRATIVE RPCs (likely to fail on public nodes)');
  console.log('-'.repeat(50));
  
  await testRpcAction('Bootstrap', 'bootstrap', {}, true);
  await testRpcAction('Bootstrap Status', 'bootstrap_status', {}, true);
  await testRpcAction('Stop', 'stop', {}, true);
  await testRpcAction('Database TXN Tracker', 'database_txn_tracker', {}, true);

  // Deprecated RPCs
  console.log('\n⚠️  DEPRECATED RPCs');
  console.log('-'.repeat(50));
  
  await testRpcAction('Active Difficulty (deprecated)', 'active_difficulty');
  await testRpcAction('Accounts Pending (deprecated)', 'accounts_pending', { 
    accounts: [TEST_DATA.account] 
  });
  await testRpcAction('History (deprecated)', 'history', { 
    hash: TEST_DATA.block_hash, 
    count: 5 
  });

  // Legacy unit conversion (deprecated)
  await testRpcAction('Krai from Raw (deprecated)', 'krai_from_raw', { 
    amount: '1000000000000000000000000000' 
  });
  await testRpcAction('Krai to Raw (deprecated)', 'krai_to_raw', { amount: '1' });
  await testRpcAction('Mrai from Raw (deprecated)', 'mrai_from_raw', { 
    amount: TEST_DATA.amount_raw 
  });
  await testRpcAction('Mrai to Raw (deprecated)', 'mrai_to_raw', { amount: '1' });
  await testRpcAction('Rai from Raw (deprecated)', 'rai_from_raw', { 
    amount: '1000000000000000000000000' 
  });
  await testRpcAction('Rai to Raw (deprecated)', 'rai_to_raw', { amount: '1' });
  await testRpcAction('Pending (deprecated)', 'pending', { account: TEST_DATA.account });
  await testRpcAction('Pending Exists (deprecated)', 'pending_exists', { 
    hash: TEST_DATA.block_hash 
  });

  // Print final results
  console.log('\n' + '='.repeat(80));
  console.log('📊 TEST RESULTS SUMMARY');
  console.log('='.repeat(80));
  console.log(`✅ Passed: ${results.passed}`);
  console.log(`❌ Failed: ${results.failed}`);
  console.log(`📈 Total: ${results.passed + results.failed}`);
  console.log(`📊 Success Rate: ${((results.passed / (results.passed + results.failed)) * 100).toFixed(1)}%`);

  // Save detailed results to file
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `rpc-test-results-${timestamp}.json`;
  
  const detailedResults = {
    timestamp: new Date().toISOString(),
    endpoint: RPC_URL,
    summary: {
      passed: results.passed,
      failed: results.failed,
      total: results.passed + results.failed,
      successRate: ((results.passed / (results.passed + results.failed)) * 100).toFixed(1)
    },
    tests: results.tests
  };

  fs.writeFileSync(filename, JSON.stringify(detailedResults, null, 2));
  console.log(`\n💾 Detailed results saved to: ${filename}`);

  // Show failed tests
  const failedTests = results.tests.filter(t => t.status === 'FAILED' || t.status === 'ERROR');
  if (failedTests.length > 0) {
    console.log('\n❌ FAILED TESTS:');
    failedTests.forEach(test => {
      console.log(`   • ${test.name} (${test.action}): ${test.error}`);
    });
  }

  console.log('\n🏁 Testing completed!');
}

// Run the tests
runAllTests().catch(console.error); 