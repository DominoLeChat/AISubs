const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const { searchSubtitles } = require('wyzie-lib');
const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
// Log all incoming requests for debugging
app.use((req, res, next) => {
  if (req.path.includes('subtitles') || req.path.includes('manifest') || req.path.includes('configure')) {
    console.log(`\n📥 ${req.method} ${req.path}`);
    if (Object.keys(req.query).length > 0) {
      console.log(`   Query:`, req.query);
    }
  }
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Model configurations with RPM, TPM, RPD limits
// Using OpenRouter models - supports Gemma, Llama, Claude, GPT, and more
// Optimized to use maximum tokens per chunk to minimize requests
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

// Initialize OpenRouter AI
let openRouterApiKey = null;
let currentModelName = null;
let currentModelConfig = null;

if (process.env.OPENROUTER_API_KEY) {
  openRouterApiKey = process.env.OPENROUTER_API_KEY;
  
  // Try models in order of priority (best limits first)
  const modelsToTry = Object.entries(MODEL_CONFIGS)
    .sort((a, b) => a[1].priority - b[1].priority)
    .map(([name, config]) => ({ name, ...config }));
  
  // Select first available model (we'll test on first request)
  currentModelName = modelsToTry[0].name;
  currentModelConfig = MODEL_CONFIGS[currentModelName];
  console.log(`OpenRouter AI initialized: ${currentModelName}`);
  console.log(`  Limits: ${currentModelConfig.rpm} RPM, ${(currentModelConfig.tpm/1000).toFixed(0)}K TPM, ${currentModelConfig.rpd} RPD`);
} else {
  console.warn('OPENROUTER_API_KEY not set. AI translation will not work.');
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

// Rate limiting state
let rateLimiter = {
  requestsThisMinute: 0,
  tokensThisMinute: 0,
  requestsToday: 0,
  lastRequestTime: 0,
  lastMinuteReset: Date.now()
};

// User preferences storage (in-memory) - keyed by UUID
const userPreferences = {};
const configUuids = {}; // Map userId to UUID

// Encryption key (in production, use environment variable)
// Generate a 32-byte key for AES-256
let ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
if (!ENCRYPTION_KEY) {
  // Generate a random 32-byte key and store it as hex (64 characters)
  ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
  console.log('Generated encryption key. Set ENCRYPTION_KEY in .env for production.');
}

// Ensure key is exactly 32 bytes
const getKey = () => {
  if (ENCRYPTION_KEY.length === 64) {
    // Hex string, convert to buffer
    return Buffer.from(ENCRYPTION_KEY, 'hex');
  } else if (ENCRYPTION_KEY.length === 32) {
    // Already a 32-byte string
    return Buffer.from(ENCRYPTION_KEY, 'utf8');
  } else {
    // Hash to get 32 bytes
    return crypto.createHash('sha256').update(ENCRYPTION_KEY).digest();
  }
};

const IV_LENGTH = 16;

/**
 * Encrypt configuration data
 */
function encryptConfig(data) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = getKey();
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(JSON.stringify(data), 'utf8', 'base64');
  encrypted += cipher.final('base64');
  return Buffer.from(JSON.stringify({
    iv: iv.toString('base64'),
    encrypted: encrypted,
    type: 'aioEncrypt'
  })).toString('base64');
}

/**
 * Decrypt configuration data
 */
function decryptConfig(encryptedData) {
  try {
    const data = JSON.parse(Buffer.from(encryptedData, 'base64').toString('utf8'));
    const iv = Buffer.from(data.iv, 'base64');
    const encrypted = data.encrypted;
    const key = getKey();
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encrypted, 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    return JSON.parse(decrypted);
  } catch (error) {
    console.error('Decryption error:', error);
    return null;
  }
}

// Initialize subtitle cache
if (!global.subtitleCache) {
  global.subtitleCache = {};
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Extract user ID from Stremio request args
 */
function getUserId(args) {
  return args.userData?.userId || args.userData?.user || 'default';
}

/**
 * Get user's preferred languages from stored preferences
 */
function getUserLanguages(args) {
  const userId = getUserId(args);
  const preferences = userPreferences[userId];
  return preferences?.languages || ['en'];
}

/**
 * Convert Stremio ID formats to wyzie-lib compatible format
 */
function parseStremioId(id) {
  // Handle IMDB format: tt1234567
  if (id.startsWith('tt')) {
    return { imdb_id: id };
  }
  
  // Handle TMDB format: tmdb:123456
  if (id.startsWith('tmdb:')) {
    return { tmdb_id: parseInt(id.replace('tmdb:', '')) };
  }
  
  // Try as TMDB ID (numeric)
  const tmdbId = parseInt(id);
  if (!isNaN(tmdbId)) {
    return { tmdb_id: tmdbId };
  }
  
  // Try as IMDB ID (prepend tt)
  return { imdb_id: `tt${id}` };
}

/**
 * Fetch subtitle content from URL
 */
async function fetchSubtitleContent(subtitleUrl) {
  try {
    const response = await axios.get(subtitleUrl, {
      responseType: 'text',
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    return response.data;
  } catch (error) {
    console.error('Error fetching subtitle content:', error.message);
    return null;
  }
}

/**
 * Search and fetch subtitles from wyzie-lib
 */
async function getSubtitlesFromWyzie(type, id, season, episode, language) {
  try {
    const idParams = parseStremioId(id);
    
    // Build search parameters
    const searchParams = {
      ...idParams,
      language: language,
      type: 'srt' // Request SRT format
    };
    
    // Add season/episode for TV shows
    if (type === 'series' && season && episode) {
      searchParams.season = parseInt(season);
      searchParams.episode = parseInt(episode);
    }
    
    console.log(`Searching wyzie-lib for ${language} subtitles:`, searchParams);
    
    // Search for subtitles
    const subtitleResults = await searchSubtitles(searchParams);
    
    if (!subtitleResults || subtitleResults.length === 0) {
      console.log(`No ${language} subtitles found in wyzie-lib`);
      return null;
    }
    
    // Get the first matching subtitle
    const subtitleData = subtitleResults[0];
    
    if (!subtitleData.url) {
      console.log(`Subtitle data found but no URL available`);
      return null;
    }
    
    // Fetch the actual subtitle content from the URL
    console.log(`Fetching subtitle content from: ${subtitleData.url}`);
    const subtitleContent = await fetchSubtitleContent(subtitleData.url);
    
    if (!subtitleContent) {
      return null;
    }
    
    return {
      content: subtitleContent,
      language: subtitleData.language || language,
      format: subtitleData.type || 'srt',
      url: subtitleData.url
    };
    
  } catch (error) {
    console.error(`Error getting subtitles from wyzie-lib for ${language}:`, error.message);
    return null;
  }
}

/**
 * Estimate token count (rough approximation: 1 token ≈ 4 characters)
 */
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

/**
 * Split subtitles into chunks by character count for parallel processing
 * Simple approach: split 40k chars into ~20 chunks of ~2k chars each
 */
function splitSubtitlesOptimized(srtContent, modelConfig) {
  const totalChars = srtContent.length;
  
  // Target ~100 chunks for maximum parallel processing (testing higher limits)
  // For 40k chars: 40k / 100 = ~400 chars per chunk
  // More chunks = faster processing + less chance of truncation
  const targetChunks = 100;
  const charsPerChunk = Math.max(400, Math.ceil(totalChars / targetChunks)); // Min 400 chars, very small chunks for max parallelism
  
  console.log(`  Splitting ${totalChars.toLocaleString()} chars into ~${Math.ceil(totalChars / charsPerChunk)} chunks (~${charsPerChunk.toLocaleString()} chars each)`);
  
  const lines = srtContent.split('\n');
  const chunks = [];
  let currentChunk = [];
  let currentBlock = [];
  let currentChars = 0;
  
  for (const line of lines) {
    currentBlock.push(line);
    
    if (line.trim() === '') {
      if (currentBlock.length > 1) {
        const blockText = currentBlock.join('\n');
        const blockChars = blockText.length;
        
        // Check if adding this block would exceed character limit
        // Don't split in the middle of a subtitle entry (block)
        if (currentChars + blockChars > charsPerChunk && currentChunk.length > 0) {
          // Save current chunk and start new one
          chunks.push(currentChunk.join('\n\n') + '\n');
          currentChunk = [blockText];
          currentChars = blockChars;
        } else {
          currentChunk.push(blockText);
          currentChars += blockChars + 2; // +2 for \n\n separator
        }
      }
      currentBlock = [];
    }
  }
  
  // Add remaining chunk
  if (currentChunk.length > 0) {
    chunks.push(currentChunk.join('\n\n') + '\n');
  }
  
  console.log(`  Created ${chunks.length} chunk(s) (avg ${Math.round(totalChars / chunks.length).toLocaleString()} chars each)`);
  
  return chunks;
}

/**
 * Split subtitles into chunks by subtitle count (fallback)
 */
function splitSubtitlesByCount(srtContent, chunkSize = 50) {
  const lines = srtContent.split('\n');
  const chunks = [];
  let currentChunk = [];
  let currentBlock = [];
  let blockCount = 0;
  
  for (const line of lines) {
    currentBlock.push(line);
    
    if (line.trim() === '') {
      if (currentBlock.length > 1) {
        currentChunk.push(currentBlock.join('\n'));
        blockCount++;
        
        if (blockCount >= chunkSize) {
          chunks.push(currentChunk.join('\n\n') + '\n');
          currentChunk = [];
          blockCount = 0;
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

// Rate limiter lock for concurrent access
let rateLimitLock = Promise.resolve();

/**
 * Check and enforce rate limits (RPM, TPM, RPD)
 * Non-blocking when under limits, only queues when actually hitting limits
 */
async function enforceRateLimits(modelConfig) {
  const now = Date.now();
  
  // Reset minute counters if a minute has passed (atomic check)
  if (now - rateLimiter.lastMinuteReset > 60000) {
    // Use lock only for counter reset to prevent race conditions
    await rateLimitLock;
    rateLimitLock = (async () => {
      const checkNow = Date.now();
      if (checkNow - rateLimiter.lastMinuteReset > 60000) {
        rateLimiter.requestsThisMinute = 0;
        rateLimiter.tokensThisMinute = 0;
        rateLimiter.lastMinuteReset = checkNow;
      }
    })();
  }
  
  // Check RPM limit - only wait if we're actually at the limit
  // For parallel processing, we allow all requests to proceed if under limit
  if (rateLimiter.requestsThisMinute >= modelConfig.rpm) {
    const waitTime = 60000 - (now - rateLimiter.lastMinuteReset);
    if (waitTime > 0) {
      console.log(`⏳ RPM limit reached (${rateLimiter.requestsThisMinute}/${modelConfig.rpm}), waiting ${Math.ceil(waitTime/1000)}s...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      rateLimiter.requestsThisMinute = 0;
      rateLimiter.tokensThisMinute = 0;
      rateLimiter.lastMinuteReset = Date.now();
    }
  }
  
  // Check RPD limit (approximate - resets daily)
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
  // Ensure we don't exceed RPM: minimum delay = 60s / RPM
  const minDelay = Math.ceil(60000 / modelConfig.rpm);
  return Math.max(minDelay, 1000); // At least 1 second
}

/**
 * Translate subtitles with intelligent chunking (optimized for RPM, TPM, RPD)
 */
async function translateSubtitlesWithGeminiChunked(subtitleContent, targetLanguage, userConfig) {
  // Extract user's OpenRouter credentials
  const userApiKey = userConfig?.openrouter?.apiKey;
  const userReferer = userConfig?.openrouter?.referer;
  
  // Fallback to server key if user hasn't configured (for backward compatibility during transition)
  const apiKey = userApiKey || process.env.OPENROUTER_API_KEY;
  const referer = userReferer || process.env.OPENROUTER_REFERER || 'https://stremio-ai-subs.local';
  
  if (!apiKey) {
    throw new Error(
      'OpenRouter API key not configured. ' +
      'Please visit the configuration page and add your OpenRouter API key. ' +
      'Get your key at https://openrouter.ai/keys'
    );
  }
  
  // Use user's preferred model or auto-select
  const preferredModel = userConfig?.translation?.model;
  let selectedModelName = preferredModel && preferredModel !== 'auto' 
    ? preferredModel 
    : Object.entries(MODEL_CONFIGS)
        .sort((a, b) => a[1].priority - b[1].priority)[0][0];
  
  let selectedModelConfig = MODEL_CONFIGS[selectedModelName];
  
  if (!selectedModelConfig) {
    throw new Error(`Model ${selectedModelName} not found in MODEL_CONFIGS`);
  }
  
  // Use optimized chunking based on model's token limits
  const chunks = splitSubtitlesOptimized(subtitleContent, selectedModelConfig);
  
  if (chunks.length === 0) {
    throw new Error('No subtitle chunks created');
  }
  
  console.log(`Translating ${chunks.length} chunk(s) with ${selectedModelName}`);
  console.log(`  Using API key: ${userApiKey ? 'User key' : 'Server key (fallback)'}`);
  console.log(`  Model limits: ${selectedModelConfig.rpm} RPM, ${(selectedModelConfig.tpm/1000).toFixed(0)}K TPM, ${selectedModelConfig.rpd} RPD`);
  
  // Calculate optimal delay between requests
  const requestDelay = calculateRequestDelay(selectedModelConfig);
  console.log(`  Request delay: ${requestDelay}ms between chunks`);
  
  // Translate chunk with retry logic and rate limiting
  async function translateChunk(chunk, chunkIndex) {
    const startTime = Date.now();
    
    const targetLanguageName = getLanguageName(targetLanguage);
    const prompt = `Translate subtitle dialogue to ${targetLanguageName}. Return ONLY subtitle content. No explanations.

Format: number, timing, text, blank line
Keep timing unchanged. Translate only dialogue. Start with number.

${chunk}`;

    const estimatedTokens = estimateTokens(prompt);
    
    // Enforce rate limits before request (non-blocking if under limit)
    await enforceRateLimits(selectedModelConfig);
    
    const retries = 5;
    const retryDelay = 2000;
    let lastError;
    
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        if (!apiKey) {
          throw new Error('OpenRouter API key not configured');
        }

        // Only log retries, not first attempt (reduce noise)
        if (attempt > 0) {
          console.log(`  📡 Chunk ${chunkIndex + 1}: Retrying API request (attempt ${attempt + 1}/${retries})...`);
        }
        const response = await axios.post(
          'https://openrouter.ai/api/v1/chat/completions',
          {
            model: selectedModelName,  // Use selected model
            messages: [
              {
                role: 'user',
                content: prompt
              }
            ],
            temperature: 0.3,
            max_tokens: selectedModelConfig.maxTokens * 4 // Allow much longer responses (4x) to prevent truncation
          },
          {
            headers: {
              'Authorization': `Bearer ${apiKey}`,  // Use user's or server's key
              'Content-Type': 'application/json',
              'HTTP-Referer': referer,  // Use user's or server's referer
              'X-Title': 'Stremio AI Subtitles'
            },
            timeout: 120000 // 2 minutes timeout
          }
        );

        // Check if response was truncated
        const finishReason = response.data.choices[0]?.finish_reason;
        if (finishReason === 'length') {
          console.log(`  ⚠️  Chunk ${chunkIndex + 1}: Response was truncated (hit max_tokens limit). Consider using smaller chunks.`);
        }

        let translatedContent = response.data.choices[0].message.content;
        
        // Handle empty or whitespace-only responses
        if (!translatedContent || !translatedContent.trim()) {
          throw new Error('API returned empty or whitespace-only response');
        }
        
        translatedContent = translatedContent.trim();
        
        // Clean markdown code blocks
        if (translatedContent.startsWith('```')) {
          translatedContent = translatedContent.replace(/```[\w]*\n?/g, '').replace(/```$/g, '').trim();
        }
        
        // Remove unwanted commentary and instructions from model output
        const lines = translatedContent.split('\n');
        const cleanedLines = [];
        let foundFirstSubtitle = false;
        const skipPatterns = [
          /^Here'?s? (the |is )?translation/i,
          /^Here is the translated/i,
          /^Here is the translation of/i,
          /^Note:/i,
          /^CRITICAL/i,
          /^Instructions?:/i,
          /^Translation:/i,
          /^கட்டுப்பாடுகள்:/i,
          /^மொழி பெயர்ப்பு:/i,
          /^மொழி பெயர்ப்பு$/i,
          /^RULES?:/i,
          /^Subtitle content:/i,
          /^Subtitle:/i,
          /^Format:/i,
          /^Keep timing/i,
          /^Translate only/i,
          /^Start with/i,
          /^\d+\.\s*(Return|Preserve|Keep|Translate|Do NOT|Start)/i,
          /^Note:.*$/i,
          /^மொழி பெயர்ப்பு:.*$/i,
          /^கட்டுப்பாடுகள்:.*$/i
        ];
        
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const trimmedLine = line.trim();
          
          // Skip empty lines at the start
          if (!foundFirstSubtitle && !trimmedLine) {
            continue;
          }
          
          // Check if this is the first subtitle entry (starts with number or timing)
          if (!foundFirstSubtitle) {
            if (trimmedLine.match(/^\d+$/) || trimmedLine.match(/^\d{2}:\d{2}:\d{2}/)) {
              foundFirstSubtitle = true;
              cleanedLines.push(line);
            } else if (skipPatterns.some(pattern => pattern.test(trimmedLine))) {
              // Skip commentary/instruction lines
              continue;
            } else if (trimmedLine && trimmedLine.length > 0) {
              // Include other content (might be part of subtitle)
              cleanedLines.push(line);
            }
          } else {
            // After first subtitle found, include all lines
            cleanedLines.push(line);
          }
        }
        
        // Join and remove trailing commentary
        translatedContent = cleanedLines.join('\n');
        // Remove common trailing patterns (multiline, more aggressive)
        translatedContent = translatedContent.replace(/\n\s*(Note:|Here is|Translation|மொழி பெயர்ப்பு|கட்டுப்பாடுகள்|Format|Keep|Translate|Start).*$/gim, '');
        // Remove instruction blocks (numbered lists)
        translatedContent = translatedContent.replace(/\n\s*\d+\.\s*(Return|Preserve|Keep|Translate|Do NOT|Start).*$/gim, '');
        // Remove any remaining Tamil instruction text
        translatedContent = translatedContent.replace(/\n\s*கட்டுப்பாடுகள்:.*$/gim, '');
        translatedContent = translatedContent.replace(/\n\s*மொழி பெயர்ப்பு:.*$/gim, '');
        translatedContent = translatedContent.trim();
        
        // Check if translation appears incomplete (ends mid-sentence or mid-subtitle)
        if (finishReason === 'length') {
          // Response was truncated - try to detect and fix incomplete subtitle entry
          const lines = translatedContent.split('\n');
          const lastLine = lines[lines.length - 1];
          
          // Check if last line is incomplete (doesn't end with proper subtitle format)
          // A complete subtitle entry should have: number, timing, text, empty line
          if (lastLine && lastLine.trim() && !lastLine.match(/^\s*$/)) {
            // Last line has content - check if it's a valid subtitle line
            const isTimingLine = lastLine.match(/^\d{2}:\d{2}:\d{2}/);
            const isNumberLine = lastLine.match(/^\d+$/);
            const isTextLine = !isTimingLine && !isNumberLine;
            
            // If it ends with text (not timing or number), it might be incomplete
            if (isTextLine && !translatedContent.match(/\n\s*$/)) {
              console.log(`  ⚠️  Chunk ${chunkIndex + 1}: Translation appears incomplete (ends mid-subtitle). Last line: "${lastLine.substring(0, 50)}..."`);
              // Try to remove the incomplete last subtitle entry
              // Find the last complete subtitle entry (ends with empty line)
              const lastEmptyLineIndex = translatedContent.lastIndexOf('\n\n');
              if (lastEmptyLineIndex > 0) {
                const beforeLastEntry = translatedContent.substring(0, lastEmptyLineIndex + 2);
                const incompleteEntry = translatedContent.substring(lastEmptyLineIndex + 2);
                // Only remove if incomplete entry is very short (likely incomplete)
                if (incompleteEntry.length < 100) {
                  console.log(`  🔧 Chunk ${chunkIndex + 1}: Removing incomplete last subtitle entry`);
                  translatedContent = beforeLastEntry.trim();
                }
              }
            }
          }
        }
        
        // Update rate limiter
        const responseTokens = estimateTokens(translatedContent);
        updateRateLimiter(estimatedTokens + responseTokens);
        
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`  ✅ Chunk ${chunkIndex + 1}/${chunks.length} translated (~${estimatedTokens + responseTokens} tokens) in ${elapsed}s`);
        return translatedContent;
      } catch (error) {
        lastError = error;
        const isRetryable = error.response?.status === 503 || 
                          error.response?.status === 429 ||
                          error.message.includes('timeout') ||
                          error.message.includes('ECONNRESET') ||
                          error.message.includes('empty');
        
        if (isRetryable && attempt < retries - 1) {
          const waitTime = retryDelay * Math.pow(2, attempt); // Exponential backoff
          console.log(`  ⚠️  Chunk ${chunkIndex + 1} failed (${error.message}), retrying in ${Math.round(waitTime/1000)}s... (attempt ${attempt + 1}/${retries})`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        } else {
          console.log(`  ❌ Chunk ${chunkIndex + 1} failed permanently: ${error.message}`);
          throw error;
        }
      }
    }
    throw lastError;
  }
  
  // Process ALL chunks in parallel (up to RPM limit)
  // With 60 RPM, we can process all ~20 chunks simultaneously
  // Simple approach: process everything in one big parallel batch
  const maxParallelRequests = Math.min(selectedModelConfig.rpm, chunks.length);
  
  console.log(`  Processing ${chunks.length} chunk(s) in parallel (${selectedModelConfig.rpm} RPM allows up to ${maxParallelRequests} parallel)`);
  
  const translatedChunks = new Array(chunks.length);
  const batch = [];
  
  // Create promises for all chunks with timeout protection
  for (let i = 0; i < chunks.length; i++) {
    const chunkPromise = translateChunk(chunks[i], i);
    
    // Add timeout wrapper (2 minutes max per chunk - should be enough for small chunks)
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Chunk ${i + 1} timed out after 2 minutes`)), 120000);
    });
    
    batch.push(
      Promise.race([chunkPromise, timeoutPromise])
        .then(result => ({ index: i, result }))
        .catch(error => {
          console.log(`  ❌ Chunk ${i + 1} error: ${error.message}`);
          // Return a placeholder so we don't block other chunks
          return { index: i, error, result: null };
        })
    );
  }
  
  // Wait for all chunks to complete
  console.log(`  ⏳ Processing all ${batch.length} chunk(s) in parallel...`);
  const batchResults = await Promise.all(batch);
  console.log(`  📦 All ${batch.length} chunk(s) completed`);
  
  // Store results in correct order and check for errors
  const errors = [];
  for (const { index, result, error } of batchResults) {
    if (error) {
      errors.push(`Chunk ${index + 1}: ${error.message}`);
      // Don't throw immediately - collect all errors first
      translatedChunks[index] = null; // Mark as failed
    } else {
      translatedChunks[index] = result;
    }
  }
  
  // If we have errors, log them but don't fail completely if we have some results
  if (errors.length > 0) {
    console.log(`  ⚠️  ${errors.length} chunk(s) failed:`, errors.join(', '));
    if (errors.length === chunks.length) {
      throw new Error(`All chunks failed: ${errors.join('; ')}`);
    }
    // Filter out null results (failed chunks)
    const validChunks = translatedChunks.filter(chunk => chunk !== null);
    if (validChunks.length === 0) {
      throw new Error(`All chunks failed: ${errors.join('; ')}`);
    }
    console.log(`  ✅ Continuing with ${validChunks.length}/${chunks.length} successful chunks`);
    return validChunks.join('\n\n');
  }
  
  console.log(`  ✅ All ${chunks.length} chunk(s) translated successfully`);
  
  console.log(`\n📊 Translation complete: ${rateLimiter.requestsToday} requests used today`);
  
  return translatedChunks.join('\n\n');
}

/**
 * Translate subtitles using OpenRouter AI (enhanced with automatic chunking)
 */
async function translateSubtitlesWithGemini(subtitleContent, targetLanguage, userConfig) {
  // Auto-detect if chunking is needed (large files > 20KB)
  const shouldChunk = subtitleContent.length > 20000;
  
  if (shouldChunk) {
    console.log(`Large subtitle file detected (${subtitleContent.length} chars), using intelligent token-based chunking...`);
    return await translateSubtitlesWithGeminiChunked(subtitleContent, targetLanguage, userConfig);
  }
  
  // Extract user's credentials
  const userApiKey = userConfig?.openrouter?.apiKey;
  const userReferer = userConfig?.openrouter?.referer;
  const apiKey = userApiKey || process.env.OPENROUTER_API_KEY;
  const referer = userReferer || process.env.OPENROUTER_REFERER || 'https://stremio-ai-subs.local';
  
  if (!apiKey) {
    throw new Error(
      'OpenRouter API key not configured. ' +
      'Please visit the configuration page and add your OpenRouter API key.'
    );
  }
  
  // Use user's preferred model or currentModelName
  const preferredModel = userConfig?.translation?.model;
  const modelName = preferredModel && preferredModel !== 'auto' 
    ? preferredModel 
    : currentModelName;
  const modelConfig = MODEL_CONFIGS[modelName] || currentModelConfig;
  
  try {
    const targetLanguageName = getLanguageName(targetLanguage);
    const prompt = `Translate the following subtitle file to ${targetLanguageName}. 
    
CRITICAL INSTRUCTIONS:
1. Preserve the exact subtitle format (SRT or VTT)
2. Keep all timing codes exactly as they are (e.g., 00:00:00,000 --> 00:00:05,000)
3. Only translate the text content, not the numbers or timing information
4. Maintain the same structure and line breaks
5. Do not add or remove subtitle entries

Subtitle content:
${subtitleContent}`;

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
          'HTTP-Referer': referer,
          'X-Title': 'Stremio AI Subtitles'
        },
        timeout: 120000
      }
    );

    let cleanedContent = response.data.choices[0].message.content.trim();
    if (cleanedContent.startsWith('```')) {
      cleanedContent = cleanedContent.replace(/```[\w]*\n?/g, '').replace(/```$/g, '').trim();
    }
    
    return cleanedContent;
  } catch (error) {
    console.error('Error translating subtitles with OpenRouter:', error.message);
    throw error;
  }
}

/**
 * Convert subtitle content to VTT format
 */
function convertToVTT(content, currentFormat) {
  if (!content) {
    console.log('convertToVTT: No content provided');
    return null;
  }
  
  // If already VTT format, ensure it has WEBVTT header
  if (currentFormat === 'vtt' || currentFormat === 'webvtt') {
    if (!content.trim().startsWith('WEBVTT')) {
      return 'WEBVTT\n\n' + content;
    }
    return content;
  }
  
  // Convert SRT to VTT (manual conversion)
  if (currentFormat === 'srt' || currentFormat === 'sub') {
    try {
      // Convert SRT format to VTT format
      // SRT: number, timing (comma), text, blank line
      // VTT: timing (dot), text, blank line
      let vttContent = content
        // Remove subtitle numbers (lines that are just digits)
        .replace(/^\d+\s*$/gm, '')
        // Convert comma to dot in timestamps
        .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
        // Ensure proper VTT timing format
        .replace(/(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/g, '$1 --> $2')
        // Clean up multiple blank lines
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      
      // Ensure WEBVTT header is present
      if (!vttContent.startsWith('WEBVTT')) {
        vttContent = 'WEBVTT\n\n' + vttContent;
      }
      
      return vttContent;
    } catch (error) {
      console.error('Error converting to VTT:', error.message);
      return null;
    }
  }
  
  // For other formats, return as is with WEBVTT header
  if (!content.trim().startsWith('WEBVTT')) {
    return 'WEBVTT\n\n' + content;
  }
  return content;
}

/**
 * Serve subtitle content and return URL
 */
async function serveSubtitleContent(content, language, type, id, season, episode) {
  if (!content) {
    return null;
  }
  
  // Generate unique subtitle ID
  const subtitleId = `${type}_${id}_${season || ''}_${episode || ''}_${language}_${Date.now()}`;
  
  // Store in cache
  global.subtitleCache[subtitleId] = content;
  
  // Return URL endpoint for serving subtitle
  const baseUrl = process.env.BASE_URL || `http://127.0.0.1:${process.env.PORT || 7000}`;
  return `${baseUrl}/subtitle/${subtitleId}.vtt`;
}

// ============================================================================
// Express Routes
// ============================================================================

/**
 * Serve subtitle files
 */
app.get('/subtitle/:id.vtt', (req, res) => {
  const subtitleId = req.params.id;
  
  console.log(`Subtitle request for ID: ${subtitleId}`);
  console.log(`Cache has ${Object.keys(global.subtitleCache || {}).length} entries`);
  
  if (global.subtitleCache && global.subtitleCache[subtitleId]) {
    const content = global.subtitleCache[subtitleId];
    console.log(`Serving subtitle ${subtitleId}, length: ${content.length} chars`);
    
    // Ensure VTT header is present
    let vttContent = content;
    if (!vttContent.startsWith('WEBVTT')) {
      vttContent = 'WEBVTT\n\n' + vttContent;
    }
    
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.send(vttContent);
  } else {
    console.log(`Subtitle ${subtitleId} not found in cache`);
    res.status(404).setHeader('Content-Type', 'text/plain');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send('Subtitle not found');
  }
});

// Handle OPTIONS for CORS preflight
app.options('/subtitle/:id.vtt', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(200);
});

/**
 * Generate or get UUID for user configuration
 */
function getOrCreateUuid(userId) {
  if (!configUuids[userId]) {
    configUuids[userId] = uuidv4();
  }
  return configUuids[userId];
}

/**
 * Get UUID from encrypted config or create new one
 */
function getUuidFromConfig(encryptedConfig) {
  if (!encryptedConfig) {
    return null;
  }
  try {
    const config = decryptConfig(encryptedConfig);
    return config?.uuid || null;
  } catch (error) {
    return null;
  }
}

/**
 * Validate UUID format (UUID v4)
 */
function isValidUUID(uuid) {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

/**
 * Generate error page HTML with theme matching
 */
function generateErrorPage(title, message) {
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${title} - AI Subtitle Translator</title>
      <script src="https://cdn.tailwindcss.com"></script>
      <script>
        tailwind.config = {
          darkMode: 'class',
          theme: {
            extend: {
              colors: {
                border: "hsl(var(--border))",
                input: "hsl(var(--input))",
                ring: "hsl(var(--ring))",
                background: "hsl(var(--background))",
                foreground: "hsl(var(--foreground))",
                primary: {
                  DEFAULT: "hsl(var(--primary))",
                  foreground: "hsl(var(--primary-foreground))",
                },
                secondary: {
                  DEFAULT: "hsl(var(--secondary))",
                  foreground: "hsl(var(--secondary-foreground))",
                },
                destructive: {
                  DEFAULT: "hsl(var(--destructive))",
                  foreground: "hsl(var(--destructive-foreground))",
                },
                muted: {
                  DEFAULT: "hsl(var(--muted))",
                  foreground: "hsl(var(--muted-foreground))",
                },
                accent: {
                  DEFAULT: "hsl(var(--accent))",
                  foreground: "hsl(var(--accent-foreground))",
                },
                popover: {
                  DEFAULT: "hsl(var(--popover))",
                  foreground: "hsl(var(--popover-foreground))",
                },
                card: {
                  DEFAULT: "hsl(var(--card))",
                  foreground: "hsl(var(--card-foreground))",
                },
              },
              borderRadius: {
                lg: "var(--radius)",
                md: "calc(var(--radius) - 2px)",
                sm: "calc(var(--radius) - 4px)",
              },
            },
          },
        }
      </script>
      <style>
        :root {
          --background: 0 0% 3.9%;
          --foreground: 0 0% 98%;
          --card: 0 0% 7%;
          --card-foreground: 0 0% 98%;
          --popover: 0 0% 7%;
          --popover-foreground: 0 0% 98%;
          --primary: 221.2 83.2% 53.3%;
          --primary-foreground: 210 40% 98%;
          --secondary: 0 0% 14.9%;
          --secondary-foreground: 0 0% 98%;
          --muted: 0 0% 14.9%;
          --muted-foreground: 0 0% 63.9%;
          --accent: 0 0% 14.9%;
          --accent-foreground: 0 0% 98%;
          --destructive: 0 62.8% 30.6%;
          --destructive-foreground: 0 0% 98%;
          --border: 0 0% 14.9%;
          --input: 0 0% 14.9%;
          --ring: 221.2 83.2% 53.3%;
          --radius: 0.5rem;
        }
        
        * {
          border-color: hsl(var(--border));
        }
        
        body {
          background-color: hsl(var(--background));
          color: hsl(var(--foreground));
          font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif;
        }
        
        @keyframes slideIn {
          from {
            opacity: 0;
            transform: translateY(-10px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        
        .animate-slide-in {
          animation: slideIn 0.3s ease-out;
        }
      </style>
    </head>
    <body class="min-h-screen" style="background-color: hsl(var(--background)); color: hsl(var(--foreground));">
      <div class="min-h-screen flex items-center justify-center p-4 sm:p-6 lg:p-8" style="border-width: 1px; border-color: rgba(0, 0, 0, 1);">
        <div class="w-full max-w-md animate-slide-in">
          <div class="bg-[hsl(var(--card))] border border-[hsl(var(--destructive))] rounded-xl shadow-2xl overflow-hidden">
            <div class="p-8 text-center">
              <div class="w-16 h-16 mx-auto mb-4 bg-[hsl(var(--destructive))] rounded-full flex items-center justify-center" style="background-color: rgba(204, 30, 30, 1);">
                <svg class="w-8 h-8 text-[hsl(var(--destructive-foreground))]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path>
                </svg>
              </div>
              <h1 class="text-2xl sm:text-3xl font-semibold text-[hsl(var(--foreground))] mb-2">${title}</h1>
              <p class="text-[hsl(var(--muted-foreground))] text-sm sm:text-base mb-6">${message}</p>
              <a 
                href="/configure" 
                class="inline-flex items-center justify-center px-5 py-2.5 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg shadow-sm transition-all hover:shadow-md focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:ring-offset-[hsl(var(--background))]"
              >
                <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path>
                </svg>
                Create New Configuration
              </a>
            </div>
          </div>
        </div>
      </div>
    </body>
    </html>
  `;
}

/**
 * Configuration page - Built with shadcn-inspired components
 */
app.get('/stremio/:uuid/:encryptedConfig/configure', (req, res) => {
  const { uuid, encryptedConfig } = req.params;
  const menu = req.query.menu || 'languages';
  
  // Validate UUID format
  if (!isValidUUID(uuid)) {
    return res.status(400).send(generateErrorPage(
      'Invalid Configuration',
      'The configuration ID is invalid or malformed.'
    ));
  }
  
  // Decrypt config or create new
  let config = null;
  let userId = uuid;
  
  if (encryptedConfig && encryptedConfig !== 'new') {
    config = decryptConfig(encryptedConfig);
    
    // If decryption fails, return error
    if (!config) {
      return res.status(400).send(generateErrorPage(
        'Invalid Configuration',
        'The encrypted configuration is invalid or corrupted. Please create a new configuration.'
      ));
    }
    
    // Validate that the UUID in the decrypted config matches the URL UUID
    if (config.uuid && config.uuid !== uuid) {
      return res.status(400).send(generateErrorPage(
        'Invalid Configuration',
        'The configuration ID does not match. This configuration may belong to a different user.'
      ));
    }
    
    userId = config.uuid || uuid;
  }
  
  // Get or create preferences
  if (!userPreferences[userId]) {
    userPreferences[userId] = { 
      languages: ['en'], 
      uuid: userId,
      openrouter: {
        apiKey: '',  // Empty by default
        referer: process.env.OPENROUTER_REFERER || ''
      },
      translation: {
        enabled: false,
        model: 'auto'
      }
    };
  }
  
  const currentPrefs = userPreferences[userId];
  const selectedLangs = currentPrefs.languages || ['en'];
  const saved = req.query.saved === 'true';
  
  // Build manifest URL for installation
  const baseUrl = process.env.BASE_URL || `http://${req.get('host')}`;
  const manifestUrl = `${baseUrl}/stremio/${uuid}/${encryptedConfig}/manifest.json`;
  
  // Comprehensive list of languages with their names
  const languages = [
    { code: 'en', name: 'English', flag: '🇬🇧' },
    { code: 'es', name: 'Spanish', flag: '🇪🇸' },
    { code: 'fr', name: 'French', flag: '🇫🇷' },
    { code: 'de', name: 'German', flag: '🇩🇪' },
    { code: 'it', name: 'Italian', flag: '🇮🇹' },
    { code: 'pt', name: 'Portuguese', flag: '🇵🇹' },
    { code: 'ru', name: 'Russian', flag: '🇷🇺' },
    { code: 'ja', name: 'Japanese', flag: '🇯🇵' },
    { code: 'ko', name: 'Korean', flag: '🇰🇷' },
    { code: 'zh', name: 'Chinese', flag: '🇨🇳' },
    { code: 'ar', name: 'Arabic', flag: '🇸🇦' },
    { code: 'hi', name: 'Hindi', flag: '🇮🇳' },
    { code: 'nl', name: 'Dutch', flag: '🇳🇱' },
    { code: 'sv', name: 'Swedish', flag: '🇸🇪' },
    { code: 'no', name: 'Norwegian', flag: '🇳🇴' },
    { code: 'da', name: 'Danish', flag: '🇩🇰' },
    { code: 'fi', name: 'Finnish', flag: '🇫🇮' },
    { code: 'pl', name: 'Polish', flag: '🇵🇱' },
    { code: 'tr', name: 'Turkish', flag: '🇹🇷' },
    { code: 'vi', name: 'Vietnamese', flag: '🇻🇳' },
    { code: 'th', name: 'Thai', flag: '🇹🇭' },
    { code: 'id', name: 'Indonesian', flag: '🇮🇩' },
    { code: 'ms', name: 'Malay', flag: '🇲🇾' },
    { code: 'cs', name: 'Czech', flag: '🇨🇿' },
    { code: 'hu', name: 'Hungarian', flag: '🇭🇺' },
    { code: 'ro', name: 'Romanian', flag: '🇷🇴' },
    { code: 'el', name: 'Greek', flag: '🇬🇷' },
    { code: 'he', name: 'Hebrew', flag: '🇮🇱' },
    { code: 'uk', name: 'Ukrainian', flag: '🇺🇦' },
    { code: 'bg', name: 'Bulgarian', flag: '🇧🇬' },
    { code: 'hr', name: 'Croatian', flag: '🇭🇷' },
    { code: 'sk', name: 'Slovak', flag: '🇸🇰' },
    { code: 'sl', name: 'Slovenian', flag: '🇸🇮' },
    { code: 'sr', name: 'Serbian', flag: '🇷🇸' },
    { code: 'ca', name: 'Catalan', flag: '🇪🇸' },
    { code: 'eu', name: 'Basque', flag: '🇪🇸' },
    { code: 'fa', name: 'Persian', flag: '🇮🇷' },
    { code: 'ur', name: 'Urdu', flag: '🇵🇰' },
    { code: 'bn', name: 'Bengali', flag: '🇧🇩' },
    { code: 'ta', name: 'Tamil', flag: '🇮🇳' },
    { code: 'te', name: 'Telugu', flag: '🇮🇳' },
    { code: 'ml', name: 'Malayalam', flag: '🇮🇳' },
    { code: 'kn', name: 'Kannada', flag: '🇮🇳' }
  ];
  
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>AI Subtitle Translator - Configuration</title>
      <script src="https://cdn.tailwindcss.com"></script>
      <script>
        tailwind.config = {
          darkMode: 'class',
          theme: {
            extend: {
              colors: {
                border: "hsl(var(--border))",
                input: "hsl(var(--input))",
                ring: "hsl(var(--ring))",
                background: "hsl(var(--background))",
                foreground: "hsl(var(--foreground))",
                primary: {
                  DEFAULT: "hsl(var(--primary))",
                  foreground: "hsl(var(--primary-foreground))",
                },
                secondary: {
                  DEFAULT: "hsl(var(--secondary))",
                  foreground: "hsl(var(--secondary-foreground))",
                },
                destructive: {
                  DEFAULT: "hsl(var(--destructive))",
                  foreground: "hsl(var(--destructive-foreground))",
                },
                muted: {
                  DEFAULT: "hsl(var(--muted))",
                  foreground: "hsl(var(--muted-foreground))",
                },
                accent: {
                  DEFAULT: "hsl(var(--accent))",
                  foreground: "hsl(var(--accent-foreground))",
                },
                popover: {
                  DEFAULT: "hsl(var(--popover))",
                  foreground: "hsl(var(--popover-foreground))",
                },
                card: {
                  DEFAULT: "hsl(var(--card))",
                  foreground: "hsl(var(--card-foreground))",
                },
              },
              borderRadius: {
                lg: "var(--radius)",
                md: "calc(var(--radius) - 2px)",
                sm: "calc(var(--radius) - 4px)",
              },
            },
          },
        }
      </script>
      <style>
        :root {
          --background: 0 0% 3.9%;
          --foreground: 0 0% 98%;
          --card: 0 0% 7%;
          --card-foreground: 0 0% 98%;
          --popover: 0 0% 7%;
          --popover-foreground: 0 0% 98%;
          --primary: 221.2 83.2% 53.3%;
          --primary-foreground: 210 40% 98%;
          --secondary: 0 0% 14.9%;
          --secondary-foreground: 0 0% 98%;
          --muted: 0 0% 14.9%;
          --muted-foreground: 0 0% 63.9%;
          --accent: 0 0% 14.9%;
          --accent-foreground: 0 0% 98%;
          --destructive: 0 62.8% 30.6%;
          --destructive-foreground: 0 0% 98%;
          --border: 0 0% 14.9%;
          --input: 0 0% 14.9%;
          --ring: 221.2 83.2% 53.3%;
          --radius: 0.5rem;
        }
        
        * {
          border-color: hsl(var(--border));
        }
        
        body {
          background-color: hsl(var(--background));
          color: hsl(var(--foreground));
          font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif;
        }
        
        @keyframes slideIn {
          from {
            opacity: 0;
            transform: translateY(-10px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        
        .animate-slide-in {
          animation: slideIn 0.3s ease-out;
        }
        
        .checkbox-custom {
          appearance: none;
          width: 1rem;
          height: 1rem;
          border: 2px solid hsl(var(--border));
          border-radius: calc(var(--radius) - 4px);
          background-color: hsl(var(--background));
          cursor: pointer;
          position: relative;
          transition: all 0.2s;
        }
        
        .checkbox-custom:checked {
          background-color: hsl(var(--primary));
          border-color: hsl(var(--primary));
        }
        
        .checkbox-custom:checked::after {
          content: "✓";
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          color: hsl(var(--primary-foreground));
          font-size: 0.75rem;
          font-weight: bold;
        }
      </style>
    </head>
    <body class="min-h-screen" style="background-color: hsl(var(--background)); color: hsl(var(--foreground));">
      <div class="min-h-screen flex items-center justify-center p-4 sm:p-6 lg:p-8">
        <div class="w-full max-w-5xl animate-slide-in">
          <!-- Main Card -->
          <div class="bg-[hsl(var(--card))] border border-[hsl(var(--border))] rounded-xl shadow-2xl overflow-hidden">
            <!-- Header -->
            <div class="bg-[hsl(var(--card))] px-6 py-6 sm:px-8 sm:py-8 border-b border-[hsl(var(--border))]">
              <div>
                <h1 class="text-2xl sm:text-3xl font-semibold text-[hsl(var(--foreground))] mb-1">AI Subtitle Translator</h1>
                <p class="text-[hsl(var(--muted-foreground))] text-sm sm:text-base">Select your preferred subtitle languages</p>
              </div>
            </div>
            
            <!-- Content -->
            <div class="p-6 sm:p-8 bg-[hsl(var(--card))]">
              <!-- Info Banner -->
              <div class="mb-6 p-4 bg-[hsl(var(--muted))] border border-[hsl(var(--border))] rounded-lg">
                <div class="flex items-start gap-3">
                  <svg class="w-5 h-5 text-indigo-400 flex-shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                    <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clip-rule="evenodd"/>
                  </svg>
                  <div class="text-sm text-[hsl(var(--muted-foreground))]">
                    <strong class="font-semibold text-[hsl(var(--foreground))]">How it works:</strong> The addon will first try to fetch subtitles in your selected languages. If not available, it will automatically translate English subtitles using AI (OpenRouter).
                  </div>
                </div>
              </div>
              
              <form method="POST" action="/stremio/${uuid}/${encryptedConfig}/configure" id="configForm">
                <input type="hidden" name="userId" value="${userId}">
                <input type="hidden" name="uuid" value="${uuid}">
                
                <!-- Search -->
                <div class="mb-6">
                  <div class="relative">
                    <div class="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                      <svg class="h-5 w-5 text-[hsl(var(--muted-foreground))]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path>
                      </svg>
                    </div>
                    <input 
                      type="text" 
                      id="searchInput"
                      class="w-full pl-10 pr-4 py-2.5 bg-[hsl(var(--background))] border border-[hsl(var(--input))] rounded-lg text-[hsl(var(--foreground))] placeholder:text-[hsl(var(--muted-foreground))] focus:outline-none focus:ring-2 focus:ring-[hsl(var(--ring))] focus:border-transparent transition-all"
                      placeholder="Search languages..."
                      autocomplete="off"
                    >
                  </div>
                </div>
                
                <!-- Toolbar -->
                <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
                  <div class="flex flex-wrap gap-2">
                    <button 
                      type="button" 
                      onclick="selectAll()"
                      class="px-4 py-2 text-sm font-medium text-[hsl(var(--foreground))] bg-[hsl(var(--secondary))] border border-[hsl(var(--border))] rounded-lg hover:bg-[hsl(var(--accent))] transition-colors"
                    >
                      Select All
                    </button>
                    <button 
                      type="button" 
                      onclick="deselectAll()"
                      class="px-4 py-2 text-sm font-medium text-[hsl(var(--foreground))] bg-[hsl(var(--secondary))] border border-[hsl(var(--border))] rounded-lg hover:bg-[hsl(var(--accent))] transition-colors"
                    >
                      Deselect All
                    </button>
                    <button 
                      type="button" 
                      onclick="selectPopular()"
                      class="px-4 py-2 text-sm font-medium text-[hsl(var(--foreground))] bg-[hsl(var(--secondary))] border border-[hsl(var(--border))] rounded-lg hover:bg-[hsl(var(--accent))] transition-colors"
                    >
                      Popular
                    </button>
                  </div>
                  <div class="flex items-center gap-2 px-4 py-2 bg-indigo-500/20 text-indigo-300 rounded-lg border border-indigo-500/30">
                    <span class="text-xl font-bold" id="selectedCount">0</span>
                    <span class="text-sm font-medium">selected</span>
                  </div>
                </div>
                
                <!-- Languages Grid -->
                <div class="mb-6">
                  <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2.5 max-h-[520px] overflow-y-auto p-1" id="languagesGrid">
                    ${languages.map(lang => `
                      <label 
                        class="group relative flex items-center gap-3 p-3 rounded-lg border transition-all cursor-pointer ${
                          selectedLangs.includes(lang.code) 
                            ? 'border-indigo-500 bg-indigo-500/10 shadow-md' 
                            : 'border-[hsl(var(--border))] bg-[hsl(var(--card))] hover:border-indigo-500/40 hover:bg-[hsl(var(--accent))]'
                        }"
                        data-lang="${lang.code}"
                        data-name="${lang.name.toLowerCase()}"
                      >
                        <input 
                          type="checkbox" 
                          name="languages" 
                          value="${lang.code}"
                          ${selectedLangs.includes(lang.code) ? 'checked' : ''}
                          onchange="updateSelection()"
                          class="sr-only"
                        >
                        <div class="flex-shrink-0 w-8 h-8 rounded-md bg-[hsl(var(--muted))] flex items-center justify-center text-xl">
                          ${lang.flag}
                        </div>
                        <div class="flex-1 min-w-0">
                          <div class="font-medium text-sm text-[hsl(var(--foreground))] truncate">${lang.name}</div>
                          <div class="text-xs text-[hsl(var(--muted-foreground))] uppercase tracking-wider mt-0.5">${lang.code}</div>
                        </div>
                        <div class="flex-shrink-0 w-5 h-5 rounded border-2 flex items-center justify-center transition-all ${
                          selectedLangs.includes(lang.code)
                            ? 'bg-indigo-500 border-indigo-500'
                            : 'border-[hsl(var(--border))] bg-[hsl(var(--background))] group-hover:border-indigo-500/50'
                        }">
                          ${selectedLangs.includes(lang.code) ? `
                            <svg class="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"></path>
                            </svg>
                          ` : ''}
                        </div>
                      </label>
                    `).join('')}
                  </div>
                </div>
                
                <!-- OpenRouter API Configuration Section -->
                <div class="bg-[hsl(var(--card))] border border-[hsl(var(--border))] rounded-lg p-6 mb-6">
                  <h2 class="text-xl font-semibold mb-4">OpenRouter API Configuration</h2>
                  <p class="text-[hsl(var(--muted-foreground))] text-sm mb-4">
                    Enter your OpenRouter API key to enable AI translation. 
                    <a href="https://openrouter.ai/keys" target="_blank" class="text-[hsl(var(--primary))] hover:underline">
                      Get your API key here
                    </a>
                  </p>
                  
                  <div class="mb-4">
                    <label for="openrouterApiKey" class="block text-sm font-medium mb-2">
                      OpenRouter API Key <span class="text-red-500">*</span>
                    </label>
                    <input 
                      type="password" 
                      id="openrouterApiKey" 
                      name="openrouterApiKey" 
                      placeholder="sk-or-v1-..."
                      value="${currentPrefs.openrouter?.apiKey ? '***' + currentPrefs.openrouter.apiKey.slice(-4) : ''}"
                      class="w-full px-3 py-2 bg-[hsl(var(--background))] border border-[hsl(var(--border))] rounded-md text-[hsl(var(--foreground))]"
                      autocomplete="off"
                    >
                    <p class="text-xs text-[hsl(var(--muted-foreground))] mt-1">
                      Your API key is encrypted and stored securely. Required for AI translation.
                    </p>
                  </div>
                  
                  <div class="mb-4">
                    <label for="openrouterReferer" class="block text-sm font-medium mb-2">
                      HTTP Referer (Optional)
                    </label>
                    <input 
                      type="text" 
                      id="openrouterReferer" 
                      name="openrouterReferer" 
                      placeholder="https://your-app.com"
                      value="${currentPrefs.openrouter?.referer || process.env.OPENROUTER_REFERER || ''}"
                      class="w-full px-3 py-2 bg-[hsl(var(--background))] border border-[hsl(var(--border))] rounded-md text-[hsl(var(--foreground))]"
                    >
                    <p class="text-xs text-[hsl(var(--muted-foreground))] mt-1">
                      Your app URL or name. Used by OpenRouter for analytics.
                    </p>
                  </div>
                  
                  <div class="mb-4">
                    <label for="translationModel" class="block text-sm font-medium mb-2">
                      Translation Model (Optional)
                    </label>
                    <select 
                      id="translationModel" 
                      name="translationModel"
                      class="w-full px-3 py-2 bg-[hsl(var(--background))] border border-[hsl(var(--border))] rounded-md text-[hsl(var(--foreground))]"
                    >
                      <option value="auto" ${currentPrefs.translation?.model === 'auto' ? 'selected' : ''}>
                        Auto (Best Available)
                      </option>
                      <option value="meta-llama/llama-3.1-8b-instruct" ${currentPrefs.translation?.model === 'meta-llama/llama-3.1-8b-instruct' ? 'selected' : ''}>
                        Llama 3.1 8B
                      </option>
                      <option value="google/gemma-2-9b-it" ${currentPrefs.translation?.model === 'google/gemma-2-9b-it' ? 'selected' : ''}>
                        Gemma 2 9B
                      </option>
                      <option value="google/gemma-2-2b-it" ${currentPrefs.translation?.model === 'google/gemma-2-2b-it' ? 'selected' : ''}>
                        Gemma 2 2B
                      </option>
                      <option value="google/gemma-2-1.1b-it" ${currentPrefs.translation?.model === 'google/gemma-2-1.1b-it' ? 'selected' : ''}>
                        Gemma 2 1.1B
                      </option>
                      <option value="mistralai/mistral-7b-instruct" ${currentPrefs.translation?.model === 'mistralai/mistral-7b-instruct' ? 'selected' : ''}>
                        Mistral 7B
                      </option>
                    </select>
                    <p class="text-xs text-[hsl(var(--muted-foreground))] mt-1">
                      Choose a specific model or let the system auto-select the best available.
                    </p>
                  </div>
                  
                  ${!currentPrefs.openrouter?.apiKey ? `
                    <div class="bg-yellow-900/20 border border-yellow-700/50 rounded-md p-3 mb-4">
                      <p class="text-yellow-200 text-sm">
                        <strong>⚠️ Translation Disabled</strong><br>
                        Add your OpenRouter API key to enable AI subtitle translation.
                      </p>
                    </div>
                  ` : `
                    <div class="bg-green-900/20 border border-green-700/50 rounded-md p-3 mb-4">
                      <p class="text-green-200 text-sm">
                        <strong>✅ Translation Enabled</strong><br>
                        Your OpenRouter API key is configured. Translation will use your account credits.
                      </p>
                    </div>
                  `}
                </div>
                
                <!-- Actions -->
                <div class="flex justify-end gap-3 pt-4 border-t border-[hsl(var(--border))]">
                  <button 
                    type="button" 
                    onclick="window.location.reload()"
                    class="px-5 py-2.5 text-sm font-medium text-[hsl(var(--foreground))] bg-[hsl(var(--secondary))] border border-[hsl(var(--border))] rounded-lg hover:bg-[hsl(var(--accent))] transition-colors"
                  >
                    Reset
                  </button>
                  <button 
                    type="submit"
                    class="px-5 py-2.5 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg shadow-sm transition-all hover:shadow-md focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:ring-offset-[hsl(var(--background))]"
                  >
                    Save Configuration
                  </button>
                </div>
              </form>
              
              ${saved ? `
        <!-- Success Message & Installation Buttons -->
        <div class="mt-6 p-6 bg-[hsl(var(--card))] border border-[hsl(var(--border))] rounded-lg">
          <div class="flex items-center gap-3 mb-4">
            <div class="w-8 h-8 bg-green-500 rounded-full flex items-center justify-center text-white text-sm font-bold flex-shrink-0">✓</div>
            <div class="text-sm font-medium text-[hsl(var(--foreground))]">Configuration saved successfully!</div>
          </div>
          
          <div class="space-y-3">
            <div class="text-sm font-medium text-[hsl(var(--muted-foreground))] mb-3">Install this addon:</div>
            
            <div class="flex flex-col sm:flex-row gap-3">
              <a 
                href="stremio://${req.get('host')}/stremio/${uuid}/${encryptedConfig}/manifest.json"
                class="flex-1 px-4 py-3 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-all hover:shadow-md flex items-center justify-center gap-2"
              >
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                </svg>
                Add to Stremio Desktop
              </a>
              
              <a 
                href="https://app.strem.io/shell-v4.4/#/addons?addon=${encodeURIComponent(manifestUrl)}"
                target="_blank"
                rel="noopener noreferrer"
                class="flex-1 px-4 py-3 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-all hover:shadow-md flex items-center justify-center gap-2"
              >
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9"></path>
                </svg>
                Add to Stremio Web
              </a>
              
              <button 
                onclick="copyAddonUrl()"
                id="copyUrlBtn"
                class="px-4 py-3 text-sm font-medium text-[hsl(var(--foreground))] bg-[hsl(var(--secondary))] border border-[hsl(var(--border))] rounded-lg hover:bg-[hsl(var(--accent))] transition-colors flex items-center justify-center gap-2"
              >
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"></path>
                </svg>
                <span id="copyUrlText">Copy URL</span>
              </button>
            </div>
            
            <div class="mt-4 p-3 bg-[hsl(var(--muted))] rounded-lg">
              <div class="text-xs text-[hsl(var(--muted-foreground))] mb-1">Addon URL:</div>
              <div class="text-xs font-mono text-[hsl(var(--foreground))] break-all" id="addonUrl">${manifestUrl}</div>
            </div>
          </div>
        </div>
        
        <script>
          function copyAddonUrl() {
            const url = document.getElementById('addonUrl').textContent;
            navigator.clipboard.writeText(url).then(() => {
              const btn = document.getElementById('copyUrlBtn');
              const text = document.getElementById('copyUrlText');
              const originalText = text.textContent;
              text.textContent = 'Copied!';
              btn.classList.add('bg-green-500/20', 'border-green-500/50');
              setTimeout(() => {
                text.textContent = originalText;
                btn.classList.remove('bg-green-500/20', 'border-green-500/50');
              }, 2000);
            }).catch(err => {
              console.error('Failed to copy:', err);
              alert('Failed to copy URL. Please copy manually.');
            });
          }
        </script>
              ` : ''}
            </div>
          </div>
        </div>
      </div>
      
      <script>
        const searchInput = document.getElementById('searchInput');
        const selectedCount = document.getElementById('selectedCount');
        const languageLabels = document.querySelectorAll('label[data-lang]');
        
        function updateSelection() {
          const checked = document.querySelectorAll('input[name="languages"]:checked').length;
          selectedCount.textContent = checked;
          
          languageLabels.forEach(label => {
            const checkbox = label.querySelector('input[type="checkbox"]');
            const checkmark = label.querySelector('.flex-shrink-0.w-5.h-5');
            const checkmarkSvg = checkmark.querySelector('svg');
            
            if (checkbox.checked) {
              label.classList.remove('border-[hsl(var(--border))]', 'bg-[hsl(var(--card))]', 'hover:border-indigo-500/40', 'hover:bg-[hsl(var(--accent))]');
              label.classList.add('border-indigo-500', 'bg-indigo-500/10', 'shadow-md');
              checkmark.classList.remove('border-[hsl(var(--border))]', 'bg-[hsl(var(--background))]', 'group-hover:border-indigo-500/50');
              checkmark.classList.add('bg-indigo-500', 'border-indigo-500');
              if (!checkmarkSvg) {
                const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                svg.setAttribute('class', 'w-3 h-3 text-white');
                svg.setAttribute('fill', 'none');
                svg.setAttribute('stroke', 'currentColor');
                svg.setAttribute('viewBox', '0 0 24 24');
                const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                path.setAttribute('stroke-linecap', 'round');
                path.setAttribute('stroke-linejoin', 'round');
                path.setAttribute('stroke-width', '3');
                path.setAttribute('d', 'M5 13l4 4L19 7');
                svg.appendChild(path);
                checkmark.appendChild(svg);
              }
            } else {
              label.classList.remove('border-indigo-500', 'bg-indigo-500/10', 'shadow-md');
              label.classList.add('border-[hsl(var(--border))]', 'bg-[hsl(var(--card))]', 'hover:border-indigo-500/40', 'hover:bg-[hsl(var(--accent))]');
              checkmark.classList.remove('bg-indigo-500', 'border-indigo-500');
              checkmark.classList.add('border-[hsl(var(--border))]', 'bg-[hsl(var(--background))]', 'group-hover:border-indigo-500/50');
              if (checkmarkSvg) checkmarkSvg.remove();
            }
          });
        }
        
        function selectAll() {
          document.querySelectorAll('input[name="languages"]').forEach(cb => cb.checked = true);
          updateSelection();
        }
        
        function deselectAll() {
          document.querySelectorAll('input[name="languages"]').forEach(cb => cb.checked = false);
          updateSelection();
        }
        
        function selectPopular() {
          deselectAll();
          const popular = ['en', 'es', 'fr', 'de', 'it', 'pt', 'ru', 'ja', 'ko', 'zh', 'ar', 'hi'];
          popular.forEach(code => {
            const checkbox = document.querySelector(\`input[value="\${code}"]\`);
            if (checkbox) checkbox.checked = true;
          });
          updateSelection();
        }
        
        searchInput.addEventListener('input', (e) => {
          const searchTerm = e.target.value.toLowerCase();
          languageLabels.forEach(label => {
            const name = label.dataset.name;
            const code = label.dataset.lang;
            if (name.includes(searchTerm) || code.includes(searchTerm)) {
              label.style.display = '';
            } else {
              label.style.display = 'none';
            }
          });
        });
        
        updateSelection();
      </script>
    </body>
    </html>
  `);
});

/**
 * Handle configuration form submission
 */
app.post('/stremio/:uuid/:encryptedConfig/configure', (req, res) => {
  const { uuid, encryptedConfig } = req.params;
  
  // Validate UUID format
  if (!isValidUUID(uuid)) {
    return res.status(400).send(generateErrorPage(
      'Invalid Configuration',
      'The configuration ID is invalid or malformed.'
    ));
  }
  
  // Validate encrypted config if it's not 'new'
  if (encryptedConfig && encryptedConfig !== 'new') {
    const config = decryptConfig(encryptedConfig);
    
    // If decryption fails, return error
    if (!config) {
      return res.status(400).send(generateErrorPage(
        'Invalid Configuration',
        'The encrypted configuration is invalid or corrupted. Please create a new configuration.'
      ));
    }
    
    // Validate that the UUID in the decrypted config matches the URL UUID
    if (config.uuid && config.uuid !== uuid) {
      return res.status(400).send(generateErrorPage(
        'Invalid Configuration',
        'The configuration ID does not match. This configuration may belong to a different user.'
      ));
    }
  }
  
  const userId = req.body.userId || req.body.uuid || uuid;
  
  // Handle both array (from checkboxes) and string (comma-separated) formats
  let languages = [];
  if (Array.isArray(req.body.languages)) {
    languages = req.body.languages.map(lang => lang.trim().toLowerCase()).filter(lang => lang.length > 0);
  } else if (typeof req.body.languages === 'string') {
    languages = req.body.languages
      .split(',')
      .map(lang => lang.trim().toLowerCase())
      .filter(lang => lang.length > 0);
  }
  
  // Ensure at least English is selected
  if (languages.length === 0) {
    languages = ['en'];
  }
  
  // Extract OpenRouter credentials from form
  const openrouterApiKey = (req.body.openrouterApiKey || '').trim();
  const openrouterReferer = (req.body.openrouterReferer || process.env.OPENROUTER_REFERER || '').trim();
  
  // Validate API key format if provided
  if (openrouterApiKey && openrouterApiKey.length > 0) {
    if (!openrouterApiKey.startsWith('sk-or-v1-') && !openrouterApiKey.startsWith('sk-')) {
      return res.status(400).send(generateErrorPage(
        'Invalid OpenRouter API Key',
        'OpenRouter API keys should start with "sk-or-v1-" or "sk-". Please check your key and try again.'
      ));
    }
    if (openrouterApiKey.length < 20) {
      return res.status(400).send(generateErrorPage(
        'Invalid OpenRouter API Key',
        'API key appears to be too short. Please check your key and try again.'
      ));
    }
  }
  
  // Store user preferences with UUID
  userPreferences[userId] = {
    languages: languages,
    uuid: userId,
    updatedAt: new Date().toISOString(),
    openrouter: {
      apiKey: openrouterApiKey,
      referer: openrouterReferer
    },
    translation: {
      enabled: openrouterApiKey.length > 0,
      model: req.body.translationModel || 'auto'
    }
  };
  
  // Generate new encrypted config
  const newConfig = encryptConfig({ 
    uuid: userId, 
    languages: languages,
    openrouter: userPreferences[userId].openrouter,
    translation: userPreferences[userId].translation
  });
  
  console.log(`Saved preferences for user ${userId}:`, userPreferences[userId]);
  console.log(`  Languages: ${languages.join(', ')}`);
  console.log(`  OpenRouter API Key: ${openrouterApiKey ? '***' + openrouterApiKey.slice(-4) : 'Not set'}`);
  
  res.redirect(`/stremio/${uuid}/${newConfig}/configure?saved=true`);
});

/**
 * Root configure page - creates new UUID and redirects
 */
app.get('/configure', (req, res) => {
  const newUuid = uuidv4();
  const defaultConfig = {
    uuid: newUuid,
    languages: ['en'],
    openrouter: {
      apiKey: '',  // User will configure
      referer: process.env.OPENROUTER_REFERER || ''
    },
    translation: {
      enabled: false,  // Disabled until user adds API key
      model: 'auto'
    }
  };
  const newConfig = encryptConfig(defaultConfig);
  res.redirect(`/stremio/${newUuid}/${newConfig}/configure`);
});

// ============================================================================
// Stremio Addon Builder
// ============================================================================

const builder = new addonBuilder({
  id: 'com.aistreamio.subtitles',
  version: '1.0.0',
  name: 'AI Subtitle Translator',
  description: 'Translates subtitles using AI (OpenRouter) for Stremio',
  
  catalogs: [],
  resources: ['subtitles'],
  types: ['movie', 'series'],
  idPrefixes: ['tt', 'tmdb'],
  
  behaviorHints: {
    configurable: true
  },
  
  config: [
    {
      key: 'languages',
      type: 'text',
      title: 'Preferred Subtitle Languages',
      description: 'Comma-separated language codes (e.g., es,fr,de,it)',
      default: 'en'
    }
  ]
});

// ============================================================================
// Subtitles Handler
// ============================================================================

// Store the handler function so we can call it directly from the route
let subtitleHandlerFunction = null;

// Define the subtitle handler function
const subtitleHandler = async function(args) {
  const { type, id, extra, userData } = args;
  const season = extra?.season;
  const episode = extra?.episode;
  
  try {
    // Get user's preferred languages from userData (UUID-based)
    const userId = userData?.userId || userData?.uuid || 'default';
    
    // Get user's full configuration
    const userConfig = userPreferences[userId] || { 
      languages: ['en'],
      openrouter: {
        apiKey: '',
        referer: process.env.OPENROUTER_REFERER || ''
      },
      translation: {
        enabled: false,
        model: 'auto'
      }
    };
    
    const preferredLanguages = getUserLanguages({ userData: { userId } });
    
    // Always include English first, then user's preferred languages
    const allLanguages = ['en', ...preferredLanguages.filter(lang => lang !== 'en')];
    const subtitles = [];
    
    console.log(`\n🔍 Processing subtitle request for ${type}/${id} (season: ${season}, episode: ${episode})`);
    console.log(`👤 User ID: ${userId}`);
    console.log(`🌐 User preferred languages: ${preferredLanguages.join(', ')}`);
    console.log(`🔑 OpenRouter API Key: ${userConfig.openrouter?.apiKey ? 'Configured (User)' : process.env.OPENROUTER_API_KEY ? 'Using server key (fallback)' : 'Not configured'}`);
    console.log(`📋 Processing languages: ${allLanguages.join(', ')}`);
    
    for (const lang of allLanguages) {
      try {
        // Step 1: Try to get subtitle from wyzie-lib
        console.log(`Attempting to fetch ${lang} subtitle from wyzie-lib...`);
        const wyzieSubtitle = await getSubtitlesFromWyzie(type, id, season, episode, lang);
        
        if (wyzieSubtitle && wyzieSubtitle.content) {
          // Found in wyzie-lib, use it directly
          console.log(`Found ${lang} subtitle in wyzie-lib`);
          
          // Convert to VTT if needed
          const vttContent = convertToVTT(wyzieSubtitle.content, wyzieSubtitle.format);
          
          if (!vttContent) {
            console.log(`Failed to convert ${lang} subtitle to VTT`);
            continue;
          }
          
          // Serve the subtitle
          const subtitleUrl = await serveSubtitleContent(
            vttContent,
            lang,
            type,
            id,
            season,
            episode
          );
          
          if (subtitleUrl) {
            subtitles.push({
              id: `${lang}_${id}_${Date.now()}`,
              url: subtitleUrl,
              lang: lang,
              name: `${lang.toUpperCase()} Subtitles`
            });
          }
        } else if (lang !== 'en') {
          // Step 2: Not found, try to translate from English
          console.log(`${lang} subtitle not found, attempting AI translation from English...`);
          
          // Get English subtitle first
          const englishSubtitle = await getSubtitlesFromWyzie(type, id, season, episode, 'en');
          
          if (englishSubtitle && englishSubtitle.content) {
            try {
              // Translate using OpenRouter AI
              const translatedContent = await translateSubtitlesWithGemini(
                englishSubtitle.content,
                lang,
                userConfig  // Pass user configuration
              );
              
              if (!translatedContent) {
                console.log(`Translation failed for ${lang}`);
                continue;
              }
              
              // Convert to VTT
              const vttContent = convertToVTT(translatedContent, englishSubtitle.format);
              
              if (!vttContent) {
                console.log(`Failed to convert translated ${lang} subtitle to VTT`);
                continue;
              }
              
              // Serve the translated subtitle
              const subtitleUrl = await serveSubtitleContent(
                vttContent,
                lang,
                type,
                id,
                season,
                episode
              );
              
              if (subtitleUrl) {
                subtitles.push({
                  id: `${lang}_${id}_${Date.now()}`,
                  url: subtitleUrl,
                  lang: lang,
                  name: `${lang.toUpperCase()} Subtitles (AI Translated)`
                });
              }
            } catch (translationError) {
              if (translationError.message.includes('API key not configured')) {
                console.error(`⚠️  Translation failed: User needs to configure OpenRouter API key`);
                const baseUrl = process.env.BASE_URL || `http://${req?.get?.('host') || 'localhost:7001'}`;
                console.error(`   Visit: ${baseUrl}/configure`);
              } else {
                console.error(`Error translating to ${lang}:`, translationError.message);
              }
              // Continue with other languages
            }
          } else {
            console.log(`English subtitle not available for translation to ${lang}`);
          }
        }
      } catch (error) {
        console.error(`Error processing ${lang} subtitle:`, error.message);
        // Continue with other languages
      }
    }
    
    console.log(`✅ Returning ${subtitles.length} subtitle(s) for ${type}/${id}`);
    if (subtitles.length === 0) {
      console.log(`⚠️  No subtitles found/translated. This might be because:`);
      console.log(`   - No English subtitles available for this content`);
      console.log(`   - Translation failed`);
      console.log(`   - Subtitle fetching from wyzie-lib failed`);
    }
    return Promise.resolve({ subtitles });
    
  } catch (error) {
    console.error('❌ Error in subtitles handler:', error);
    console.error('Stack:', error.stack);
    return Promise.resolve({ subtitles: [] });
  }
};

// Store reference for direct calls from route handler
subtitleHandlerFunction = subtitleHandler;

// Register with builder
builder.defineSubtitlesHandler(subtitleHandler);

// ============================================================================
// Server Setup
// ============================================================================

const port = process.env.PORT || 7001;

// Mount Stremio addon routes with UUID support
app.get('/stremio/:uuid/:encryptedConfig/manifest.json', async (req, res) => {
  try {
    const { uuid, encryptedConfig } = req.params;
    
    // Build manifest data with UUID-specific ID
    const baseUrl = process.env.BASE_URL || `http://127.0.0.1:${port}`;
    const configUrl = `${baseUrl}/stremio/${uuid}/${encryptedConfig}/configure`;
    
    const manifestData = {
      id: `com.aistreamio.subtitles.${uuid}`,
      version: '1.0.0',
      name: 'AI Subtitle Translator',
      description: 'Translates subtitles using AI (OpenRouter) for Stremio',
      catalogs: [],
      resources: ['subtitles'],
      types: ['movie', 'series'],
      idPrefixes: ['tt', 'tmdb'],
      behaviorHints: {
        configurable: true,
        configurationRequired: false
      }
    };
    
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    res.json(manifestData);
  } catch (error) {
    console.error('Error serving manifest:', error);
    res.status(500).json({ error: 'Failed to serve manifest' });
  }
});

// Handle Stremio subtitle requests - supports both formats:
// 1. /subtitles/:type/:id.json?query=params (standard)
// 2. /subtitles/:type/:id/filename=...&videoSize=...&videoHash=....json (Stremio format)
app.get('/stremio/:uuid/:encryptedConfig/subtitles/:type/:id*.json', async (req, res) => {
  try {
    let { uuid, encryptedConfig, type, id } = req.params;
    let extra = { ...req.query };
    
    console.log('\n=== SUBTITLE REQUEST ===');
    console.log(`Full path: ${req.path}`);
    console.log(`Full URL: ${req.url}`);
    console.log(`Raw ID param: ${id}`);
    
    // Handle Stremio's format where query params are embedded in the path
    // Path format: tt0903747%3A1%3A1/filename=...&videoSize=...&videoHash=....json
    if (id && (id.includes('filename=') || id.includes('videoSize=') || id.includes('videoHash='))) {
      // Split the ID part from the query-like params
      const parts = id.split('/');
      const actualId = parts[0];
      id = decodeURIComponent(actualId);
      
      // Parse the rest as query parameters
      if (parts.length > 1) {
        const queryString = parts.slice(1).join('/');
        // Remove .json from the end if present
        const cleanQuery = queryString.replace(/\.json$/, '');
        
        // Parse filename=value&videoSize=value&videoHash=value format
        cleanQuery.split('&').forEach(param => {
          const [key, ...valueParts] = param.split('=');
          if (key && valueParts.length > 0) {
            const value = valueParts.join('='); // Handle values that might contain =
            extra[decodeURIComponent(key)] = decodeURIComponent(value);
          }
        });
      }
    } else {
      // Standard format - just decode the ID
      id = decodeURIComponent(id);
    }
    
    console.log(`Type: ${type}, ID: ${id}`);
    console.log(`UUID: ${uuid}`);
    console.log(`Extra params:`, extra);
    
    console.log('\n=== SUBTITLE REQUEST ===');
    console.log(`Type: ${type}, ID: ${id}`);
    console.log(`UUID: ${uuid}`);
    console.log(`Extra params:`, extra);
    console.log(`Full URL: ${req.url}`);
    
    // Decrypt config to get user preferences
    let userId = uuid;
    if (encryptedConfig && encryptedConfig !== 'new') {
      const config = decryptConfig(encryptedConfig);
      if (config) {
        userId = config.uuid || uuid;
        console.log(`Decrypted config - User ID: ${userId}, Languages: ${config.languages?.join(', ')}`);
      } else {
        console.log('⚠️  Could not decrypt config, using UUID');
      }
    }
    
    // Parse season/episode from ID if present (format: tt0903747:1:1)
    let season, episode;
    if (id.includes(':')) {
      const parts = id.split(':');
      id = parts[0]; // Extract base ID (tt0903747)
      if (parts.length >= 2) season = parseInt(parts[1]);
      if (parts.length >= 3) episode = parseInt(parts[2]);
      console.log(`Parsed ID: ${id}, Season: ${season}, Episode: ${episode}`);
    }
    
    // Merge season/episode from ID with query params (query params take precedence)
    const finalExtra = {
      ...extra,
      season: extra.season || season,
      episode: extra.episode || episode
    };
    
    // Create args with userData
    const args = {
      type,
      id,
      extra: finalExtra,
      userData: { userId, uuid }
    };
    
    console.log(`Calling subtitle handler with args:`, JSON.stringify(args, null, 2));
    
    // Call the subtitle handler directly (stored reference)
    if (!subtitleHandlerFunction) {
      throw new Error('Subtitle handler not initialized. Server may need restart.');
    }
    
    const result = await subtitleHandlerFunction(args);
    
    console.log(`Subtitle handler returned ${result.subtitles?.length || 0} subtitle(s)`);
    if (result.subtitles && result.subtitles.length > 0) {
      result.subtitles.forEach((sub, idx) => {
        console.log(`  ${idx + 1}. ${sub.lang} - ${sub.name} - ${sub.url}`);
      });
    }
    console.log('=== END SUBTITLE REQUEST ===\n');
    
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    res.json(result);
  } catch (error) {
    console.error('❌ Error serving subtitles:', error);
    console.error('Stack:', error.stack);
    res.status(500).json({ error: 'Failed to serve subtitles', message: error.message });
  }
});

// Legacy routes for backward compatibility
app.get('/manifest.json', async (req, res) => {
  const newUuid = uuidv4();
  const newConfig = encryptConfig({ uuid: newUuid, languages: ['en'] });
  res.redirect(`/stremio/${newUuid}/${newConfig}/manifest.json`);
});

app.get('/subtitles/:type/:id.json', async (req, res) => {
  const newUuid = uuidv4();
  const newConfig = encryptConfig({ uuid: newUuid, languages: ['en'] });
  res.redirect(`/stremio/${newUuid}/${newConfig}/subtitles/${req.params.type}/${req.params.id}.json`);
});

// Start server
const server = app.listen(port, () => {
  console.log(`\n========================================`);
  console.log(`AI Subtitle Translator Addon`);
  console.log(`========================================`);
  console.log(`Addon running on http://127.0.0.1:${port}/manifest.json`);
  console.log(`Configuration page: http://127.0.0.1:${port}/configure`);
  console.log(`Install addon: http://127.0.0.1:${port}/manifest.json`);
  console.log(`========================================\n`);
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`\n❌ Error: Port ${port} is already in use.`);
    console.error(`Please either:`);
    console.error(`  1. Stop the process using port ${port}: lsof -ti:${port} | xargs kill -9`);
    console.error(`  2. Use a different port by setting PORT in .env file\n`);
    process.exit(1);
  } else {
    console.error('Server error:', error);
    process.exit(1);
  }
});


