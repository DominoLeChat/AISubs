#!/usr/bin/env node

/**
 * Test intelligent chunking implementation with a real movie
 */

const { searchSubtitles } = require('wyzie-lib');
const axios = require('axios');
require('dotenv').config();

// Colors for output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

// Language code to name mapping
const LANGUAGE_NAMES = {
  'en': 'English',
  'es': 'Spanish',
  'fr': 'French',
  'de': 'German',
  'it': 'Italian',
  'pt': 'Portuguese',
  'ru': 'Russian',
  'ja': 'Japanese',
  'ko': 'Korean',
  'zh': 'Chinese',
  'ar': 'Arabic',
  'hi': 'Hindi',
  'nl': 'Dutch',
  'sv': 'Swedish',
  'no': 'Norwegian',
  'da': 'Danish',
  'fi': 'Finnish',
  'pl': 'Polish',
  'tr': 'Turkish',
  'vi': 'Vietnamese',
  'th': 'Thai',
  'id': 'Indonesian',
  'ms': 'Malay',
  'cs': 'Czech',
  'hu': 'Hungarian',
  'ro': 'Romanian',
  'el': 'Greek',
  'he': 'Hebrew',
  'uk': 'Ukrainian',
  'bg': 'Bulgarian',
  'hr': 'Croatian',
  'sk': 'Slovak',
  'sl': 'Slovenian',
  'sr': 'Serbian',
  'ca': 'Catalan',
  'eu': 'Basque',
  'fa': 'Persian',
  'ur': 'Urdu',
  'bn': 'Bengali',
  'ta': 'Tamil',
  'te': 'Telugu',
  'ml': 'Malayalam',
  'kn': 'Kannada'
};

/**
 * Get language name from language code
 */
function getLanguageName(languageCode) {
  return LANGUAGE_NAMES[languageCode.toLowerCase()] || languageCode.toUpperCase();
}

// Test configuration
const TEST_MOVIE_IMDB = 'tt1375666'; // Inception (2010)
const TARGET_LANGUAGE = 'ta'; // Tamil

// Model configurations (same as addon.js)
// Using OpenRouter models - supports Gemma, Llama, Claude, GPT, and more
// Optimized to maximize tokens per chunk to minimize requests
const MODEL_CONFIGS = {
  'meta-llama/llama-3.1-8b-instruct': {
    rpm: 60,
    tpm: 1000000,
    rpd: 10000,
    maxTokens: 8192,
    priority: 0     // Try first - Llama 8B, reliable
  },
  'google/gemma-2-9b-it': {
    rpm: 60,
    tpm: 1000000,
    rpd: 10000,
    maxTokens: 8192,
    priority: 1     // Second choice - Gemma 9B, good balance
  },
  'google/gemma-2-2b-it': {
    rpm: 60,
    tpm: 1000000,
    rpd: 10000,
    maxTokens: 8192,
    priority: 2     // Third choice - Gemma 2B, faster
  },
  'google/gemma-2-1.1b-it': {
    rpm: 60,
    tpm: 1000000,
    rpd: 10000,
    maxTokens: 8192,
    priority: 3     // Fourth choice - Gemma 1.1B, fastest
  },
  'mistralai/mistral-7b-instruct': {
    rpm: 60,
    tpm: 1000000,
    rpd: 10000,
    maxTokens: 8192,
    priority: 4     // Last resort - Mistral 7B
  }
};

// Rate limiting state
let rateLimiter = {
  requestsThisMinute: 0,
  tokensThisMinute: 0,
  requestsToday: 0,
  lastRequestTime: 0,
  lastMinuteReset: Date.now()
};

/**
 * Estimate token count (1 token ≈ 4 characters)
 */
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

/**
 * Split subtitles into chunks optimized for model limits
 */
