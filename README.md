# DownloadsSloth 🦥

> Tidy a messy folder without lifting a finger. Runs on your own computer.

DownloadsSloth is a local-first tool that organizes cluttered folders by suggesting clear file names and sensible directory structures. It runs entirely on your machine using Ollama with the `gemma3:4b` model—no cloud calls, no external telemetry, and no build step.

---

## Prerequisites

1. **Node.js** (v18 or newer)
2. **Ollama** installed and running locally:
   ```bash
   # Ensure Ollama is running, then pull the model:
   ollama pull gemma3:4b
   ```

## Setup & Running

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Start the server**:
   ```bash
   npm start
   ```

3. **Open DownloadsSloth**:
   Visit [http://127.0.0.1:3000](http://127.0.0.1:3000) in your browser.

---

## Health Check API

The server provides a health check endpoint:

```
GET /api/health
```

- Verifies that Ollama is active at `http://127.0.0.1:11434`.
- Confirms that the `gemma3:4b` model is downloaded and ready.
- Returns JSON status and clear error diagnostics if Ollama is offline or the model is missing.

---

## Security & Privacy

DownloadsSloth binds strictly to `127.0.0.1` and will never transmit your folder contents or files over the internet.
