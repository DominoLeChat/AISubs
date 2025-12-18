#!/usr/bin/env node

/**
 * Test script for AI Subtitle Translator Addon
 * Tests all endpoints without requiring Stremio
 */

const axios = require('axios');
const BASE_URL = process.env.TEST_URL || 'http://127.0.0.1:7001';

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logSuccess(message) {
  log(`✅ ${message}`, 'green');
}

function logError(message) {
  log(`❌ ${message}`, 'red');
}

function logInfo(message) {
  log(`ℹ️  ${message}`, 'cyan');
}

function logWarning(message) {
  log(`⚠️  ${message}`, 'yellow');
}

async function testEndpoint(name, url, options = {}) {
  try {
    logInfo(`Testing: ${name}`);
    log(`   URL: ${url}`, 'blue');
    
    const response = await axios({
      url,
      method: options.method || 'GET',
      data: options.data,
      validateStatus: () => true, // Don't throw on any status
      maxRedirects: options.followRedirects !== false ? 5 : 0, // Follow redirects by default
    });

    if (response.status >= 200 && response.status < 300) {
      logSuccess(`Status: ${response.status}`);
      if (options.checkContent) {
        const contentCheck = options.checkContent(response);
        if (contentCheck) {
          logSuccess(`Content check passed: ${contentCheck}`);
        } else {
          logError(`Content check failed`);
        }
      }
      return { success: true, status: response.status, data: response.data };
    } else if (response.status >= 300 && response.status < 400) {
      logWarning(`Redirect: ${response.status} -> ${response.headers.location || 'N/A'}`);
      return { success: true, status: response.status, redirect: response.headers.location };
    } else {
      logError(`Status: ${response.status}`);
      return { success: false, status: response.status };
    }
  } catch (error) {
    if (error.code === 'ECONNREFUSED') {
      logError(`Connection refused - Is the server running on ${BASE_URL}?`);
    } else {
      logError(`Error: ${error.message}`);
    }
    return { success: false, error: error.message };
  }
}

async function runTests() {
  log('\n========================================', 'cyan');
  log('AI Subtitle Translator - Endpoint Tests', 'cyan');
  log('========================================\n', 'cyan');

  const results = {
    passed: 0,
    failed: 0,
    total: 0,
  };

  // Test 1: Configuration page (should redirect)
  log('\n--- Test 1: Configuration Page ---', 'yellow');
  results.total++;
  const configTest = await testEndpoint(
    'Configuration Page',
    `${BASE_URL}/configure`,
    {
      followRedirects: true,
      checkContent: (response) => {
        const html = response.data || '';
        if (html.includes('AI Subtitle Translator') || html.includes('language')) {
          return 'Configuration page loaded successfully';
        }
        if (response.status === 302 || response.status === 301) {
          return 'Redirects to UUID-based URL';
        }
        return null;
      }
    }
  );
  if (configTest.success) results.passed++; else results.failed++;

  // Test 2: Manifest endpoint
  log('\n--- Test 2: Manifest Endpoint ---', 'yellow');
  results.total++;
  const manifestTest = await testEndpoint(
    'Manifest',
    `${BASE_URL}/manifest.json`,
    {
      followRedirects: true,
      checkContent: (response) => {
        if (response.data && response.data.id) {
          return `Addon ID: ${response.data.id}`;
        }
        return null;
      }
    }
  );
  if (manifestTest.success && manifestTest.data?.id) {
    results.passed++;
  } else {
    results.failed++;
  }

  // Test 3: Subtitle endpoint (with sample IMDB ID)
  log('\n--- Test 3: Subtitle Endpoint (Movie) ---', 'yellow');
  results.total++;
  const subtitleTest = await testEndpoint(
    'Subtitles for Movie',
    `${BASE_URL}/subtitles/movie/tt0111161.json`, // The Shawshank Redemption
    {
      followRedirects: true,
      checkContent: (response) => {
        if (response.data && Array.isArray(response.data)) {
          return `Found ${response.data.length} subtitle resources`;
        }
        return null;
      }
    }
  );
  if (subtitleTest.success) results.passed++; else results.failed++;

  // Test 4: Subtitle endpoint (TV Series)
  log('\n--- Test 4: Subtitle Endpoint (TV Series) ---', 'yellow');
  results.total++;
  const seriesTest = await testEndpoint(
    'Subtitles for TV Series',
    `${BASE_URL}/subtitles/series/tt0944947.json`, // Game of Thrones
    {
      followRedirects: true,
      checkContent: (response) => {
        if (response.data && Array.isArray(response.data)) {
          return `Found ${response.data.length} subtitle resources`;
        }
        return null;
      }
    }
  );
  if (seriesTest.success) results.passed++; else results.failed++;

  // Test 5: Error page (invalid UUID)
  log('\n--- Test 5: Error Page (Invalid UUID) ---', 'yellow');
  results.total++;
  const errorTest = await testEndpoint(
    'Error Page',
    `${BASE_URL}/stremio/invalid-uuid-123/invalid-config-456/configure`,
    {
      followRedirects: true,
      checkContent: (response) => {
        const html = response.data || '';
        if (html.includes('Invalid Configuration') || html.includes('error') || response.status === 400) {
          return 'Error page displayed (status 400 is expected for invalid UUID)';
        }
        return null;
      }
    }
  );
  // 400 status is expected for invalid UUID, so this is a success
  if (errorTest.status === 400) {
    logSuccess('Error page correctly returns 400 for invalid UUID');
    results.passed++;
  } else if (errorTest.success && errorTest.data) {
    results.passed++;
  } else {
    results.failed++;
  }

  // Test 6: Get actual configuration page HTML
  log('\n--- Test 6: Configuration Page HTML ---', 'yellow');
  results.total++;
  let configUrl = null;
  try {
    const redirectResponse = await axios.get(`${BASE_URL}/configure`, {
      maxRedirects: 5,
      validateStatus: () => true,
    });
    configUrl = redirectResponse.request.res.responseUrl || redirectResponse.config.url;
    const configHtmlTest = await testEndpoint(
      'Configuration Page HTML',
      configUrl,
      {
        checkContent: (response) => {
          const html = response.data || '';
          if (html.includes('AI Subtitle Translator') || html.includes('language')) {
            return 'Configuration page HTML loaded';
          }
          return null;
        }
      }
    );
    if (configHtmlTest.success) results.passed++; else results.failed++;
  } catch (error) {
    logError(`Could not fetch configuration page: ${error.message}`);
    results.failed++;
  }

  // Summary
  log('\n========================================', 'cyan');
  log('Test Summary', 'cyan');
  log('========================================', 'cyan');
  log(`Total Tests: ${results.total}`, 'blue');
  logSuccess(`Passed: ${results.passed}`);
  if (results.failed > 0) {
    logError(`Failed: ${results.failed}`);
  } else {
    logSuccess(`Failed: ${results.failed}`);
  }
  log('========================================\n', 'cyan');

  // Additional info
  log('\n📝 Manual Testing Steps:', 'yellow');
  log('1. Open in browser: ' + BASE_URL + '/configure', 'blue');
  log('2. Test error page: ' + BASE_URL + '/stremio/invalid-uuid/invalid-config/configure', 'blue');
  log('3. Check manifest: ' + BASE_URL + '/manifest.json', 'blue');
  log('4. View subtitle data: ' + BASE_URL + '/subtitles/movie/tt0111161.json', 'blue');
  log('\n');

  process.exit(results.failed > 0 ? 1 : 0);
}

// Run tests
runTests().catch(error => {
  logError(`Fatal error: ${error.message}`);
  process.exit(1);
});

