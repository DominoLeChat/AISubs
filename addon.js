const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const { searchSubtitles } = require('wyzie-lib');
const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
require('dotenv').config();

const app = express();

app.use((req, res, next) => {
  if (req.path.includes('subtitles') || req.path.includes('manifest') || req.path.includes('configure')) {
    console.log(`\n${req.method} ${req.path}`);
    if (Object.keys(req.query).length > 0) {
      console.log(`   Query:`, req.query);
    }
  }
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static assets (logo, favicon, icons) with proper headers
app.use('/assets', (req, res, next) => {
  // Set CORS headers for assets
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  // Set cache control
  res.setHeader('Cache-Control', 'public, max-age=86400');
  next();
}, express.static(path.join(__dirname, 'assets'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.png')) {
      res.setHeader('Content-Type', 'image/png');
    } else if (filePath.endsWith('.svg')) {
      res.setHeader('Content-Type', 'image/svg+xml');
    }
  }
}));

app.use((req, res, next) => {
  req.cookies = {};
  if (req.headers.cookie) {
    req.headers.cookie.split(';').forEach(cookie => {
      const parts = cookie.trim().split('=');
      if (parts.length === 2) {
        req.cookies[parts[0]] = decodeURIComponent(parts[1]);
      }
    });
  }
  
  res.cookie = function(name, value, options = {}) {
    let cookieString = `${name}=${encodeURIComponent(value)}`;
    
    if (options.maxAge) {
      cookieString += `; Max-Age=${Math.floor(options.maxAge / 1000)}`;
    }
    
    if (options.httpOnly) {
      cookieString += '; HttpOnly';
    }
    
    if (options.secure) {
      cookieString += '; Secure';
    }
    
    if (options.sameSite) {
      cookieString += `; SameSite=${options.sameSite}`;
    }
    
    if (options.path) {
      cookieString += `; Path=${options.path}`;
} else {
      cookieString += '; Path=/';
    }
    
    const existingCookies = res.getHeader('Set-Cookie') || [];
    const cookieArray = Array.isArray(existingCookies) ? existingCookies : [existingCookies];
    cookieArray.push(cookieString);
    res.setHeader('Set-Cookie', cookieArray);
  };
  
  next();
});

// --- OpenRouter dynamic FREE model selection (Top 10) ---
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const FREE_MODELS_LIMIT = 10;

// Refresh periodically (models / free capacity can change)
const FREE_MODELS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

let MODEL_CONFIGS = {}; // modelId -> config used by the translator
let MODEL_META = {};    // modelId -> { name, latencyP50Ms, qualityScore }
let currentModelName = null;
let currentModelConfig = null;

let freeModelsCache = { models: [], fetchedAt: 0 };