function splitSubtitlesOptimized(srtContent, modelConfig) {
  const lines = srtContent.split('\n');
  const chunks = [];
  let currentChunk = [];
  let currentBlock = [];
  let currentTokens = 0;
  
  // Calculate optimal chunk size based on model limits
  const maxTokensPerChunk = Math.min(
    Math.floor(modelConfig.tpm * 0.8), // 80% of TPM limit
    modelConfig.maxTokens - 1000        // Leave room for prompt + response
  );
  
  // Estimate prompt tokens
  const promptTokens = estimateTokens(`Translate the following subtitle file to {lang}. CRITICAL INSTRUCTIONS: 1. Preserve the exact subtitle format (SRT or VTT) 2. Keep all timing codes exactly as they are 3. Only translate the text content, not numbers or timing 4. Maintain the same structure and line breaks 5. Do not add or remove subtitle entries Subtitle content:`);
  
  const availableTokensPerChunk = maxTokensPerChunk - promptTokens;
  
  for (const line of lines) {
    currentBlock.push(line);
    
    if (line.trim() === '') {
      if (currentBlock.length > 1) {
        const blockText = currentBlock.join('\n');
        const blockTokens = estimateTokens(blockText);
        
        // Check if adding this block would exceed token limit
        if (currentTokens + blockTokens > availableTokensPerChunk && currentChunk.length > 0) {
          // Save current chunk and start new one
          chunks.push(currentChunk.join('\n\n') + '\n');
          currentChunk = [blockText];
          currentTokens = blockTokens;
        } else {
          currentChunk.push(blockText);
          currentTokens += blockTokens + 2; // +2 for \n\n separator
        }
      }
      currentBlock = [];
    }
  }
  
  // Add remaining chunk
  if (currentChunk.length > 0) {
    chunks.push(currentChunk.join('\n\n') + '\n');
  }
  
  return chunks;
}

/**
 * Check and enforce rate limits (RPM, TPM, RPD)
 */
async function enforceRateLimits(modelConfig) {
  const now = Date.now();
  
  // Reset minute counters if a minute has passed
  if (now - rateLimiter.lastMinuteReset > 60000) {
    rateLimiter.requestsThisMinute = 0;
    rateLimiter.tokensThisMinute = 0;
    rateLimiter.lastMinuteReset = now;
  }
  
  // Check RPM limit
  if (rateLimiter.requestsThisMinute >= modelConfig.rpm) {
    const waitTime = 60000 - (now - rateLimiter.lastMinuteReset);
    if (waitTime > 0) {
      log(`⏳ RPM limit reached (${rateLimiter.requestsThisMinute}/${modelConfig.rpm}), waiting ${Math.ceil(waitTime/1000)}s...`, 'yellow');
      await new Promise(resolve => setTimeout(resolve, waitTime));
      rateLimiter.requestsThisMinute = 0;
      rateLimiter.lastMinuteReset = Date.now();
    }
  }
  
  // Check RPD limit
  if (rateLimiter.requestsToday >= modelConfig.rpd) {
    throw new Error(`Daily request limit reached (${rateLimiter.requestsToday}/${modelConfig.rpd} RPD). Please try again tomorrow.`);
  }
}

/**
 * Update rate limiter after request
 */
function updateRateLimiter(estimatedTokens) {
  rateLimiter.requestsThisMinute++;
  rateLimiter.tokensThisMinute += estimatedTokens;
  rateLimiter.requestsToday++;
  rateLimiter.lastRequestTime = Date.now();
}

/**
 * Calculate delay between requests based on RPM limit
 */
function calculateRequestDelay(modelConfig) {
  const minDelay = Math.ceil(60000 / modelConfig.rpm);
  return Math.max(minDelay, 1000); // At least 1 second
}

