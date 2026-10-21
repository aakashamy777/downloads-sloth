const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = '127.0.0.1';
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
const REQUIRED_MODEL = 'gemma3:4b';

// Parse JSON bodies up to 20MB
app.use(express.json({ limit: '20mb' }));

// Serve static frontend assets
app.use(express.static(path.join(__dirname, 'public')));

// Health check endpoint - verifies Ollama and the required local model
app.get('/api/health', async (req, res) => {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);

    const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!response.ok) {
      return res.status(502).json({
        ok: false,
        error: `Ollama returned HTTP status ${response.status}`,
        code: 'OLLAMA_HTTP_ERROR'
      });
    }

    const data = await response.json();
    const models = Array.isArray(data.models) ? data.models : [];
    
    // Check if gemma3:4b or gemma3:4b:* is installed
    const hasModel = models.some((m) => {
      const name = (m.name || m.model || '').toLowerCase();
      return (
        name === REQUIRED_MODEL ||
        name === `${REQUIRED_MODEL}:latest` ||
        name.startsWith(`${REQUIRED_MODEL}:`)
      );
    });

    if (!hasModel) {
      return res.status(404).json({
        ok: false,
        error: `Model '${REQUIRED_MODEL}' not found in Ollama. Run: ollama pull ${REQUIRED_MODEL}`,
        code: 'MODEL_NOT_FOUND',
        requiredModel: REQUIRED_MODEL,
        installedModels: models.map((m) => m.name || m.model)
      });
    }

    return res.json({
      ok: true,
      status: 'ready',
      message: `Local model ready: ${REQUIRED_MODEL}`,
      model: REQUIRED_MODEL,
      ollamaUrl: OLLAMA_BASE_URL
    });
  } catch (err) {
    return res.status(503).json({
      ok: false,
      error: `Ollama is not running at ${OLLAMA_BASE_URL}. Please start Ollama.`,
      code: 'OLLAMA_UNAVAILABLE',
      details: err.message
    });
  }
});

// Explicitly bind to 127.0.0.1 for local security
app.listen(PORT, HOST, () => {
  console.log(`DownloadsSloth listening on http://${HOST}:${PORT}`);
});