function toNum(v, fallback = NaN) {
  if (v === null || v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function isFreeModel(m) {
  const p = m?.pricing || {};
  const prompt = toNum(p.prompt ?? p.input ?? p.prompt_tokens, NaN);
  const completion = toNum(p.completion ?? p.output ?? p.completion_tokens, NaN);

  // Prefer strong signal: explicit 0 pricing
  if (prompt === 0 && completion === 0) return true;

  // Fallback signals (best-effort)
  if (m?.free === true) return true;
  if (typeof m?.name === 'string' && /\(free\)/i.test(m.name)) return true;

  return false;
}

function computeLatencyP50Ms(m) {
  const s = m?.stats || m?.statistics || {};
  return toNum(
    s.p50_latency ?? s.latency_p50 ?? s.p50 ?? m?.latency_p50,
    Infinity
  );
}

function computeQualityScore(m) {
  // If OpenRouter provides rank: smaller is better => invert into higher-is-better score
  const rank = toNum(m?.rank, NaN);
  const params = toNum(m?.architecture?.parameters ?? m?.parameters, NaN);
  const ctx = toNum(m?.context_length ?? m?.context, 0);

  let score = 0;

  if (Number.isFinite(rank)) score += (10000 - rank); // crude inversion
  if (Number.isFinite(params)) score += Math.log10(params + 1) * 100;
  if (Number.isFinite(ctx) && ctx > 0) score += Math.log10(ctx + 1) * 50;

  return score;
}

async function fetchTopFreeModels(refererForHeaders) {
  const now = Date.now();
  if (freeModelsCache.models.length && (now - freeModelsCache.fetchedAt) < FREE_MODELS_CACHE_TTL_MS) {
    return freeModelsCache.models;
  }

  const res = await axios.get(OPENROUTER_MODELS_URL, {
    timeout: 15000,
    headers: {
      'HTTP-Referer': refererForHeaders || 'https://stremio-ai-subs.local',
      'X-Title': 'Stremio AI Subtitles'
    }
  });

  const list = res.data?.data || res.data?.models || [];
  const free = list.filter(isFreeModel);

  for (const m of free) {
    m._latency = computeLatencyP50Ms(m);
    m._quality = computeQualityScore(m);
  }

  // Prefer models with explicit latency metrics
  const withLatency = free.filter(m => Number.isFinite(m._latency));
  const withoutLatency = free.filter(m => !Number.isFinite(m._latency));

  // Sort by speed first, then quality (good for fast subtitle translation)
  const sorted =
    withLatency.sort((a, b) => (a._latency - b._latency) || (b._quality - a._quality))
    .concat(withoutLatency.sort((a, b) => b._quality - a._quality));

  const top = sorted.slice(0, FREE_MODELS_LIMIT);

  freeModelsCache = { models: top, fetchedAt: now };
  return top;
}

async function refreshFreeModelConfigs() {
  const models = await fetchTopFreeModels(process.env.OPENROUTER_REFERER);

  MODEL_CONFIGS = {};
  MODEL_META = {};

  for (let i = 0; i < models.length; i++) {
    const m = models[i];
    const id = m?.id || m?.slug || m?.model || m?.name;
    if (!id) continue;

    MODEL_META[id] = {
      name: m?.name || id,
      latencyP50Ms: Number.isFinite(m._latency) ? m._latency : null,
      qualityScore: m._quality
    };

    // Conservative generic limits; real limits depend on the provider + the user's OpenRouter account.
    MODEL_CONFIGS[id] = {
      rpm: 60,
      tpm: 1000000,
      rpd: 10000,
      maxTokens: 8192,
      priority: i
    };
  }

  const ids = Object.keys(MODEL_CONFIGS);
  currentModelName = ids[0] || null;
  currentModelConfig = currentModelName ? MODEL_CONFIGS[currentModelName] : null;

  console.log(`OpenRouter FREE model selection loaded: ${ids.length} model(s)`);
  if (currentModelName) {
    console.log(` Default model: ${currentModelName}`);
    console.log(` Note: Users must configure their own OpenRouter API key in the configuration page`);
  }
}

// Bootstrap refresh (non-blocking)
refreshFreeModelConfigs().catch(err => {
  console.error('Failed to load FREE models from OpenRouter:', err.message);
});
setInterval(() => {
  refreshFreeModelConfigs().catch(err => {
    console.error('Failed to refresh FREE models from OpenRouter:', err.message);
  });
}, FREE_MODELS_CACHE_TTL_MS);
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

function getLanguageName(languageCode) {
  return LANGUAGE_NAMES[languageCode.toLowerCase()] || languageCode.toUpperCase();
}

let rateLimiter = {
  requestsThisMinute: 0,
  tokensThisMinute: 0,
  requestsToday: 0,
  lastRequestTime: 0,
  lastMinuteReset: Date.now()
};

const userPreferences = {};
const configUuids = {};

let ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
if (!ENCRYPTION_KEY) {
  ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
  console.log('Generated encryption key. Set ENCRYPTION_KEY in .env for production.');
}

const getKey = () => {
  if (ENCRYPTION_KEY.length === 64) {
    return Buffer.from(ENCRYPTION_KEY, 'hex');
  } else if (ENCRYPTION_KEY.length === 32) {
    return Buffer.from(ENCRYPTION_KEY, 'utf8');
  } else {
    return crypto.createHash('sha256').update(ENCRYPTION_KEY).digest();
  }
};

const IV_LENGTH = 16;

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

if (!global.subtitleCache) {
  global.subtitleCache = {};
}

// Configuration Storage

const CONFIG_DIR = path.join(process.cwd(), 'configs');

const unlockedConfigs = {};
const SESSION_TIMEOUT = 30 * 60 * 1000;
const SESSION_COOKIE_NAME = 'aisubs_session';

let MASTER_KEY = process.env.MASTER_KEY;
if (!MASTER_KEY) {
  MASTER_KEY = crypto.randomBytes(32).toString('hex');
  console.warn('MASTER_KEY not set in .env - using random key. Public configs will not persist across restarts.');
  console.warn('Set MASTER_KEY in .env for production use.');
}

function hashPassword(password, salt = null) {
  if (!salt) {
    salt = crypto.randomBytes(32).toString('hex');
  }
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return { hash, salt };
}

function verifyPassword(password, hash, salt) {
  const hashToVerify = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return hashToVerify === hash;
}

function deriveKeyFromPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha512');
}

function encryptConfigWithPassword(data, password, salt) {
  const key = deriveKeyFromPassword(password, salt);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(JSON.stringify(data), 'utf8', 'base64');
  encrypted += cipher.final('base64');
  return {
    iv: iv.toString('base64'),
    encrypted: encrypted
  };
}

function decryptConfigWithPassword(encryptedData, password, salt) {
  try {
    const key = deriveKeyFromPassword(password, salt);
    const iv = Buffer.from(encryptedData.iv, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encryptedData.encrypted, 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    return JSON.parse(decrypted);
  } catch (error) {
    throw new Error('Decryption failed. Incorrect password or corrupted data.');
  }
}

async function ensureConfigDir() {
  try {
    await fs.mkdir(CONFIG_DIR, { recursive: true });
  } catch (error) {
    console.error('Error creating configs directory:', error);
    throw error;
  }
}

function encryptWithMasterKey(data) {
  const key = crypto.createHash('sha256').update(MASTER_KEY).digest();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(JSON.stringify(data), 'utf8', 'base64');
  encrypted += cipher.final('base64');
  return {
    iv: iv.toString('base64'),
    encrypted: encrypted
  };
}

function decryptWithMasterKey(encryptedData) {
  try {
    const key = crypto.createHash('sha256').update(MASTER_KEY).digest();
    const iv = Buffer.from(encryptedData.iv, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encryptedData.encrypted, 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    return JSON.parse(decrypted);
  } catch (error) {
    throw new Error('Failed to decrypt public config');
  }
}

/**
 * Save user configuration to JSON file (password-protected)
 */
async function saveUserConfig(userId, config, password) {
  await ensureConfigDir();
  const configPath = path.join(CONFIG_DIR, `${userId}.json`);
  
  // Hash password for storage
  const passwordHash = hashPassword(password);
  
  // Encrypt full config with password
  const encryptedConfig = encryptConfigWithPassword(config, password, passwordHash.salt);
  
  // Create public config (languages and API key only) encrypted with server master key
  // This allows loading on startup without user passwords for read-only subtitle requests
  const publicConfig = {
    languages: config.languages || ['en'],
    openrouter: {
      apiKey: config.openrouter?.apiKey || '',
      referer: config.openrouter?.referer || ''
    },
    translation: {
      enabled: config.translation?.enabled || false,
      model: config.translation?.model || 'auto'
    }
  };
  const encryptedPublicConfig = encryptWithMasterKey(publicConfig);
  
  const configData = {
    userId,
    passwordHash: passwordHash.hash,
    passwordSalt: passwordHash.salt,
    encryptedConfig: encryptedConfig,
    encryptedPublicConfig: encryptedPublicConfig, // For read-only access without password
    updatedAt: new Date().toISOString(),
    version: '1.0.0'
  };
  
  try {
    await fs.writeFile(configPath, JSON.stringify(configData, null, 2), 'utf8');
    await fs.chmod(configPath, 0o600);
    userPreferences[userId] = publicConfig;
    
    return configData;
  } catch (error) {
    console.error(`Error saving config for user ${userId}:`, error);
    throw error;
  }
}

async function loadUserConfig(userId, password) {
  try {
    const configPath = path.join(CONFIG_DIR, `${userId}.json`);
    const data = await fs.readFile(configPath, 'utf8');
    const fileData = JSON.parse(data);
    
    if (!verifyPassword(password, fileData.passwordHash, fileData.passwordSalt)) {
      throw new Error('Incorrect password');
    }
    
    // Decrypt config
    const decryptedConfig = decryptConfigWithPassword(
      fileData.encryptedConfig,
      password,
      fileData.passwordSalt
    );
    
    return decryptedConfig;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null; // Config doesn't exist
    }
    if (error.message === 'Incorrect password' || error.message.includes('Decryption failed')) {
      throw error; // Re-throw password errors
    }
    console.error(`Error loading config for user ${userId}:`, error);
    throw error;
  }
}

async function configFileExists(userId) {
  try {
    const configPath = path.join(CONFIG_DIR, `${userId}.json`);
    await fs.access(configPath);
    return true;
  } catch (error) {
    return false;
  }
}

async function loadPublicConfig(userId) {
  try {
    const configPath = path.join(CONFIG_DIR, `${userId}.json`);
    const data = await fs.readFile(configPath, 'utf8');
    const fileData = JSON.parse(data);
    
    if (fileData.encryptedPublicConfig) {
      const publicConfig = decryptWithMasterKey(fileData.encryptedPublicConfig);
      return publicConfig;
    }
    
    return null;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    console.error(`Error loading public config for user ${userId}:`, error);
    return null;
  }
}

async function loadAllConfigs() {
  await ensureConfigDir();
  try {
    const files = await fs.readdir(CONFIG_DIR);
    const configFiles = files.filter(file => file.endsWith('.json'));
    console.log(`Found ${configFiles.length} configuration file(s) in ${CONFIG_DIR}`);
    
    let loadedCount = 0;
    for (const file of configFiles) {
      const userId = file.replace('.json', '');
      try {
        const publicConfig = await loadPublicConfig(userId);
        if (publicConfig) {
          userPreferences[userId] = publicConfig;
          loadedCount++;
          console.log(`  Loaded config for ${userId} - Languages: ${publicConfig.languages?.join(', ') || 'en'}, API Key: ${publicConfig.openrouter?.apiKey ? 'Configured' : 'Not set'}`);
        }
      } catch (error) {
        console.error(`  Failed to load config for ${userId}:`, error.message);
      }
    }
    
    console.log(`Loaded ${loadedCount} public configuration(s) into memory cache`);
    return loadedCount;
  } catch (error) {
    console.error('Error loading configs:', error);
    return 0;
  }
}

function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

function unlockConfig(userId, config, password = null) {
  const sessionToken = generateSessionToken();
  unlockedConfigs[sessionToken] = {
    userId: userId,
    config: config,
    // Password stored temporarily in memory for session duration (30 min max) to allow saving without re-entry
    // This is a security trade-off for UX - password is never logged or exposed in URLs
    password: password,
    unlockedAt: Date.now(),
    expiresAt: Date.now() + SESSION_TIMEOUT
  };
  return sessionToken;
}

/**
 * Get unlocked config from session using session token
 */
function getUnlockedConfig(sessionToken) {
  if (!sessionToken) {
    return null;
  }
  
  const session = unlockedConfigs[sessionToken];
  if (!session) {
    return null;
  }
  
  if (Date.now() > session.expiresAt) {
    delete unlockedConfigs[sessionToken];
    return null;
  }
  
  return session.config;
}

function getSessionToken(req) {
  return req.cookies?.[SESSION_COOKIE_NAME] || null;
}

function isConfigUnlocked(req, userId) {
  const sessionToken = getSessionToken(req);
  if (!sessionToken) {
    return false;
  }
  
  const session = unlockedConfigs[sessionToken];
  if (!session) {
    return false;
  }
  
  if (session.userId !== userId) {
    return false;
  }
  
  if (Date.now() > session.expiresAt) {
    delete unlockedConfigs[sessionToken];
    return false;
  }
  
  return true;
}

function lockConfig(sessionToken) {
  if (sessionToken) {
    delete unlockedConfigs[sessionToken];
  }
}

// Helper Functions

function getUserId(args) {
  return args.userData?.userId || args.userData?.user || 'default';
}

function getUserLanguages(args) {
  const userId = getUserId(args);
  const preferences = userPreferences[userId];
  return preferences?.languages || ['en'];
}

function parseStremioId(id) {
  if (id.startsWith('tt')) {
    return { imdb_id: id };
  }
  
  if (id.startsWith('tmdb:')) {
    return { tmdb_id: parseInt(id.replace('tmdb:', '')) };
  }
  
  const tmdbId = parseInt(id);
  if (!isNaN(tmdbId)) {
    return { tmdb_id: tmdbId };
  }
  
  return { imdb_id: `tt${id}` };
}

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

async function getSubtitlesFromWyzie(type, id, season, episode, language) {
  try {
    const idParams = parseStremioId(id);
    
    const searchParams = {
      ...idParams,
      language: language,
      type: 'srt'
    };
    
    if (type === 'series' && season && episode) {
      searchParams.season = parseInt(season);
      searchParams.episode = parseInt(episode);
    }
    
    console.log(`Searching wyzie-lib for ${language} subtitles:`, searchParams);
    
    const subtitleResults = await searchSubtitles(searchParams);
    
    if (!subtitleResults || subtitleResults.length === 0) {
      console.log(`No ${language} subtitles found in wyzie-lib`);
      return null;
    }
    
    console.log(`Found ${subtitleResults.length} ${language} subtitle(s) in wyzie-lib`);
    
    // Fetch all subtitles
    const allSubtitles = [];
    for (const subtitleData of subtitleResults) {
      if (!subtitleData.url) {
        console.log(`Subtitle data found but no URL available, skipping`);
        continue;
      }
      
      // Fetch the actual subtitle content from the URL
      console.log(`Fetching subtitle content from: ${subtitleData.url}`);
      const subtitleContent = await fetchSubtitleContent(subtitleData.url);
      
      if (subtitleContent) {
        allSubtitles.push({
          content: subtitleContent,
          language: subtitleData.language || language,
          format: subtitleData.type || 'srt',
          url: subtitleData.url
        });
      }
    }
    
    if (allSubtitles.length === 0) {
      console.log(`No valid ${language} subtitles could be fetched`);
      return null;
    }
    
    // Return array if multiple subtitles, or single object for backward compatibility
    return allSubtitles.length === 1 ? allSubtitles[0] : allSubtitles;
    
  } catch (error) {
    console.error(`Error getting subtitles from wyzie-lib for ${language}:`, error.message);
    return null;
  }
}

function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

function splitSubtitlesOptimized(srtContent, modelConfig) {
  const totalChars = srtContent.length;

  // Fewer chunks = fewer API calls = faster (and fewer 429s) for subtitle translation
  const targetChunks = parseInt(process.env.TARGET_SUBTITLE_CHUNKS || '30', 10);

  // Rough token->char heuristic: 1 token ~ 4 chars. Keep a safety margin for prompt overhead.
  const approxMaxCharsByTokens = Math.max(1200, Math.floor(((modelConfig?.maxTokens || 8192) * 3)));

  const idealCharsPerChunk = Math.ceil(totalChars / Math.max(1, targetChunks));
  const charsPerChunk = Math.max(1200, Math.min(approxMaxCharsByTokens, idealCharsPerChunk));
  
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
        
        if (currentChars + blockChars > charsPerChunk && currentChunk.length > 0) {
          chunks.push(currentChunk.join('\n\n') + '\n');
          currentChunk = [blockText];
          currentChars = blockChars;
        } else {
          currentChunk.push(blockText);
          currentChars += blockChars + 2;
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
  
  if (currentChunk.length > 0) {
    chunks.push(currentChunk.join('\n\n') + '\n');
  }
  
  return chunks;
}

function splitChunkFurther(chunkContent, maxSplits = 2) {
  const lines = chunkContent.split('\n');
  const chunks = [];
  let currentChunk = [];
  let currentBlock = [];
  
  const targetCharsPerChunk = Math.max(200, Math.ceil(chunkContent.length / maxSplits));
  let currentChars = 0;
  
  for (const line of lines) {
    currentBlock.push(line);
    
    if (line.trim() === '') {
      if (currentBlock.length > 1) {
        const blockText = currentBlock.join('\n');
        const blockChars = blockText.length;
        
        if (currentChars + blockChars > targetCharsPerChunk && currentChunk.length > 0) {
          chunks.push(currentChunk.join('\n\n') + '\n');
          currentChunk = [blockText];
          currentChars = blockChars;
        } else {
          currentChunk.push(blockText);
          currentChars += blockChars + 2;
        }
      }
      currentBlock = [];
    }
  }
  
  if (currentChunk.length > 0) {
    chunks.push(currentChunk.join('\n\n') + '\n');
  }
  
  return chunks.length > 1 ? chunks : [chunkContent];
}

let rateLimitLock = Promise.resolve();

async function enforceRateLimits(modelConfig) {
  const now = Date.now();
  
  if (now - rateLimiter.lastMinuteReset > 60000) {
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
  
  if (rateLimiter.requestsThisMinute >= modelConfig.rpm) {
    const waitTime = 60000 - (now - rateLimiter.lastMinuteReset);
    if (waitTime > 0) {
      console.log(`RPM limit reached (${rateLimiter.requestsThisMinute}/${modelConfig.rpm}), waiting ${Math.ceil(waitTime/1000)}s...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      rateLimiter.requestsThisMinute = 0;
      rateLimiter.tokensThisMinute = 0;
      rateLimiter.lastMinuteReset = Date.now();
    }
  }
  
  if (rateLimiter.requestsToday >= modelConfig.rpd) {
    throw new Error(`Daily request limit reached (${rateLimiter.requestsToday}/${modelConfig.rpd} RPD). Please try again tomorrow.`);
  }
}

function updateRateLimiter(estimatedTokens) {
  rateLimiter.requestsThisMinute++;
  rateLimiter.tokensThisMinute += estimatedTokens;
  rateLimiter.requestsToday++;
  rateLimiter.lastRequestTime = Date.now();
}

function calculateRequestDelay(modelConfig) {
  const minDelay = Math.ceil(60000 / modelConfig.rpm);
  return Math.max(minDelay, 1000);
}



async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) break;
      results[i] = await worker(items[i], i);
    }
  });

  await Promise.all(runners);
  return results;
}
async function translateSubtitlesWithGeminiChunked(subtitleContent, targetLanguage, userConfig) {
  const apiKey = userConfig?.openrouter?.apiKey;
  const referer = userConfig?.openrouter?.referer || 'https://stremio-ai-subs.local';
  
  if (!apiKey || apiKey.trim() === '') {
    throw new Error(
      'OpenRouter API key not configured. ' +
      'Please visit the configuration page and add your OpenRouter API key. ' +
      'Get your key at https://openrouter.ai/keys'
    );
  }
  
  const preferredModel = userConfig?.translation?.model;

  let selectedModelName =
    (preferredModel && preferredModel !== 'auto' && MODEL_CONFIGS[preferredModel])
      ? preferredModel
      : currentModelName;

  if (!selectedModelName) {
    throw new Error(
      'No FREE OpenRouter models available right now. ' +
      'Please retry later or check OpenRouter model availability.'
    );
  }

  const selectedModelConfig = MODEL_CONFIGS[selectedModelName];
  
  // Use optimized chunking based on model's token limits
  const chunks = splitSubtitlesOptimized(subtitleContent, selectedModelConfig);
  
  if (chunks.length === 0) {
    throw new Error('No subtitle chunks created');
  }
  
  console.log(`Translating ${chunks.length} chunk(s) with ${selectedModelName}`);
  console.log(`  Using user's OpenRouter API key`);
  console.log(`  Model limits: ${selectedModelConfig.rpm} RPM, ${(selectedModelConfig.tpm/1000).toFixed(0)}K TPM, ${selectedModelConfig.rpd} RPD`);
  
  // Calculate optimal delay between requests
  const requestDelay = calculateRequestDelay(selectedModelConfig);
  console.log(`  Request delay: ${requestDelay}ms between chunks`);
  
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

        if (attempt > 0) {
          console.log(`  Chunk ${chunkIndex + 1}: Retrying API request (attempt ${attempt + 1}/${retries})...`);
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

        const finishReason = response.data.choices[0]?.finish_reason;
        if (finishReason === 'length') {
          console.log(`  Chunk ${chunkIndex + 1}: Response was truncated (hit max_tokens limit). Consider using smaller chunks.`);
        }

        let translatedContent = response.data.choices[0].message.content;
        
        if (!translatedContent || !translatedContent.trim()) {
          throw new Error('API returned empty or whitespace-only response');
        }
        
        translatedContent = translatedContent.trim();
        
        if (translatedContent.startsWith('```')) {
          translatedContent = translatedContent.replace(/```[\w]*\n?/g, '').replace(/```$/g, '').trim();
        }
        
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
          
          if (!foundFirstSubtitle && !trimmedLine) {
            continue;
          }
          
          if (!foundFirstSubtitle) {
            if (trimmedLine.match(/^\d+$/) || trimmedLine.match(/^\d{2}:\d{2}:\d{2}/)) {
              foundFirstSubtitle = true;
              cleanedLines.push(line);
            } else if (skipPatterns.some(pattern => pattern.test(trimmedLine))) {
              continue;
            } else if (trimmedLine && trimmedLine.length > 0) {
              cleanedLines.push(line);
            }
          } else {
            cleanedLines.push(line);
          }
        }
        
        translatedContent = cleanedLines.join('\n');
        translatedContent = translatedContent.replace(/\n\s*(Note:|Here is|Translation|மொழி பெயர்ப்பு|கட்டுப்பாடுகள்|Format|Keep|Translate|Start).*$/gim, '');
        translatedContent = translatedContent.replace(/\n\s*\d+\.\s*(Return|Preserve|Keep|Translate|Do NOT|Start).*$/gim, '');
        translatedContent = translatedContent.replace(/\n\s*கட்டுப்பாடுகள்:.*$/gim, '');
        translatedContent = translatedContent.replace(/\n\s*மொழி பெயர்ப்பு:.*$/gim, '');
        translatedContent = translatedContent.trim();
        
        if (finishReason === 'length') {
          const lines = translatedContent.split('\n');
          const lastLine = lines[lines.length - 1];
          
          if (lastLine && lastLine.trim() && !lastLine.match(/^\s*$/)) {
            const isTimingLine = lastLine.match(/^\d{2}:\d{2}:\d{2}/);
            const isNumberLine = lastLine.match(/^\d+$/);
            const isTextLine = !isTimingLine && !isNumberLine;
            
            if (isTextLine && !translatedContent.match(/\n\s*$/)) {
              console.log(`  Chunk ${chunkIndex + 1}: Translation appears incomplete (ends mid-subtitle). Last line: "${lastLine.substring(0, 50)}..."`);
              const lastEmptyLineIndex = translatedContent.lastIndexOf('\n\n');
              if (lastEmptyLineIndex > 0) {
                const beforeLastEntry = translatedContent.substring(0, lastEmptyLineIndex + 2);
                const incompleteEntry = translatedContent.substring(lastEmptyLineIndex + 2);
                if (incompleteEntry.length < 100) {
                  console.log(`  Chunk ${chunkIndex + 1}: Removing incomplete last subtitle entry`);
                  translatedContent = beforeLastEntry.trim();
                }
              }
            }
          }
        }
        
        const responseTokens = estimateTokens(translatedContent);
        updateRateLimiter(estimatedTokens + responseTokens);
        
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`  Chunk ${chunkIndex + 1}/${chunks.length} translated (~${estimatedTokens + responseTokens} tokens) in ${elapsed}s`);
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
  

  
  // Process chunks with bounded concurrency to avoid OpenRouter 429 storms
  const MAX_PARALLEL = parseInt(process.env.MAX_PARALLEL_TRANSLATIONS || '4', 10);
  const maxParallelRequests = Math.max(1, Math.min(MAX_PARALLEL, chunks.length));

  console.log(`  Processing ${chunks.length} chunk(s) with concurrency=${maxParallelRequests}`);

  const translatedChunks = new Array(chunks.length);

  console.log(` ⏳ Processing all ${chunks.length} chunk(s)...`);
  const batchResults = await mapWithConcurrency(chunks, maxParallelRequests, async (chunk, i) => {
    // Small stagger helps reduce burstiness across workers
    const STAGGER_MS = parseInt(process.env.CHUNK_STAGGER_MS || '150', 10);
    if (i > 0 && STAGGER_MS > 0) {
      await new Promise(resolve => setTimeout(resolve, Math.min(STAGGER_MS * (i % maxParallelRequests), 1500)));
    }

    const chunkPromise = translateChunk(chunk, i);
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Chunk ${i + 1} timed out after 2 minutes`)), 120000);
    });

    try {
      const result = await Promise.race([chunkPromise, timeoutPromise]);
      return { index: i, result };
    } catch (error) {
      console.log(` ❌ Chunk ${i + 1} error: ${error.message}`);
      return { index: i, error, result: null };
    }
  });
  console.log(` 📦 All ${batchResults.length} chunk(s) completed`);

  const errors = [];
  const failedChunks = [];
  
  for (const { index, result, error } of batchResults) {
    if (error) {
      errors.push(`Chunk ${index + 1}: ${error.message}`);
      failedChunks.push({ index, chunk: chunks[index], error: error.message });
      translatedChunks[index] = null;
    } else {
      translatedChunks[index] = result;
    }
  }
  
  if (failedChunks.length > 0) {
    console.log(`  Retrying ${failedChunks.length} failed chunk(s)...`);
    
    for (const { index, chunk, error: originalError } of failedChunks) {
      const retryAttempts = 3;
      let retrySuccess = false;
      
      for (let retry = 0; retry < retryAttempts && !retrySuccess; retry++) {
        try {
          const waitTime = 2000 * Math.pow(2, retry);
          if (retry > 0) {
            console.log(`  Retrying chunk ${index + 1} (attempt ${retry + 1}/${retryAttempts}) after ${waitTime/1000}s...`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
          } else {
            console.log(`  Retrying chunk ${index + 1} immediately...`);
          }
          
          const retryResult = await translateChunk(chunk, index);
          translatedChunks[index] = retryResult;
          retrySuccess = true;
          console.log(`  Chunk ${index + 1} succeeded on retry`);
          
          const errorIndex = errors.findIndex(e => e.startsWith(`Chunk ${index + 1}:`));
          if (errorIndex >= 0) {
            errors.splice(errorIndex, 1);
          }
        } catch (retryError) {
          console.log(`  Chunk ${index + 1} retry ${retry + 1} failed: ${retryError.message}`);
          
          if (retry === retryAttempts - 1) {
            console.log(`  Splitting chunk ${index + 1} into smaller pieces...`);
            
            try {
              const splitChunks = splitChunkFurther(chunk);
              
              if (splitChunks.length > 1) {
                console.log(`  Split chunk ${index + 1} into ${splitChunks.length} smaller chunk(s)`);
                
                const splitResults = [];
                for (let splitIdx = 0; splitIdx < splitChunks.length; splitIdx++) {
                  try {
                    const splitResult = await translateChunk(splitChunks[splitIdx], `${index}.${splitIdx}`);
                    splitResults.push(splitResult);
                    console.log(`  Split chunk ${index + 1}.${splitIdx + 1} translated successfully`);
                  } catch (splitError) {
                    console.log(`  Split chunk ${index + 1}.${splitIdx + 1} failed: ${splitError.message}`);
                    splitResults.push(null);
                  }
                }
                
                const validSplitResults = splitResults.filter(r => r !== null);
                if (validSplitResults.length > 0) {
                  translatedChunks[index] = validSplitResults.join('\n\n');
                  retrySuccess = true;
                  console.log(`  Chunk ${index + 1} succeeded after splitting (${validSplitResults.length}/${splitChunks.length} parts)`);
                  
                  const errorIndex = errors.findIndex(e => e.startsWith(`Chunk ${index + 1}:`));
                  if (errorIndex >= 0) {
                    errors.splice(errorIndex, 1);
                  }
                } else {
                  console.log(`  ❌ All split chunks for ${index + 1} failed`);
                }
              } else {
                console.log(`  ⚠️  Chunk ${index + 1} cannot be split further (too small or single subtitle entry)`);
              }
            } catch (splitError) {
              console.log(`  ❌ Failed to split chunk ${index + 1}: ${splitError.message}`);
            }
          }
        }
      }
    }
  }
  
  // Final check - update errors list with remaining failures
  const finalErrors = [];
  for (let i = 0; i < translatedChunks.length; i++) {
    if (translatedChunks[i] === null) {
      const originalError = errors.find(e => e.startsWith(`Chunk ${i + 1}:`));
      if (originalError) {
        finalErrors.push(originalError);
      }
    }
  }
  
  // If we have errors, log them but don't fail completely if we have some results
  if (finalErrors.length > 0) {
    console.log(`  ⚠️  ${finalErrors.length} chunk(s) failed after retries and splitting:`, finalErrors.join(', '));
    if (finalErrors.length === chunks.length) {
      throw new Error(`All chunks failed: ${finalErrors.join('; ')}`);
    }
    // Filter out null results (failed chunks)
    const validChunks = translatedChunks.filter(chunk => chunk !== null);
    if (validChunks.length === 0) {
      throw new Error(`All chunks failed: ${finalErrors.join('; ')}`);
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
  
  // Extract user's credentials (required - no fallback)
  const apiKey = userConfig?.openrouter?.apiKey;
  const referer = userConfig?.openrouter?.referer || 'https://stremio-ai-subs.local';
  
  if (!apiKey || apiKey.trim() === '') {
    throw new Error(
      'OpenRouter API key not configured. ' +
      'Please visit the configuration page and add your OpenRouter API key. ' +
      'Get your key at https://openrouter.ai/keys'
    );
  }
  
  // Use user's preferred model or currentModelName
  const preferredModel = userConfig?.translation?.model;

  const modelName =
    (preferredModel && preferredModel !== 'auto' && MODEL_CONFIGS[preferredModel])
      ? preferredModel
      : currentModelName;

  if (!modelName) {
    throw new Error(
      'No FREE OpenRouter models available right now. ' +
      'Please retry later or check OpenRouter model availability.'
    );
  }

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
6. Use modern way of talking and slang while translating

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
      let vttContent = content
        .replace(/^\d+\s*$/gm, '')
        .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
        .replace(/(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/g, '$1 --> $2')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      
      if (!vttContent.startsWith('WEBVTT')) {
        vttContent = 'WEBVTT\n\n' + vttContent;
      }
      
      return vttContent;
    } catch (error) {
      console.error('Error converting to VTT:', error.message);
      return null;
    }
  }
  
  if (!content.trim().startsWith('WEBVTT')) {
    return 'WEBVTT\n\n' + content;
  }
  return content;
}

async function serveSubtitleContent(content, language, type, id, season, episode) {
  if (!content) {
    return null;
  }
  
  const subtitleId = `${type}_${id}_${season || ''}_${episode || ''}_${language}_${Date.now()}`;
  
  global.subtitleCache[subtitleId] = content;
  
  const baseUrl = process.env.BASE_URL || `http://127.0.0.1:${process.env.PORT || 7000}`;
  return `${baseUrl}/subtitle/${subtitleId}.vtt`;
}

// Express Routes

app.get('/subtitle/:id.vtt', (req, res) => {
  const subtitleId = req.params.id;
  
  console.log(`Subtitle request for ID: ${subtitleId}`);
  console.log(`Cache has ${Object.keys(global.subtitleCache || {}).length} entries`);
  
  if (global.subtitleCache && global.subtitleCache[subtitleId]) {
    const content = global.subtitleCache[subtitleId];
    console.log(`Serving subtitle ${subtitleId}, length: ${content.length} chars`);
    
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

app.options('/subtitle/:id.vtt', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(200);
});

function getOrCreateUuid(userId) {
  if (!configUuids[userId]) {
    configUuids[userId] = uuidv4();
  }
  return configUuids[userId];
}

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

function isValidUUID(uuid) {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

/**
 * Escape HTML to prevent XSS attacks
 */
function escapeHtml(text) {
  if (typeof text !== 'string') {
    return '';
  }
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text.replace(/[&<>"']/g, m => map[m]);
}

function generateErrorPage(title, message) {
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${safeTitle} - AI Subtitle Translator</title>
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
              <h1 class="text-2xl sm:text-3xl font-semibold text-[hsl(var(--foreground))] mb-2">${safeTitle}</h1>
              <p class="text-[hsl(var(--muted-foreground))] text-sm sm:text-base mb-6">${safeMessage}</p>
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
 * Generate password setup page for new users
 */
function generateSetupPage(uuid, encryptedConfig, errorMessage = null) {
  const baseUrl = process.env.BASE_URL || 'http://localhost:7001';
  
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Setup Configuration - AI Subtitle Translator</title>
  <link rel="icon" type="image/png" href="/assets/logo.png">
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    :root {
      --background: 0 0% 3.9%;
      --foreground: 0 0% 98%;
      --card: 0 0% 7%;
      --border: 0 0% 14.9%;
      --primary: 221.2 83.2% 53.3%;
      --muted-foreground: 0 0% 63.9%;
    }
    body {
      background-color: hsl(var(--background));
      color: hsl(var(--foreground));
      font-family: ui-sans-serif, system-ui, sans-serif;
    }
  </style>
</head>
<body class="min-h-screen flex items-center justify-center p-4">
  <div class="bg-[hsl(var(--card))] border border-[hsl(var(--border))] rounded-xl shadow-2xl p-8 max-w-md w-full">
    <div class="flex items-center justify-center mb-6">
      <img src="/assets/logo.png" alt="AI Subtitle Translator" class="w-16 h-16">
    </div>
    <h1 class="text-2xl font-bold mb-2 text-center">Setup Configuration</h1>
    <p class="text-[hsl(var(--muted-foreground))] mb-6 text-center">Create a password to protect your configuration settings.</p>
    
    ${errorMessage ? `
      <div class="bg-red-900/20 border border-red-700/50 rounded-md p-3 mb-4">
        <p class="text-red-200 text-sm">${escapeHtml(errorMessage)}</p>
      </div>
    ` : ''}
    
    <form method="POST" action="/stremio/${uuid}/${encryptedConfig}/configure">
      <input type="hidden" name="setup" value="1">
      
      <div class="mb-4">
        <label for="password" class="block text-sm font-medium mb-2">
          Password <span class="text-red-500">*</span>
        </label>
        <input 
          type="password" 
          id="password" 
          name="password" 
          required
          minlength="8"
          class="w-full px-3 py-2 bg-[hsl(var(--background))] border border-[hsl(var(--border))] rounded-md text-[hsl(var(--foreground))] focus:outline-none focus:ring-2 focus:ring-[hsl(var(--primary))]"
          autocomplete="new-password"
          autofocus
        >
        <p class="text-xs text-[hsl(var(--muted-foreground))] mt-1">Minimum 8 characters</p>
      </div>
      
      <div class="mb-6">
        <label for="confirmPassword" class="block text-sm font-medium mb-2">
          Confirm Password <span class="text-red-500">*</span>
        </label>
        <input 
          type="password" 
          id="confirmPassword" 
          name="confirmPassword" 
          required
          minlength="8"
          class="w-full px-3 py-2 bg-[hsl(var(--background))] border border-[hsl(var(--border))] rounded-md text-[hsl(var(--foreground))] focus:outline-none focus:ring-2 focus:ring-[hsl(var(--primary))]"
          autocomplete="new-password"
        >
      </div>
      
      <button 
        type="submit"
        class="w-full px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-md transition-colors"
      >
        Create Configuration
      </button>
    </form>
  </div>
</body>
</html>
  `;
}

/**
 * Generate password unlock page for existing users
 */
function generateUnlockPage(uuid, encryptedConfig, errorMessage = null) {
  const baseUrl = process.env.BASE_URL || 'http://localhost:7001';
  
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Unlock Configuration - AI Subtitle Translator</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    :root {
      --background: 0 0% 3.9%;
      --foreground: 0 0% 98%;
      --card: 0 0% 7%;
      --border: 0 0% 14.9%;
      --primary: 221.2 83.2% 53.3%;
      --muted-foreground: 0 0% 63.9%;
    }
    body {
      background-color: hsl(var(--background));
      color: hsl(var(--foreground));
      font-family: ui-sans-serif, system-ui, sans-serif;
    }
  </style>
</head>
<body class="min-h-screen flex items-center justify-center p-4">
  <div class="bg-[hsl(var(--card))] border border-[hsl(var(--border))] rounded-xl shadow-2xl p-8 max-w-md w-full">
    <h1 class="text-2xl font-bold mb-2">Unlock Configuration</h1>
    <p class="text-[hsl(var(--muted-foreground))] mb-6">Enter your password to access your configuration settings.</p>
    
    ${errorMessage ? `
      <div class="bg-red-900/20 border border-red-700/50 rounded-md p-3 mb-4">
        <p class="text-red-200 text-sm">${escapeHtml(errorMessage)}</p>
      </div>
    ` : ''}
    
    <form method="POST" action="/stremio/${uuid}/${encryptedConfig}/unlock">
      
      <div class="mb-6">
        <label for="password" class="block text-sm font-medium mb-2">
          Password <span class="text-red-500">*</span>
        </label>
        <input 
          type="password" 
          id="password" 
          name="password" 
          required
          class="w-full px-3 py-2 bg-[hsl(var(--background))] border border-[hsl(var(--border))] rounded-md text-[hsl(var(--foreground))] focus:outline-none focus:ring-2 focus:ring-[hsl(var(--primary))]"
          autocomplete="current-password"
          autofocus
        >
      </div>
      
      <button 
        type="submit"
        class="w-full px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-md transition-colors"
      >
        Unlock Configuration
      </button>
    </form>
    
    <p class="text-xs text-[hsl(var(--muted-foreground))] mt-4 text-center">
      Forgot your password? You'll need to create a new configuration.
    </p>
      </div>
    </body>
    </html>
  `;
}

/**
 * Configuration page - Built with shadcn-inspired components
 */
app.get('/stremio/:uuid/:encryptedConfig/configure', async (req, res) => {
  const { uuid, encryptedConfig } = req.params;
  
  // Validate UUID format
  if (!isValidUUID(uuid)) {
    return res.status(400).send(generateErrorPage(
      'Invalid Configuration',
      'The configuration ID is invalid or malformed.'
    ));
  }
  
  const userId = uuid;
  const fileExists = await configFileExists(userId);
  
  // Check if config is already unlocked in session (cookie-based)
  if (isConfigUnlocked(req, userId)) {
    const sessionToken = getSessionToken(req);
    const currentPrefs = getUnlockedConfig(sessionToken);
    return renderConfigPage(req, res, userId, uuid, encryptedConfig, currentPrefs);
  }
  
  // Unlock is now handled via POST route - removed GET handler for security
  
  // If config exists, show unlock form
  if (fileExists) {
    return res.send(generateUnlockPage(uuid, encryptedConfig));
  }
  
  // Show setup form for new users
  return res.send(generateSetupPage(uuid, encryptedConfig));
});

/**
 * Render the main configuration page
 */
function renderConfigPage(req, res, userId, uuid, encryptedConfig, currentPrefs) {

  const selectedModel = currentPrefs.translation?.model || 'auto';
  const dynamicModelOptions = [
    `<option value="auto" ${selectedModel === 'auto' ? 'selected' : ''}>Auto (Top FREE fastest)</option>`,
    ...Object.keys(MODEL_CONFIGS)
      .sort((a, b) => (MODEL_CONFIGS[a].priority ?? 999) - (MODEL_CONFIGS[b].priority ?? 999))
      .map(id => {
        const meta = MODEL_META[id];
        const labelBase = meta?.name ? escapeHtml(meta.name) : escapeHtml(id);
        const latency = meta?.latencyP50Ms ? ` (~${Math.round(meta.latencyP50Ms)}ms p50)` : '';
        const label = `${labelBase}${latency}`;
        return `<option value="${escapeHtml(id)}" ${selectedModel === id ? 'selected' : ''}>${label}</option>`;
      })
  ].join('\n');

  const selectedLangs = currentPrefs.languages || ['en'];
  const saved = req.query.saved === 'true';
  const baseUrl = process.env.BASE_URL || `http://${req.get('host')}`;
  const manifestUrl = `${baseUrl}/stremio/${uuid}/${encryptedConfig}/manifest.json`;
  
  // Check if config has been saved at least once (has API key or languages configured)
  const hasApiKey = currentPrefs.openrouter?.apiKey && currentPrefs.openrouter.apiKey.length > 0;
  const hasLanguages = selectedLangs && selectedLangs.length > 0;
  const showInstallSection = saved || hasApiKey || hasLanguages;
  
  // Check if session is unlocked (password not required if unlocked)
  const isUnlocked = isConfigUnlocked(req, userId);
  
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
  
  const sortedLanguages = [...languages].sort((a, b) => {
    const aSelected = selectedLangs.includes(a.code);
    const bSelected = selectedLangs.includes(b.code);
    if (aSelected && !bSelected) return -1;
    if (!aSelected && bSelected) return 1;
    // If both selected or both unselected, maintain original order
    return languages.indexOf(a) - languages.indexOf(b);
  });
  
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>AI Subtitle Translator - Configuration</title>
      <link rel="icon" type="image/png" href="/assets/logo.png">
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
              <div class="flex items-center gap-4">
                <img src="/assets/logo.png" alt="AI Subtitle Translator" class="w-12 h-12 sm:w-16 sm:h-16 flex-shrink-0">
                <div>
                  <h1 class="text-2xl sm:text-3xl font-semibold text-[hsl(var(--foreground))] mb-1">AI Subtitle Translator</h1>
                  <p class="text-[hsl(var(--muted-foreground))] text-sm sm:text-base">Select your preferred subtitle languages</p>
                </div>
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
                    ${sortedLanguages.map(lang => `
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
                    <div class="relative">
                      <input 
                        type="password" 
                        id="openrouterApiKey" 
                        name="openrouterApiKey" 
                        placeholder="sk-or-v1-..."
                        value="${currentPrefs.openrouter?.apiKey || ''}"
                        class="w-full px-3 py-2 pr-10 bg-[hsl(var(--background))] border border-[hsl(var(--border))] rounded-md text-[hsl(var(--foreground))]"
                        autocomplete="off"
                      >
                      <button 
                        type="button"
                        onclick="toggleApiKeyVisibility()"
                        class="absolute right-3 top-1/2 transform -translate-y-1/2 text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] focus:outline-none"
                        aria-label="Toggle API key visibility"
                      >
                        <svg id="apiKeyEyeIcon" class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path>
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"></path>
                        </svg>
                      </button>
                    </div>
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
${dynamicModelOptions}
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
              
              ${showInstallSection ? `
        <!-- Success Message & Installation Buttons -->
        <div class="mt-6 p-6 bg-[hsl(var(--card))] border border-[hsl(var(--border))] rounded-lg">
          ${saved ? `
          <div class="flex items-center gap-3 mb-4">
            <div class="w-8 h-8 bg-green-500 rounded-full flex items-center justify-center text-white text-sm font-bold flex-shrink-0">✓</div>
            <div class="text-sm font-medium text-[hsl(var(--foreground))]">Configuration saved successfully!</div>
          </div>
          ` : ''}
          
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
          
          // Remove ?saved=true from URL after page loads to prevent showing message on refresh
          if (window.location.search.includes('saved=true')) {
            const url = new URL(window.location);
            url.searchParams.delete('saved');
            window.history.replaceState({}, '', url);
          }
          
          // Toggle API key visibility
          function toggleApiKeyVisibility() {
            const input = document.getElementById('openrouterApiKey');
            const icon = document.getElementById('apiKeyEyeIcon');
            if (input.type === 'password') {
              input.type = 'text';
              icon.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21"></path>';
            } else {
              input.type = 'password';
              icon.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"></path>';
            }
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
        let languageLabels = document.querySelectorAll('label[data-lang]');
        
        function sortLanguagesGrid() {
          const grid = document.getElementById('languagesGrid');
          const labels = Array.from(grid.querySelectorAll('label[data-lang]'));
          
          // Sort: selected first, then unselected (maintaining order within each group)
          labels.sort((a, b) => {
            const aCheckbox = a.querySelector('input[type="checkbox"]');
            const bCheckbox = b.querySelector('input[type="checkbox"]');
            const aSelected = aCheckbox.checked;
            const bSelected = bCheckbox.checked;
            
            if (aSelected && !bSelected) return -1;
            if (!aSelected && bSelected) return 1;
            // If both selected or both unselected, maintain current order
            return 0;
          });
          
          // Re-append in sorted order
          labels.forEach(label => grid.appendChild(label));
        }
        
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
          
          // Re-sort the grid to keep selected languages at top
          sortLanguagesGrid();
          
          // Update the languageLabels reference after sorting
          languageLabels = document.querySelectorAll('label[data-lang]');
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
}

/**
 * Render the main configuration page
 */
function renderConfigPage(req, res, userId, uuid, encryptedConfig, currentPrefs) {
  const selectedLangs = currentPrefs.languages || ['en'];
  const saved = req.query.saved === 'true';
  const baseUrl = process.env.BASE_URL || `http://${req.get('host')}`;
  const manifestUrl = `${baseUrl}/stremio/${uuid}/${encryptedConfig}/manifest.json`;
  
  // Check if config has been saved at least once (has API key or languages configured)
  const hasApiKey = currentPrefs.openrouter?.apiKey && currentPrefs.openrouter.apiKey.length > 0;
  const hasLanguages = selectedLangs && selectedLangs.length > 0;
  const showInstallSection = saved || hasApiKey || hasLanguages;
  
  // Check if session is unlocked (password not required if unlocked)
  const isUnlocked = isConfigUnlocked(req, userId);
  
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
  
  const sortedLanguages = [...languages].sort((a, b) => {
    const aSelected = selectedLangs.includes(a.code);
    const bSelected = selectedLangs.includes(b.code);
    if (aSelected && !bSelected) return -1;
    if (!aSelected && bSelected) return 1;
    // If both selected or both unselected, maintain original order
    return languages.indexOf(a) - languages.indexOf(b);
  });
  
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>AI Subtitle Translator - Configuration</title>
      <link rel="icon" type="image/png" href="/assets/logo.png">
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
              <div class="flex items-center gap-4">
                <img src="/assets/logo.png" alt="AI Subtitle Translator" class="w-12 h-12 sm:w-16 sm:h-16 flex-shrink-0">
                <div>
                  <h1 class="text-2xl sm:text-3xl font-semibold text-[hsl(var(--foreground))] mb-1">AI Subtitle Translator</h1>
                  <p class="text-[hsl(var(--muted-foreground))] text-sm sm:text-base">Select your preferred subtitle languages</p>
                </div>
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
                    ${sortedLanguages.map(lang => `
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
                    <div class="relative">
                      <input 
                        type="password" 
                        id="openrouterApiKey" 
                        name="openrouterApiKey" 
                        placeholder="sk-or-v1-..."
                        value="${currentPrefs.openrouter?.apiKey || ''}"
                        class="w-full px-3 py-2 pr-10 bg-[hsl(var(--background))] border border-[hsl(var(--border))] rounded-md text-[hsl(var(--foreground))]"
                        autocomplete="off"
                      >
                      <button 
                        type="button"
                        onclick="toggleApiKeyVisibility()"
                        class="absolute right-3 top-1/2 transform -translate-y-1/2 text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] focus:outline-none"
                        aria-label="Toggle API key visibility"
                      >
                        <svg id="apiKeyEyeIcon" class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path>
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"></path>
                        </svg>
                      </button>
                    </div>
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
                
                <!-- Password Confirmation for Saving -->
                ${!isUnlocked ? `
                <div class="bg-yellow-900/20 border border-yellow-700/50 rounded-md p-3 mb-4">
                  <p class="text-yellow-200 text-sm mb-2">
                    <strong>⚠️ Password Required</strong><br>
                    Enter your configuration password to save changes.
                  </p>
                  <div class="mb-2">
                    <label for="savePassword" class="block text-sm font-medium mb-1">
                      Configuration Password <span class="text-red-500">*</span>
                    </label>
                    <input 
                      type="password" 
                      id="savePassword" 
                      name="password" 
                      required
                      class="w-full px-3 py-2 bg-[hsl(var(--background))] border border-[hsl(var(--border))] rounded-md text-[hsl(var(--foreground))]"
                      autocomplete="current-password"
                      placeholder="Enter your configuration password"
                    >
                    <p class="text-xs text-[hsl(var(--muted-foreground))] mt-1">
                      Your password is required to encrypt and save your configuration.
                    </p>
                  </div>
                </div>
                ` : `
                <input type="hidden" name="password" id="savePassword" value="">
                `}
                
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
              
              ${showInstallSection ? `
        <!-- Success Message & Installation Buttons -->
        <div class="mt-6 p-6 bg-[hsl(var(--card))] border border-[hsl(var(--border))] rounded-lg">
          ${saved ? `
          <div class="flex items-center gap-3 mb-4">
            <div class="w-8 h-8 bg-green-500 rounded-full flex items-center justify-center text-white text-sm font-bold flex-shrink-0">✓</div>
            <div class="text-sm font-medium text-[hsl(var(--foreground))]">Configuration saved successfully!</div>
          </div>
          ` : ''}
          
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
          
          // Remove ?saved=true from URL after page loads to prevent showing message on refresh
          if (window.location.search.includes('saved=true')) {
            const url = new URL(window.location);
            url.searchParams.delete('saved');
            window.history.replaceState({}, '', url);
          }
          
          // Toggle API key visibility
          function toggleApiKeyVisibility() {
            const input = document.getElementById('openrouterApiKey');
            const icon = document.getElementById('apiKeyEyeIcon');
            if (input.type === 'password') {
              input.type = 'text';
              icon.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21"></path>';
            } else {
              input.type = 'password';
              icon.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"></path>';
            }
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
        let languageLabels = document.querySelectorAll('label[data-lang]');
        
        function sortLanguagesGrid() {
          const grid = document.getElementById('languagesGrid');
          const labels = Array.from(grid.querySelectorAll('label[data-lang]'));
          
          // Sort: selected first, then unselected (maintaining order within each group)
          labels.sort((a, b) => {
            const aCheckbox = a.querySelector('input[type="checkbox"]');
            const bCheckbox = b.querySelector('input[type="checkbox"]');
            const aSelected = aCheckbox.checked;
            const bSelected = bCheckbox.checked;
            
            if (aSelected && !bSelected) return -1;
            if (!aSelected && bSelected) return 1;
            // If both selected or both unselected, maintain current order
            return 0;
          });
          
          // Re-append in sorted order
          labels.forEach(label => grid.appendChild(label));
        }
        
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
          
          // Re-sort the grid to keep selected languages at top
          sortLanguagesGrid();
          
          // Update the languageLabels reference after sorting
          languageLabels = document.querySelectorAll('label[data-lang]');
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
}

/**
 * Handle unlock form submission (POST to avoid password in URL)
 */
app.post('/stremio/:uuid/:encryptedConfig/unlock', async (req, res) => {
  const { uuid, encryptedConfig } = req.params;
  
  // Validate UUID format
  if (!isValidUUID(uuid)) {
    return res.status(400).send(generateErrorPage(
      'Invalid Configuration',
      'The configuration ID is invalid or malformed.'
    ));
  }
  
  const userId = uuid;
  const fileExists = await configFileExists(userId);
  
  if (!fileExists) {
    return res.send(generateUnlockPage(uuid, encryptedConfig, 'Configuration not found. Please set up a new configuration.'));
  }
  
  const password = req.body.password;
  if (!password || password.length === 0) {
    return res.send(generateUnlockPage(uuid, encryptedConfig, 'Password is required.'));
  }
  
  try {
    const config = await loadUserConfig(userId, password);
    
    // Unlock config in session and get session token
    // Note: Password is stored temporarily in memory for session duration (30 min) to allow saving without re-entry
    const sessionToken = unlockConfig(userId, config, password);
    
    // Set session cookie
    res.cookie(SESSION_COOKIE_NAME, sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: SESSION_TIMEOUT
    });
    
    // Redirect to config page
    res.redirect(`/stremio/${uuid}/${encryptedConfig}/configure`);
    return;
  } catch (error) {
    if (error.message === 'Incorrect password' || error.message.includes('Decryption failed')) {
      return res.send(generateUnlockPage(uuid, encryptedConfig, 'Incorrect password. Please try again.'));
    }
    console.error('Error unlocking config:', error);
    return res.send(generateUnlockPage(uuid, encryptedConfig, 'An error occurred while unlocking your configuration.'));
  }
});

/**
 * Handle configuration form submission
 */
app.post('/stremio/:uuid/:encryptedConfig/configure', async (req, res) => {
  const { uuid, encryptedConfig } = req.params;
  const userId = uuid;
  
  // Check if this is a setup request
  if (req.body.setup === '1') {
    const password = req.body.password;
    const confirmPassword = req.body.confirmPassword;
    
    if (password.length < 8) {
      return res.send(generateSetupPage(uuid, encryptedConfig, 'Password must be at least 8 characters long.'));
    }
    
    if (password !== confirmPassword) {
      return res.send(generateSetupPage(uuid, encryptedConfig, 'Passwords do not match.'));
    }
    
    const defaultConfig = {
      languages: ['en'],
      uuid: userId,
      openrouter: {
        apiKey: '',
        referer: process.env.OPENROUTER_REFERER || ''
      },
      translation: {
        enabled: false,
        model: 'auto'
      }
    };
    
    try {
      await saveUserConfig(userId, defaultConfig, password);
      const sessionToken = unlockConfig(userId, defaultConfig, password);
      
      // Set session cookie
      res.cookie(SESSION_COOKIE_NAME, sessionToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: SESSION_TIMEOUT
      });
      
      res.redirect(`/stremio/${uuid}/${encryptedConfig}/configure`);
      return;
    } catch (error) {
      return res.send(generateSetupPage(uuid, encryptedConfig, 'Error creating configuration.'));
    }
  }
  
  // Get password from request or from session
  let password = req.body.password;
  const sessionToken = getSessionToken(req);
  const session = unlockedConfigs[sessionToken];
  
  // Check if we have a valid session (even if slightly expired, we'll refresh it)
  const hasValidSession = session && session.userId === userId;
  
  // If no password provided but we have a valid session, use password from session
  if ((!password || password.length === 0) && hasValidSession && session.password) {
    password = session.password;
    // Refresh the session expiration
    session.expiresAt = Date.now() + SESSION_TIMEOUT;
  }
  
  // If we still don't have a password and no valid session, require unlock
  if ((!password || password.length === 0) && !hasValidSession) {
    return res.status(403).send(generateErrorPage(
      'Configuration Locked',
      'Please unlock your configuration first by entering your password.'
    ));
  }
  
  // If still no password, require it
  if (!password || password.length === 0) {
    return res.status(400).send(generateErrorPage(
      'Password Required',
      'Please enter your password to save changes to your configuration.'
    ));
  }
  
  let passwordSalt;
  try {
    const fileExists = await configFileExists(userId);
    if (!fileExists) {
      return res.status(404).send(generateErrorPage(
        'Configuration Not Found',
        'Configuration file not found. Please set up a new configuration.'
      ));
    }
    
    const testConfig = await loadUserConfig(userId, password);
    const configPath = path.join(CONFIG_DIR, `${userId}.json`);
    const fileData = JSON.parse(await fs.readFile(configPath, 'utf8'));
    passwordSalt = fileData.passwordSalt;
  } catch (error) {
    if (error.message === 'Incorrect password' || error.message.includes('Decryption failed')) {
      return res.status(401).send(generateErrorPage(
        'Incorrect Password',
        'The password you entered is incorrect. Please try again.'
      ));
    }
    throw error;
  }
  
  if (!isValidUUID(uuid)) {
      return res.status(400).send(generateErrorPage(
        'Invalid Configuration',
      'The configuration ID is invalid or malformed.'
      ));
  }
  
  let languages = [];
  if (Array.isArray(req.body.languages)) {
    languages = req.body.languages.map(lang => lang.trim().toLowerCase()).filter(lang => lang.length > 0);
  } else if (typeof req.body.languages === 'string') {
    languages = req.body.languages
      .split(',')
      .map(lang => lang.trim().toLowerCase())
      .filter(lang => lang.length > 0);
  }
  
  if (languages.length === 0) {
    languages = ['en'];
  }
  
  const openrouterApiKey = (req.body.openrouterApiKey || '').trim();
  const openrouterReferer = (req.body.openrouterReferer || process.env.OPENROUTER_REFERER || '').trim();
  
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
  
  const newConfig = {
    languages: languages,
    uuid: userId,
    updatedAt: new Date().toISOString(),
    openrouter: {
      apiKey: openrouterApiKey,
      referer: openrouterReferer
    },
    translation: {
      enabled: openrouterApiKey.length > 0,
      model: (() => {
            const requestedModel = (req.body.translationModel || 'auto').trim();
            return (requestedModel === 'auto' || MODEL_CONFIGS[requestedModel]) ? requestedModel : 'auto';
          })()
    }
  };
  
    try {
      await saveUserConfig(userId, newConfig, password);
      
      const sessionToken = getSessionToken(req) || unlockConfig(userId, newConfig);
      if (!getSessionToken(req)) {
        res.cookie(SESSION_COOKIE_NAME, sessionToken, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax',
          maxAge: SESSION_TIMEOUT
        });
      } else {
        const existingSession = unlockedConfigs[sessionToken];
        unlockedConfigs[sessionToken] = {
          userId: userId,
          config: newConfig,
          password: existingSession?.password || password,
          unlockedAt: existingSession?.unlockedAt || Date.now(),
          expiresAt: Date.now() + SESSION_TIMEOUT
        };
      }
      
      const newEncryptedConfig = encryptConfig({ 
        uuid: userId, 
        languages: languages,
        openrouter: newConfig.openrouter,
        translation: newConfig.translation
      });
      
      userPreferences[userId] = newConfig;
      
      console.log(`Saved configuration to file: configs/${userId}.json`);
      console.log(`  Languages: ${languages.join(', ')}`);
      console.log(`  OpenRouter API Key: ${openrouterApiKey ? '***' + openrouterApiKey.slice(-4) : 'Not set'}`);
      
      res.redirect(`/stremio/${uuid}/${newEncryptedConfig}/configure?saved=true`);
    } catch (error) {
      console.error('Error saving config:', error);
      return res.status(500).send(generateErrorPage(
        'Save Failed',
        'An error occurred while saving your configuration. Please try again.'
      ));
    }
});

app.get('/', (req, res) => {
  res.redirect('/configure');
});

app.get('/configure', (req, res) => {
  const newUuid = uuidv4();
  const defaultConfig = {
    uuid: newUuid,
    languages: ['en']
  };
  const newConfig = encryptConfig(defaultConfig);
  res.redirect(`/stremio/${newUuid}/${newConfig}/configure`);
});

// Stremio Addon Builder

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

// Subtitles Handler

let subtitleHandlerFunction = null;

const subtitleHandler = async function(args) {
  const { type, id, extra, userData } = args;
  const season = extra?.season;
  const episode = extra?.episode;
  
  try {
    const userId = userData?.userId || userData?.uuid || 'default';
    
    let userConfig = null;
    // Note: For subtitle requests, we can't use req object, so we'll use a fallback
    // Subtitle requests don't require password (read-only access)
    // We'll use the in-memory cache or default config
    
    // Fallback to in-memory cache
    if (!userConfig && userPreferences[userId]) {
      userConfig = userPreferences[userId];
    }
    
    // Use default if neither available
    if (!userConfig) {
      userConfig = { 
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
    }
    
    // Use languages from the loaded config (not from getUserLanguages which uses old cache)
    const preferredLanguages = userConfig.languages || ['en'];
    
    const allLanguages = ['en', ...preferredLanguages.filter(lang => lang !== 'en')];
    const subtitles = [];
    
    let bestEnglishSubtitle = null;
    
    console.log(`\nProcessing subtitle request for ${type}/${id} (season: ${season}, episode: ${episode})`);
    console.log(`User ID: ${userId}`);
    console.log(`User preferred languages: ${preferredLanguages.join(', ')}`);
    console.log(`OpenRouter API Key: ${userConfig.openrouter?.apiKey ? 'Configured' : 'Not configured - translation will fail'}`);
    console.log(`Processing languages: ${allLanguages.join(', ')}`);
    
    for (const lang of allLanguages) {
      try {
        console.log(`Attempting to fetch ${lang} subtitle from wyzie-lib...`);
        const wyzieSubtitles = await getSubtitlesFromWyzie(type, id, season, episode, lang);
        
        const subtitleArray = Array.isArray(wyzieSubtitles) ? wyzieSubtitles : (wyzieSubtitles ? [wyzieSubtitles] : []);
        
        if (subtitleArray.length > 0) {
          console.log(`Found ${subtitleArray.length} ${lang} subtitle(s) in wyzie-lib`);
          
          if (lang === 'en' && !bestEnglishSubtitle) {
            bestEnglishSubtitle = subtitleArray[0];
            console.log(`Stored best English subtitle for translation (using first of ${subtitleArray.length} available)`);
          }
          
          for (let i = 0; i < subtitleArray.length; i++) {
            const wyzieSubtitle = subtitleArray[i];
            
            if (!wyzieSubtitle || !wyzieSubtitle.content) {
              console.log(`Skipping invalid ${lang} subtitle ${i + 1}`);
              continue;
            }
            
            const vttContent = convertToVTT(wyzieSubtitle.content, wyzieSubtitle.format);
            
            if (!vttContent) {
              console.log(`Failed to convert ${lang} subtitle ${i + 1} to VTT`);
              continue;
            }
            
            const subtitleUrl = await serveSubtitleContent(
              vttContent,
              lang,
              type,
              id,
              season,
              episode
            );
            
            if (subtitleUrl) {
              const subtitleName = subtitleArray.length > 1 
                ? `${lang.toUpperCase()} Subtitles (${i + 1})`
                : `${lang.toUpperCase()} Subtitles`;
              
              subtitles.push({
                id: `${lang}_${id}_${Date.now()}_${i}`,
                url: subtitleUrl,
                lang: lang,
                name: subtitleName
              });
            }
          }
        } else {
          console.log(`${lang} subtitle not found in wyzie-lib, attempting AI translation from English...`);
          
          let englishSubtitle = bestEnglishSubtitle;
          
          if (!englishSubtitle) {
            console.log(`Best English subtitle not cached, fetching now...`);
            const englishSubtitles = await getSubtitlesFromWyzie(type, id, season, episode, 'en');
            const englishArray = Array.isArray(englishSubtitles) ? englishSubtitles : (englishSubtitles ? [englishSubtitles] : []);
            englishSubtitle = englishArray.length > 0 ? englishArray[0] : null;
            
            if (englishSubtitle) {
              bestEnglishSubtitle = englishSubtitle;
            }
          }
          
          if (englishSubtitle && englishSubtitle.content) {
            try {
              const translatedContent = await translateSubtitlesWithGemini(
                englishSubtitle.content,
                lang,
                userConfig
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
                console.error(`Translation failed: User needs to configure OpenRouter API key`);
                const baseUrl = process.env.BASE_URL || `http://${req?.get?.('host') || 'localhost:7001'}`;
                console.error(`Visit: ${baseUrl}/configure`);
              } else {
                console.error(`Error translating to ${lang}:`, translationError.message);
              }
            }
          } else {
            console.log(`English subtitle not available for translation to ${lang}`);
          }
        }
      } catch (error) {
        console.error(`Error processing ${lang} subtitle:`, error.message);
      }
    }
    
    console.log(`Returning ${subtitles.length} subtitle(s) for ${type}/${id}`);
    if (subtitles.length === 0) {
      console.log(`No subtitles found/translated. This might be because:`);
      console.log(`   - No English subtitles available for this content`);
      console.log(`   - Translation failed`);
      console.log(`   - Subtitle fetching from wyzie-lib failed`);
    }
    return Promise.resolve({ subtitles });
    
  } catch (error) {
    console.error('Error in subtitles handler:', error);
    console.error('Stack:', error.stack);
    return Promise.resolve({ subtitles: [] });
  }
};

subtitleHandlerFunction = subtitleHandler;

builder.defineSubtitlesHandler(subtitleHandler);

// Server Setup

const port = process.env.PORT || 7001;

app.get('/stremio/:uuid/:encryptedConfig/manifest.json', async (req, res) => {
  try {
    const { uuid, encryptedConfig } = req.params;
    
    // Use request host if available, otherwise fall back to BASE_URL or default
    const protocol = req.protocol || 'http';
    const host = req.get('host') || `127.0.0.1:${port}`;
    const baseUrl = process.env.BASE_URL || `${protocol}://${host}`;
    const configUrl = `${baseUrl}/stremio/${uuid}/${encryptedConfig}/configure`;
    
    const manifestData = {
      id: `com.aistreamio.subtitles.${uuid}`,
      version: '1.0.0',
      name: 'AI Subtitle Translator',
      description: 'Translates subtitles using AI (OpenRouter) for Stremio',
      logo: `${baseUrl}/assets/logo.png`,
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
    res.setHeader('Content-Type', 'application/json');
    res.json(manifestData);
  } catch (error) {
    console.error('Error serving manifest:', error);
    res.status(500).json({ error: 'Failed to serve manifest' });
  }
});

app.get('/stremio/:uuid/:encryptedConfig/subtitles/:type/:id*.json', async (req, res) => {
  try {
    let { uuid, encryptedConfig, type, id } = req.params;
    let extra = { ...req.query };
    
    console.log('\n=== SUBTITLE REQUEST ===');
    console.log(`Full path: ${req.path}`);
    console.log(`Full URL: ${req.url}`);
    console.log(`Raw ID param: ${id}`);
    
    if (id && (id.includes('filename=') || id.includes('videoSize=') || id.includes('videoHash='))) {
      const parts = id.split('/');
      const actualId = parts[0];
      id = decodeURIComponent(actualId);
      
      if (parts.length > 1) {
        const queryString = parts.slice(1).join('/');
        const cleanQuery = queryString.replace(/\.json$/, '');
        
        cleanQuery.split('&').forEach(param => {
          const [key, ...valueParts] = param.split('=');
          if (key && valueParts.length > 0) {
            const value = valueParts.join('=');
            extra[decodeURIComponent(key)] = decodeURIComponent(value);
          }
        });
      }
    } else {
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
    
    let userId = uuid;
    let decryptedUrlConfig = null;
    if (encryptedConfig && encryptedConfig !== 'new') {
      decryptedUrlConfig = decryptConfig(encryptedConfig);
      if (decryptedUrlConfig) {
        userId = decryptedUrlConfig.uuid || uuid;
        console.log(`Decrypted config from URL - User ID: ${userId}, Languages: ${decryptedUrlConfig.languages?.join(', ')}`);
      } else {
        console.log('Could not decrypt config, using UUID');
      }
    }
    
    if (!userPreferences[userId] && decryptedUrlConfig) {
      userPreferences[userId] = {
        languages: decryptedUrlConfig.languages || ['en'],
        uuid: userId,
        openrouter: decryptedUrlConfig.openrouter || {
          apiKey: '',
          referer: process.env.OPENROUTER_REFERER || ''
        },
        translation: decryptedUrlConfig.translation || {
          enabled: false,
          model: 'auto'
        }
      };
      console.log(`Using URL config (fallback) - Languages: ${userPreferences[userId].languages?.join(', ')}`);
    } else if (userPreferences[userId]) {
      console.log(`Using cached config - Languages: ${userPreferences[userId].languages?.join(', ')}`);
    }
    
    let season, episode;
    if (id.includes(':')) {
      const parts = id.split(':');
      id = parts[0];
      if (parts.length >= 2) season = parseInt(parts[1]);
      if (parts.length >= 3) episode = parseInt(parts[2]);
      console.log(`Parsed ID: ${id}, Season: ${season}, Episode: ${episode}`);
    }
    
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
    console.error('Error serving subtitles:', error);
    console.error('Stack:', error.stack);
    res.status(500).json({ error: 'Failed to serve subtitles', message: error.message });
  }
});

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

app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    service: 'aisubs'
  });
});

// Initialize configs directory and load config count
(async () => {
  try {
    await ensureConfigDir();
    const count = await loadAllConfigs();
    console.log(`Configuration directory ready: ${CONFIG_DIR}`);
  } catch (error) {
    console.error('Error initializing configs directory:', error);
    console.log('Server will continue, but config saving may fail');
  }
})();

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
    console.error(`\nError: Port ${port} is already in use.`);
    console.error(`Please either:`);
    console.error(`  1. Stop the process using port ${port}: lsof -ti:${port} | xargs kill -9`);
    console.error(`  2. Use a different port by setting PORT in .env file\n`);
    process.exit(1);
  } else {
    console.error('Server error:', error);
    process.exit(1);
  }
});
