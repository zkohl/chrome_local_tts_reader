# Local TTS Reader - Chrome Extension
This repo was forked from https://github.com/phildougherty/local_tts_reader, and includes the following changes:
1. Added keyboard shortcuts
   - Read aloud: (Mac: Opt+Shift+R, Win: Alt+Shift+R)
   - Stop playback: (Mac: Opt+Shift+S, Win: Alt+Shift+S)
1. Changed theme to be dark, sleek, and modern
1. Added support for custom voice mixing (e.g. `af_heart(1)+af_aoede(1)`)
1. Performance improvements for long text (implemented chunking of audio generation for concurrent playback and audio generation)
1. Reliability improvements (e.g. starting new speech when already speaking)
1. Implemented parsing from html instead of innertext, to retain document structure context for appropriate pauses after headers and reading lists.

### Suggested TTS setup:
For local hosting, Kokoro via docker compose https://github.com/remsky/Kokoro-FastAPI. Ideally using NVIDIA GPU, but also can work on Mac with more initial latency in audio generation.

# Original Documentation

A sleek Chrome extension that converts webpage text to speech using a local OpenAI-compatible TTS server. Features include voice selection, speed control, and the ability to save audio files.


## Features

- 🎯 Read selected text or entire webpage
- 🎭 Multiple voice options compatible with OpenAI voice mappings
- ⚡ Adjustable playback speed (0.25x to 4.0x)
- 💾 Option to save audio for download
- ⏯️ Play/Pause/Stop/Seek controls
- 🎨 Clean, modern interface
- 🔧 Configurable server URL
- 🌐 Works with Tailscale/local network TTS servers

## Installation

1. Clone this repository:
```bash
git clone https://github.com/phildougherty/local_tts_reader.git
```

2. Load the extension in Chrome:
   - Open Chrome and navigate to `chrome://extensions/`
   - Enable "Developer mode" in the top right
   - Click "Load unpacked"
   - Select the cloned repository folder

## Usage

1. Click the extension icon in your Chrome toolbar
2. Configure your settings:
   - Select your preferred voice
   - Adjust the playback speed using the slider
   - Check "Save audio for download" if you want to download the audio
   - Enter your local TTS server URL

3. On any webpage:
   - Select specific text to read just that portion
   - Or don't select anything to read the entire page
   - Click play to start TTS
   - Use pause/stop controls as needed
   - Download the audio if recording was enabled

## Voice Options

The extension supports the following voices:
- Adam (Alloy) - `am_adam`
- Nicole (Ash) - `af_nicole`
- Emma (Coral) - `bf_emma`
- Bella (Echo) - `af_bella`
- Sarah (Fable) - `af_sarah`
- George (Onyx) - `bm_george`
- Isabella (Nova) - `bf_isabella`
- Michael (Sage) - `am_michael`
- Sky (Shimmer) - `af_sky`

## Server Requirements

Your local TTS server should:
- Be OpenAI API compatible
- Accept POST requests to `/v1/audio/speech`
- Accept JSON payload in the format:
\\```json
{
  "model": "tts-1",
  "voice": "af_bella",
  "input": "text to speak",
  "speed": 1.0
}
\\```
- Return audio data (mp3/wav)

Default server URL: `http://localhost:8000/v1/audio/speech`

## Development

### Architecture

The extension consists of several key components:
- `manifest.json`: Extension configuration and permissions
- `popup.html`/`popup.js`: Main UI and user interactions
- `background.js`: Service worker handling audio processing and chunking
- `offscreen.js`: Audio playback in background context
- `textProcessor.js`: Intelligent text processing for natural TTS
- `audioPlayer.js`: Audio control abstraction layer

### Testing

This project uses [Jest](https://jestjs.io/) for comprehensive testing, particularly for the text processing functionality that converts markdown to speech-friendly text.

#### Running Tests

```bash
# Install dependencies
npm install

# Run all tests
npm test

# Run tests in watch mode (reruns on file changes)
npm run test:watch

# Run tests with coverage report
npm run test:coverage
```

#### Test Coverage

**Current test coverage: 72 tests passing** across 3 test suites covering:

- **HTML to Markdown Conversion**: Preserving document structure during extraction (23 tests)
- **Text Processing**: Natural speech formatting and cleanup (45 tests)  
- **Integration Testing**: End-to-end pipeline validation (4 tests)

Test areas include:
- **Header Processing**: Converting `# Header` → `Header:` for natural pauses
- **List Processing**: Converting `- Item` → `Item,` for comma separation
- **Structure Preservation**: HTML → Markdown → TTS-friendly text pipeline
- **Comma Cleanup**: Proper punctuation between sections
- **Edge Cases**: Null inputs, empty text, error handling
- **Markdown Processing**: Bold, italic, links, code blocks
- **Symbol Processing**: Converting `$`, `%`, `&` to words
- **Real-World Examples**: GitHub, documentation, and README formats
- **Performance**: Large text handling efficiency

#### Text Processing Architecture

The extension uses a two-stage processing pipeline for optimal TTS results:

1. **HTML to Markdown Conversion** (`HtmlToMarkdown`): 
   - Extracts content while preserving document structure
   - Handles headings, lists, tables, and formatted text
   - Filters out navigation, ads, and non-content elements
   - Converts HTML lists to markdown format to retain meaning

2. **Text Processing** (`TextProcessor`):
   - **Headers**: `## Title` → `Title:` (adds natural pause indicator)
   - **Lists**: `- Item 1\n- Item 2` → `Item 1, Item 2` (comma separation for flow)
   - **Sections**: `## Features\n- Fast\n## Benefits` → `Features: Fast. Benefits:` (proper punctuation)

#### Key Improvement: Structure Preservation

**Before (using `innerText`):**
```
Features
Fast processing
Better accuracy
Improved reliability
```
*Results in choppy, unnatural TTS speech*

**After (using HTML → Markdown → Processing):**
```
Features: Fast processing, Better accuracy, Improved reliability
```
*Results in natural, flowing TTS speech with proper pauses*

This creates significantly more natural speech compared to raw text extraction.

### Making Changes

To modify the extension:
1. Make your changes
2. Run tests: `npm test`
3. Reload the extension in `chrome://extensions/`
4. Click the refresh icon on the extension card

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## License

Distributed under the MIT