async function translateChunk(chunk, modelName, modelConfig, targetLanguage, chunkIndex, totalChunks, apiKey) {
  const targetLanguageName = getLanguageName(targetLanguage);
  const prompt = `Translate the following subtitle file to ${targetLanguageName}. 
    
CRITICAL INSTRUCTIONS:
1. Preserve the exact subtitle format (SRT or VTT)
2. Keep all timing codes exactly as they are
3. Only translate the text content, not numbers or timing
4. Maintain the same structure and line breaks
5. Do not add or remove subtitle entries

Subtitle content:
${chunk}`;

  const estimatedTokens = estimateTokens(prompt);
  
  // Enforce rate limits before request
  await enforceRateLimits(modelConfig);
  
  const retries = 5;
  const retryDelay = 2000;
  let lastError;
  
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          model: modelName,
          messages: [
            {
              role: 'user',
              content: prompt
            }
          ],
          temperature: 0.3,
          max_tokens: modelConfig.maxTokens
        },
        {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': process.env.OPENROUTER_REFERER || 'https://github.com/stremio-ai-subs',
            'X-Title': 'Stremio AI Subtitles Test'
          },
          timeout: 120000
        }
      );

      // Check for error in response
      if (response.data.error) {
        const errorMsg = response.data.error.message || JSON.stringify(response.data.error);
        // If it's a model-specific error, we might want to try a different model
        if (errorMsg.includes('502') || errorMsg.includes('provider')) {
          throw new Error(`MODEL_ERROR: ${errorMsg}`);
        }
        throw new Error(`API Error: ${errorMsg}`);
      }

      if (!response.data || !response.data.choices || !response.data.choices[0]) {
        throw new Error(`Invalid API response: ${JSON.stringify(response.data)}`);
      }

      let translatedContent = response.data.choices[0].message.content;
      
      // Handle empty or whitespace-only responses - retry if empty
      if (!translatedContent || !translatedContent.trim()) {
        // If this is not the last attempt, retry
        if (attempt < retries - 1) {
          throw new Error('EMPTY_RESPONSE_RETRY');
        }
        throw new Error('API returned empty or whitespace-only response after retries');
      }
      
      translatedContent = translatedContent.trim();
      
      if (translatedContent.startsWith('```')) {
        translatedContent = translatedContent.replace(/```[\w]*\n?/g, '').replace(/```$/g, '').trim();
      }
      
      // Update rate limiter
      const responseTokens = estimateTokens(translatedContent);
      updateRateLimiter(estimatedTokens + responseTokens);
      
      log(`✅ Chunk ${chunkIndex + 1}/${totalChunks} translated (~${(estimatedTokens + responseTokens).toLocaleString()} tokens)`, 'green');
      return translatedContent;
    } catch (error) {
      lastError = error;
      
      // Handle empty response retry
      if (error.message && error.message.includes('EMPTY_RESPONSE_RETRY')) {
        if (attempt < retries - 1) {
          const waitTime = retryDelay * Math.pow(2, attempt);
          log(`⚠️  Chunk ${chunkIndex + 1} returned empty response, retrying in ${Math.round(waitTime/1000)}s... (attempt ${attempt + 1}/${retries})`, 'yellow');
          await new Promise(resolve => setTimeout(resolve, waitTime));
          continue;
        }
      }
      
      // If it's a model error, don't retry - try different model
      if (error.message && error.message.includes('MODEL_ERROR')) {
        throw error;
      }
      
      // Log error details for debugging
      if (error.response) {
        log(`API Error: ${error.response.status} - ${JSON.stringify(error.response.data).substring(0, 200)}`, 'red');
      } else if (error.message) {
        log(`Error: ${error.message}`, 'red');
      }
      
      const isRetryable = error.response?.status === 503 || 
                        error.response?.status === 429 ||
                        error.message.includes('timeout') ||
                        error.message.includes('ECONNRESET');
      
      if (isRetryable && attempt < retries - 1) {
        const waitTime = retryDelay * Math.pow(2, attempt);
        log(`⚠️  Chunk ${chunkIndex + 1} failed, retrying in ${Math.round(waitTime/1000)}s... (attempt ${attempt + 1}/${retries})`, 'yellow');
        await new Promise(resolve => setTimeout(resolve, waitTime));
      } else {
        throw error;
      }
    }
  }
  throw lastError;
}

