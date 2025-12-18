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
OPENROUTER_API_KEY=your_openrouter_api_key_here
OPENROUTER_REFERER=your_app_name_or_url
BASE_URL=http://127.0.0.1:7001
```

4. Get your OpenRouter API key:
   - Visit [OpenRouter](https://openrouter.ai/keys)
   - Create a new API key
   - Add it to your `.env` file
   - Set `OPENROUTER_REFERER` to your app name or URL (required by OpenRouter)

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

### Environment Variables

- `PORT`: Server port (default: 7001)
- `OPENROUTER_API_KEY`: Your OpenRouter API key (required)
- `OPENROUTER_REFERER`: Your app name or URL (required by OpenRouter)
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
- **Translation not working**: Ensure `OPENROUTER_API_KEY` and `OPENROUTER_REFERER` are set correctly in `.env`
- **Configuration not saving**: Check that the server is running and accessible
- **Rate limit errors**: The addon automatically handles rate limits, but if you see errors, check your OpenRouter quota

## Notes

- User preferences are stored in memory and will be lost on server restart
- Subtitle content is cached in memory for serving
- For production use, consider implementing persistent storage for preferences and subtitle caching
- The addon uses intelligent chunking and parallel processing for optimal translation speed

## License

MIT
