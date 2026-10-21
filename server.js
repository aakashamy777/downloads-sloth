const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = '127.0.0.1';
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
const REQUIRED_MODEL = 'gemma3:4b';
const MAX_SCAN_FILES = 200;

// Category mapping helper
function getFileCategory(ext) {
  const images = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic'];
  const documents = ['doc', 'docx', 'txt', 'md', 'rtf', 'odt', 'pages'];
  const spreadsheets = ['xls', 'xlsx', 'csv', 'numbers'];
  const archives = ['zip', 'rar', '7z', 'tar', 'gz'];
  const installers = ['dmg', 'pkg', 'exe'];

  if (images.includes(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (documents.includes(ext)) return 'document';
  if (spreadsheets.includes(ext)) return 'spreadsheet';
  if (archives.includes(ext)) return 'archive';
  if (installers.includes(ext)) return 'installer';
  return 'other';
}

// Checks if target is identical to or within parent directory
function isSameOrInside(target, parent) {
  if (target === parent) return true;
  const parentWithSep = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return target.startsWith(parentWithSep);
}

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

// Read-only folder scan endpoint
app.post('/api/scan', async (req, res) => {
  try {
    const { folder } = req.body || {};

    if (!folder || typeof folder !== 'string' || !folder.trim()) {
      return res.status(400).json({
        ok: false,
        error: 'Please enter a folder path.'
      });
    }

    const trimmed = folder.trim();

    // Must be an absolute path
    if (!path.isAbsolute(trimmed)) {
      return res.status(400).json({
        ok: false,
        error: 'Folder path must be an absolute path (e.g. /Users/yourname/Desktop/folder).'
      });
    }

    // Resolve realpath to resolve any symlinks in the folder path
    let resolved;
    try {
      resolved = await fs.promises.realpath(trimmed);
    } catch (err) {
      return res.status(400).json({
        ok: false,
        error: `Folder does not exist: ${trimmed}`
      });
    }

    // Must be a directory
    try {
      const dirStat = await fs.promises.stat(resolved);
      if (!dirStat.isDirectory()) {
        return res.status(400).json({
          ok: false,
          error: `Path is not a directory: ${trimmed}`
        });
      }
    } catch (err) {
      return res.status(400).json({
        ok: false,
        error: `Could not inspect folder: ${err.message}`
      });
    }

    // Refuse root /
    if (resolved === '/') {
      return res.status(400).json({
        ok: false,
        error: 'Access denied: cannot scan root directory "/".'
      });
    }

    // Refuse protected system directories: /System, /Library, /usr, /bin, /sbin, /etc, /var, /private, /Applications
    const FORBIDDEN_ROOTS = [
      '/System',
      '/Library',
      '/usr',
      '/bin',
      '/sbin',
      '/etc',
      '/var',
      '/private',
      '/Applications'
    ];

    for (const sysDir of FORBIDDEN_ROOTS) {
      if (isSameOrInside(resolved, sysDir)) {
        return res.status(400).json({
          ok: false,
          error: `Access denied: cannot scan protected system directory "${sysDir}".`
        });
      }
    }

    // Refuse anything outside the user's home directory (os.homedir())
    const home = os.homedir();
    if (!isSameOrInside(resolved, home)) {
      return res.status(400).json({
        ok: false,
        error: `Access denied: folder must be inside your home directory (${home}).`
      });
    }

    // Refuse ~/Library and anything inside it
    const homeLibrary = path.join(home, 'Library');
    if (isSameOrInside(resolved, homeLibrary)) {
      return res.status(400).json({
        ok: false,
        error: 'Access denied: ~/Library is protected.'
      });
    }

    // Refuse the home directory's own hidden folders (names starting with a dot)
    const relFromHome = path.relative(home, resolved);
    if (relFromHome) {
      const segments = relFromHome.split(path.sep);
      if (segments.some((seg) => seg.startsWith('.'))) {
        return res.status(400).json({
          ok: false,
          error: 'Access denied: cannot scan hidden folders or their contents.'
        });
      }
    }

    // List only the top level of the folder (not recursive)
    const entries = await fs.promises.readdir(resolved, { withFileTypes: true });

    // Skip hidden files, directories, and symlinks. Keep regular files only.
    const eligibleEntries = entries.filter((entry) => {
      if (entry.name.startsWith('.')) return false;
      if (entry.isSymbolicLink()) return false;
      if (entry.isDirectory()) return false;
      return entry.isFile();
    });

    const totalEligible = eligibleEntries.length;
    const filesToProcess = eligibleEntries.slice(0, MAX_SCAN_FILES);
    const skippedCount = Math.max(0, totalEligible - MAX_SCAN_FILES);
    const capped = skippedCount > 0;

    const files = [];
    const categoriesCount = {
      image: 0,
      pdf: 0,
      document: 0,
      spreadsheet: 0,
      archive: 0,
      installer: 0,
      other: 0
    };
    let totalBytes = 0;

    for (const entry of filesToProcess) {
      try {
        const filePath = path.join(resolved, entry.name);
        const stat = await fs.promises.stat(filePath);
        const ext = path.extname(entry.name).toLowerCase().replace(/^\./, '');
        const category = getFileCategory(ext);

        categoriesCount[category] = (categoriesCount[category] || 0) + 1;
        totalBytes += stat.size;

        files.push({
          name: entry.name,
          extension: ext,
          category,
          size: stat.size,
          modified: stat.mtime.toISOString()
        });
      } catch (err) {
        // Skip unreadable files
        continue;
      }
    }

    return res.json({
      ok: true,
      folder: resolved,
      files,
      summary: {
        totalFiles: files.length,
        totalFound: totalEligible,
        capped,
        skippedCount,
        totalBytes,
        categories: categoriesCount
      }
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: `Failed to scan folder: ${err.message}`
    });
  }
});

// Explicitly bind to 127.0.0.1 for local security
app.listen(PORT, HOST, () => {
  console.log(`DownloadsSloth listening on http://${HOST}:${PORT}`);
});
