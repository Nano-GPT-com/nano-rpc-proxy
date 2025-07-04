#!/usr/bin/env node

/**
 * Rate Limiting Test Script for Nano RPC Proxy
 * Tests that the rate limiting is properly enforced
 */

const https = require('https');

// Configuration
const ENDPOINT = process.env.RPC_ENDPOINT || 'https://rpc.nano-gpt.com';
const RATE_LIMIT = 100; // Expected rate limit per 15 minutes
const BURST_SIZE = 20; // Expected burst size
const TEST_DURATION = 30000; // 30 seconds

// Parse endpoint URL
const url = new URL(ENDPOINT);
const options = {
  hostname: url.hostname,
  port: url.port || (url.protocol === 'https:' ? 443 : 80),
  path: url.pathname || '/',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  }
};

// Test payload (using a simple, fast command)
const testPayload = JSON.stringify({ action: 'version' });

// Statistics
let successCount = 0;
let rateLimitedCount = 0;
let errorCount = 0;
let requestTimes = [];

/**
 * Make a single request
 */
function makeRequest() {
  return new Promise((resolve) => {
    const startTime = Date.now();
    
    const req = https.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        const endTime = Date.now();
        const responseTime = endTime - startTime;
        requestTimes.push(responseTime);
        
        if (res.statusCode === 200) {
          successCount++;
          console.log(`✅ Request ${successCount + rateLimitedCount + errorCount}: Success (${responseTime}ms)`);
        } else if (res.statusCode === 429) {
          rateLimitedCount++;
          console.log(`🚫 Request ${successCount + rateLimitedCount + errorCount}: Rate limited (${responseTime}ms)`);
        } else {
          errorCount++;
          console.log(`❌ Request ${successCount + rateLimitedCount + errorCount}: Error ${res.statusCode} (${responseTime}ms)`);
        }
        
        resolve();
      });
    });
    
    req.on('error', (e) => {
      errorCount++;
      console.error(`❌ Request error: ${e.message}`);
      resolve();
    });
    
    req.write(testPayload);
    req.end();
  });
}

/**
 * Run burst test
 */
async function runBurstTest() {
  console.log('🚀 Starting rate limit test...');
  console.log(`📍 Endpoint: ${ENDPOINT}`);
  console.log(`⏱️  Test duration: ${TEST_DURATION / 1000} seconds`);
  console.log('');
  
  const startTime = Date.now();
  const requests = [];
  
  // Send requests rapidly until we hit rate limit or time runs out
  while (Date.now() - startTime < TEST_DURATION) {
    requests.push(makeRequest());
    
    // Small delay between requests to avoid overwhelming the connection
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  
  // Wait for all requests to complete
  await Promise.all(requests);
  
  // Calculate statistics
  const totalRequests = successCount + rateLimitedCount + errorCount;
  const avgResponseTime = requestTimes.reduce((a, b) => a + b, 0) / requestTimes.length;
  
  console.log('\n📊 Test Results:');
  console.log('─'.repeat(40));
  console.log(`Total requests sent: ${totalRequests}`);
  console.log(`✅ Successful: ${successCount}`);
  console.log(`🚫 Rate limited: ${rateLimitedCount}`);
  console.log(`❌ Errors: ${errorCount}`);
  console.log(`⏱️  Average response time: ${avgResponseTime.toFixed(2)}ms`);
  console.log('─'.repeat(40));
  
  // Verify rate limiting is working
  if (rateLimitedCount > 0) {
    console.log('\n✅ Rate limiting is ACTIVE and working properly!');
    console.log(`   - Allowed ${successCount} requests before limiting`);
    console.log(`   - This suggests a burst allowance of ~${successCount} requests`);
  } else if (successCount >= BURST_SIZE) {
    console.log('\n⚠️  WARNING: Rate limiting might not be working!');
    console.log(`   - Sent ${successCount} requests without being rate limited`);
    console.log('   - Expected to be rate limited after burst allowance');
  } else {
    console.log('\n❓ Inconclusive: Not enough requests to trigger rate limiting');
    console.log('   - Try running the test for longer');
  }
  
  // Check if we're hitting the expected burst size
  if (successCount >= BURST_SIZE - 5 && successCount <= BURST_SIZE + 5) {
    console.log(`\n✅ Burst size appears to be correctly configured (~${BURST_SIZE} requests)`);
  }
}

// Run the test
runBurstTest().catch(console.error);