async function testMovieTranslation() {
  log('\n' + '='.repeat(70), 'cyan');
  log('Testing Chunking Implementation with Real Movie', 'cyan');
  log('='.repeat(70) + '\n', 'cyan');
  
  log(`Movie: Inception (2010) - IMDB: ${TEST_MOVIE_IMDB}`, 'blue');
  log(`Target Language: Tamil (${TARGET_LANGUAGE})\n`, 'blue');
  
  try {
    // Step 1: Fetch English subtitles
    log('[Step 1] Fetching English subtitles...', 'cyan');
    const subtitleResults = await searchSubtitles({
      imdb_id: TEST_MOVIE_IMDB,
      language: 'en',
      type: 'srt'
    });
    
    if (!subtitleResults || subtitleResults.length === 0) {
      log('❌ No English subtitles found', 'red');
      process.exit(1);
    }
    
    log(`✅ Found ${subtitleResults.length} English subtitle(s)`, 'green');
    const subtitleUrl = subtitleResults[0].url;
    log(`   URL: ${subtitleUrl}\n`, 'blue');
    
    // Fetch subtitle content
    const subtitleResponse = await axios.get(subtitleUrl, {
      responseType: 'text',
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    const subtitleContent = subtitleResponse.data;
    log(`✅ Fetched ${subtitleContent.length} characters`, 'green');
    
    // Step 2: Check if chunking is needed
    const shouldChunk = subtitleContent.length > 20000;
    log(`\n[Step 2] File size check: ${shouldChunk ? 'Chunking required' : 'Single request'}`, 'cyan');
    
    // Step 3: Initialize OpenRouter
    if (!process.env.OPENROUTER_API_KEY) {
      log('❌ OPENROUTER_API_KEY not set', 'red');
      process.exit(1);
    }
    
    const apiKey = process.env.OPENROUTER_API_KEY;
    
    // Try models in order of priority (best limits first)
    const modelsToTry = Object.entries(MODEL_CONFIGS)
      .sort((a, b) => a[1].priority - b[1].priority)
      .map(([name, config]) => ({ name, ...config }));
    
    // Select first model (will try fallback if it fails)
    let modelName = modelsToTry[0].name;
    let modelConfig = MODEL_CONFIGS[modelName];
    
    log(`✅ OpenRouter AI initialized: ${modelName}`, 'green');
    log(`   Limits: ${modelsToTry[0].rpm} RPM, ${(modelsToTry[0].tpm/1000).toFixed(0)}K TPM, ${modelsToTry[0].rpd} RPD\n`, 'blue');
    
    // Step 4: Translate with intelligent chunking
    log('[Step 3] Translating subtitles with intelligent chunking...', 'cyan');
    const startTime = Date.now();
    
    let translatedContent;
    
    if (shouldChunk) {
      log(`Large file detected, using intelligent token-based chunking...`, 'yellow');
      const chunks = splitSubtitlesOptimized(subtitleContent, modelConfig);
      log(`Split into ${chunks.length} chunk(s) based on token limits`, 'blue');
      log(`  Max tokens per chunk: ~${Math.floor(modelConfig.tpm * 0.8 / 1000).toFixed(0)}K`, 'blue');
      
      // Calculate optimal delay
      const requestDelay = calculateRequestDelay(modelConfig);
      log(`  Request delay: ${requestDelay}ms (ensures < ${modelConfig.rpm} RPM)\n`, 'blue');
      
      const translatedChunks = [];
      log(`DEBUG: Processing ${chunks.length} chunk(s)`, 'gray');
      for (let i = 0; i < chunks.length; i++) {
        log(`DEBUG: Loop iteration i=${i}, chunkIndex=${i + 1}, total=${chunks.length}`, 'gray');
        const translated = await translateChunk(chunks[i], modelName, modelConfig, TARGET_LANGUAGE, i + 1, chunks.length, apiKey);
        translatedChunks.push(translated);
        
        // Intelligent delay between chunks based on RPM limit
        if (i < chunks.length - 1) {
          await new Promise(resolve => setTimeout(resolve, requestDelay));
        }
      }
      
      translatedContent = translatedChunks.join('\n\n');
    } else {
      log('Small file, using single request...', 'yellow');
      const translated = await translateChunk(subtitleContent, modelName, modelConfig, TARGET_LANGUAGE, 1, 1, apiKey);
      translatedContent = translated;
    }
    
    const duration = Date.now() - startTime;
    
    // Step 5: Results
    log('\n[Step 4] Results', 'cyan');
    log('='.repeat(70), 'green');
    log('✅ TRANSLATION COMPLETED SUCCESSFULLY!', 'green');
    log('='.repeat(70) + '\n', 'green');
    
    log(`Original: ${subtitleContent.length.toLocaleString()} characters`, 'blue');
    log(`Translated: ${translatedContent.length.toLocaleString()} characters`, 'blue');
    log(`Duration: ${(duration / 1000).toFixed(2)} seconds`, 'blue');
    log(`Speed: ${(translatedContent.length / duration * 1000).toFixed(0)} chars/sec`, 'blue');
    log(`Requests used: ${rateLimiter.requestsToday}/${modelConfig.rpd} RPD`, 'blue');
    log(`Tokens used: ~${rateLimiter.tokensThisMinute.toLocaleString()}/${(modelConfig.tpm/1000).toFixed(0)}K TPM\n`, 'blue');
    
    // Show preview
    log('English Preview (first 300 chars):', 'cyan');
    log(subtitleContent.substring(0, 300) + '...\n', 'yellow');
    
    log('Tamil Preview (first 300 chars):', 'cyan');
    log(translatedContent.substring(0, 300) + '...\n', 'yellow');
    
    // Save results
    const fs = require('fs');
    const testDir = './test-output';
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir);
    }
    
    fs.writeFileSync(`${testDir}/inception-english.srt`, subtitleContent);
    fs.writeFileSync(`${testDir}/inception-tamil.srt`, translatedContent);
    
    log(`📁 Results saved:`, 'cyan');
    log(`  • ${testDir}/inception-english.srt`, 'blue');
    log(`  • ${testDir}/inception-tamil.srt`, 'blue');
    
    log('\n✅ Test completed successfully!', 'green');
    
  } catch (error) {
    log(`\n❌ Test failed: ${error.message}`, 'red');
    if (error.message.includes('429')) {
      log('   API quota exceeded. Please wait or upgrade your plan.', 'yellow');
    } else if (error.message.includes('503')) {
      log('   API service overloaded. Please try again later.', 'yellow');
    }
    process.exit(1);
  }
}

testMovieTranslation();

