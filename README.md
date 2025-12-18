# Stremio AI Subtitle Translator Addon

A Stremio addon that provides AI-translated subtitles using OpenRouter (supports multiple AI models including Llama, Gemma, and Mistral). The addon fetches subtitles from wyzie-lib and translates them using AI when subtitles in the requested language are not available.

## Features

- **Multi-language Support**: Configure your preferred subtitle languages
- **Smart Fallback**: Automatically fetches English subtitles and translates them using AI when subtitles in your preferred language aren't available
- **wyzie-lib Integration**: Uses wyzie-lib to search for existing subtitles in various languages
- **Configuration Page**: Easy-to-use web interface for selecting preferred languages
- **VTT Format**: Converts subtitles to VTT format for Stremio compatibility
- **Intelligent Chunking**: Optimized parallel processing with rate limiting for fast translations
- **Multiple AI Models**: Automatically selects the best available model from OpenRouter (Llama, Gemma, Mistral)

## Prerequisites

- Node.js (v14 or higher) or Bun
- OpenRouter API key ([Get one here](https://openrouter.ai/keys))

## Installation

1. Clone or download this repository

2. Install dependencies:
```bash
bun install
# or
npm install
```

3. Create a `.env` file in the root directory:
```env
PORT=7001
BASE_URL=http://127.0.0.1:7001
MASTER_KEY=your_master_key_here_32_bytes_hex
```

**Note on MASTER_KEY**: This is used to encrypt public configs (languages and API keys) for read-only access without passwords. If not set, a random key is generated on each restart, which means configs won't persist across restarts. For production, generate a secure 32-byte hex key:
```bash
openssl rand -hex 32
```

**Important**: Each user must configure their own OpenRouter API key in the addon's configuration page. The server does NOT provide a fallback API key.

4. Get your OpenRouter API key:
   - Visit [OpenRouter](https://openrouter.ai/keys)
   - Create a new API key
   - Add it in the addon's configuration page (not in `.env`)
   - The referer field is optional but recommended

## Docker Deployment

### Quick Start with Docker

1. Clone the repository:
```bash
git clone <repo-url>
cd AISubs
```

2. Create a `.env` file from the template:
```bash
cp .env.sample .env
# Edit .env with your settings
```

3. Generate a secure MASTER_KEY:
```bash
openssl rand -hex 32
```
Add this to your `.env` file.

4. Start with Docker Compose:
```bash
docker-compose up -d
```

5. Access the service:
   - Configuration page: `http://localhost:7001/configure`
   - Manifest URL: `http://localhost:7001/manifest.json`
   - Health check: `http://localhost:7001/health`

### Docker Commands

- **Build image**: `npm run docker:build` or `docker build -t aisubs .`
- **Start container**: `npm run docker:run` or `docker-compose up -d`
- **Stop container**: `npm run docker:stop` or `docker-compose down`
- **View logs**: `npm run docker:logs` or `docker-compose logs -f`
- **Restart container**: `npm run docker:restart` or `docker-compose restart`

### Docker Configuration

The Docker setup includes:
- **Health checks**: Automatic health monitoring via `/health` endpoint
- **Volume persistence**: Configuration files are persisted in `./configs` directory
- **Auto-restart**: Container automatically restarts unless stopped
- **Port mapping**: Default port 7001 (configurable via `PORT` environment variable)

### Environment Variables for Docker

All environment variables from `.env` are automatically passed to the container:
- `PORT`: Server port (default: 7001)
- `BASE_URL`: Base URL for the addon
- `MASTER_KEY`: Encryption key (32-byte hex string)
- `OPENROUTER_API_KEY`: Optional fallback API key
- `OPENROUTER_REFERER`: Optional referer string

## Usage

1. Start the addon:
```bash
bun start
# or
npm start
```

2. The addon will output:
   - Addon manifest URL: `http://127.0.0.1:7001/manifest.json`
   - Configuration page: `http://127.0.0.1:7001/configure`

3. Configure your preferred languages:
   - Visit the configuration page
   - Enter comma-separated language codes (e.g., `ta,te,hi,es,fr,de,it,pt,ja,ko,zh`)
   - Click "Save Configuration"

4. Install in Stremio:
   - Open Stremio
   - Go to Addons
   - Click "Add Addon"
   - Paste the manifest URL: `http://127.0.0.1:7001/manifest.json`

## How It Works

1. When Stremio requests subtitles for a movie or TV show, the addon:
   - Checks your preferred languages from the configuration
   - Searches wyzie-lib for subtitles in each preferred language
   - If found, serves them directly
   - If not found, fetches English subtitles and translates them using AI via OpenRouter
   - Converts all subtitles to VTT format for Stremio

2. The addon always includes English subtitles as a fallback

3. **Intelligent Translation**:
   - Automatically selects the best available AI model
   - Splits large subtitle files into optimized chunks
   - Processes chunks in parallel (respecting rate limits)
   - Cleans AI output to remove commentary and instructions

## Language Codes

Use ISO 639-1 language codes (2-letter codes):
- `en` - English
- `ta` - Tamil
- `te` - Telugu
- `hi` - Hindi
- `es` - Spanish
- `fr` - French
- `de` - German
- `it` - Italian
- `pt` - Portuguese
- `ja` - Japanese
- `ko` - Korean
- `zh` - Chinese
- And many more...

## Supported Media Types

- Movies (IMDB IDs: `tt1234567`, TMDB IDs: `tmdb:123456`)
- TV Series (with season and episode support)

## Development

The addon uses:
- **stremio-addon-sdk**: Core SDK for Stremio addons
- **wyzie-lib**: Subtitle fetching library
- **express**: HTTP server
- **axios**: HTTP client for OpenRouter API
- **OpenRouter**: Unified API for multiple AI models (Llama, Gemma, Mistral)

### Testing

Run test scripts:
```bash
# Test endpoints
bun test
# or
npm test

# Test full movie translation flow
bun run test:movie
# or
npm run test:movie
```

## Configuration

### OpenRouter API Key Configuration

Each user must configure their own OpenRouter API key through the configuration page:

1. Visit the configuration page after starting the server
2. Enter your OpenRouter API key in the "OpenRouter API Configuration" section
3. Optionally configure HTTP Referer and preferred translation model
4. Save the configuration

**Note**: The server-side `OPENROUTER_API_KEY` environment variable is optional and only used as a fallback if a user hasn't configured their own key. For production use, each user should provide their own API key.

### Environment Variables

- `PORT`: Server port (default: 7001)
- `OPENROUTER_API_KEY`: OpenRouter API key (optional - fallback only, users should configure their own)
- `OPENROUTER_REFERER`: Your app name or URL (optional - used as default if user doesn't specify)
- `BASE_URL`: Base URL for the addon (default: http://127.0.0.1:7001)

### AI Models

The addon automatically selects from these models (in priority order):
1. `meta-llama/llama-3.1-8b-instruct` (60 RPM, 1M TPM)
2. `google/gemma-2-9b-it` (60 RPM, 1M TPM)
3. `google/gemma-2-2b-it` (60 RPM, 1M TPM)
4. `google/gemma-2-1.1b-it` (60 RPM, 1M TPM)
5. `mistralai/mistral-7b-instruct` (60 RPM, 1M TPM)

## Troubleshooting

- **No subtitles appearing**: Check that wyzie-lib can find subtitles for the media, and that your OpenRouter API key is valid
- **Translation not working**: Ensure you have configured your OpenRouter API key in the configuration page. The server-side `OPENROUTER_API_KEY` is optional and only used as a fallback.
- **Configuration not saving**: Check that the server is running and accessible
- **Rate limit errors**: The addon automatically handles rate limits, but if you see errors, check your OpenRouter quota

### Password Protection

Each user configuration is protected with a password:

1. **First Time Setup**: When you first visit the configuration page, you'll be prompted to create a password (minimum 8 characters)
2. **Unlocking**: Each time you visit the configuration page, you'll need to enter your password to unlock and modify settings
3. **Session**: Once unlocked, your configuration remains accessible for 30 minutes without re-entering the password
4. **Saving Changes**: When saving configuration changes, you must re-enter your password for security
5. **Password Recovery**: If you forget your password, you'll need to create a new configuration (old settings cannot be recovered)

**Security Notes**:
- Your password is never stored in plain text - only a secure hash (PBKDF2 with 100,000 iterations) is saved
- Configuration files are encrypted with your password using AES-256-CBC
- Each configuration file is independently encrypted with its own password
- Passwords are required to modify settings, but not to use the addon (read-only access for subtitle requests)
- Configuration files have restricted permissions (600 - owner read/write only)

## Notes

- User configurations are stored in encrypted files in the `configs/` directory and persist across server restarts
- Subtitle content is cached in memory for serving
- The addon uses intelligent chunking and parallel processing for optimal translation speed

## License

MIT
