const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const util = require('util');

const execFilePromise = util.promisify(execFile);

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = '127.0.0.1';
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
const REQUIRED_MODEL = 'gemma3:4b';
const MAX_SCAN_FILES = 200;

// Allowed folder categories for AI suggestions
const ALLOWED_FOLDERS = [
  'Screenshots',
  'Photos',
  'Receipts and Bills',
  'Documents',
  'Study',
  'Work',
  'Spreadsheets and Data',
  'Travel',
  'Review'
];

// In-memory store for background proposal jobs
const proposeJobs = new Map();

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

// Shared path validation and top-level directory scanning
async function validateAndScanFolder(folder) {
  if (!folder || typeof folder !== 'string' || !folder.trim()) {
    const err = new Error('Please enter a folder path.');
    err.status = 400;
    throw err;
  }

  const trimmed = folder.trim();

  // Must be an absolute path
  if (!path.isAbsolute(trimmed)) {
    const err = new Error('Folder path must be an absolute path (e.g. /Users/yourname/Desktop/folder).');
    err.status = 400;
    throw err;
  }

  // Resolve realpath to resolve any symlinks in the folder path
  let resolved;
  try {
    resolved = await fs.promises.realpath(trimmed);
  } catch {
    const err = new Error(`Folder does not exist: ${trimmed}`);
    err.status = 400;
    throw err;
  }

  // Must be a directory
  try {
    const dirStat = await fs.promises.stat(resolved);
    if (!dirStat.isDirectory()) {
      const err = new Error(`Path is not a directory: ${trimmed}`);
      err.status = 400;
      throw err;
    }
  } catch (err) {
    const error = new Error(`Could not inspect folder: ${err.message}`);
    error.status = 400;
    throw error;
  }

  // Refuse root /
  if (resolved === '/') {
    const err = new Error('Access denied: cannot scan root directory "/".');
    err.status = 400;
    throw err;
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
      const err = new Error(`Access denied: cannot scan protected system directory "${sysDir}".`);
      err.status = 400;
      throw err;
    }
  }

  // Refuse anything outside the user's home directory (os.homedir())
  const home = os.homedir();
  if (!isSameOrInside(resolved, home)) {
    const err = new Error(`Access denied: folder must be inside your home directory (${home}).`);
    err.status = 400;
    throw err;
  }

  // Refuse ~/Library and anything inside it
  const homeLibrary = path.join(home, 'Library');
  if (isSameOrInside(resolved, homeLibrary)) {
    const err = new Error('Access denied: ~/Library is protected.');
    err.status = 400;
    throw err;
  }

  // Refuse the home directory's own hidden folders (names starting with a dot)
  const relFromHome = path.relative(home, resolved);
  if (relFromHome) {
    const segments = relFromHome.split(path.sep);
    if (segments.some((seg) => seg.startsWith('.'))) {
      const err = new Error('Access denied: cannot scan hidden folders or their contents.');
      err.status = 400;
      throw err;
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
    } catch {
      continue;
    }
  }

  return {
    resolved,
    files,
    summary: {
      totalFiles: files.length,
      totalFound: totalEligible,
      capped,
      skippedCount,
      totalBytes,
      categories: categoriesCount
    }
  };
}

// Sanitizes base filename to: lowercase, [a-z0-9_-], no slashes/dots, max 60 chars, never empty
function sanitizeBaseName(rawName, fallbackBaseName) {
  if (typeof rawName !== 'string') rawName = '';

  let clean = rawName.toLowerCase();
  // Strip any trailing file extension the model might have appended
  clean = clean.replace(/\.[a-z0-9]+$/i, '');
  // Replace slashes, dots, whitespace, and invalid characters with hyphens
  clean = clean.replace(/[^a-z0-9_-]/g, '-');
  // Collapse consecutive hyphens/underscores and trim ends
  clean = clean.replace(/-+/g, '-').replace(/^[-_]+|[-_]+$/g, '');
  // Limit to 60 characters
  if (clean.length > 60) {
    clean = clean.slice(0, 60).replace(/[-_]+$/, '');
  }

  // Fallback if empty
  if (!clean) {
    clean = (fallbackBaseName || '')
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[-_]+|[-_]+$/g, '')
      .slice(0, 60);
    if (!clean) clean = 'file';
  }

  return clean;
}

// Enforces folder to one of the fixed allowed names, defaulting to 'Review'
function enforceFolder(rawFolder) {
  if (typeof rawFolder !== 'string') return 'Review';
  const trimmed = rawFolder.trim();
  const matched = ALLOWED_FOLDERS.find(
    (folder) => folder.toLowerCase() === trimmed.toLowerCase()
  );
  return matched || 'Review';
}

// Enforces confidence to 'high', 'medium', or 'low'
function enforceConfidence(rawConfidence) {
  if (typeof rawConfidence !== 'string') return 'low';
  const val = rawConfidence.trim().toLowerCase();
  if (val === 'high' || val === 'medium' || val === 'low') {
    return val;
  }
  return 'low';
}

// Builds the Ollama prompt for Gemma 3 4B
function buildOllamaPrompt({ fileName, baseName, ext, modifiedDate, hasImage }) {
  const dateStr = modifiedDate
    ? modifiedDate.split('T')[0]
    : new Date().toISOString().split('T')[0];

  return `You are a local file organization assistant.
Analyze this file and propose a short, descriptive file name and select an appropriate destination folder.

File Information:
- Current filename: "${fileName}"
- Base name: "${baseName}"
- Extension: "${ext || '(none)'}"
- Modified date: "${dateStr}"
${
  hasImage
    ? '- An image preview of this file is attached.'
    : '- Non-image file: analyze ONLY the file name, extension, and modified date. Do NOT read or invent unseen contents.'
}

Allowed Folders (choose exactly ONE from this list):
- Screenshots
- Photos
- Receipts and Bills
- Documents
- Study
- Work
- Spreadsheets and Data
- Travel
- Review

Rules:
1. "new_name": Short descriptive filename WITHOUT extension. Use lowercase words joined by hyphens. Must start with a date in YYYY-MM-DD format (use the date visible in the image if there is one, otherwise use "${dateStr}"). Example: "2026-10-21-utility-bill".
2. "folder": Must be one of the Allowed Folders listed above.
3. Describe ONLY what is visible in the image or implied by the file name. Do not invent names, amounts, places, or facts.
4. If you cannot tell what a file is, keep the original base name "${baseName}", set folder to "Review", and confidence to "low".
5. Return ONLY a single JSON object with this exact structure:
{
  "new_name": "YYYY-MM-DD-short-description",
  "folder": "Documents",
  "reason": "One short sentence explaining why.",
  "confidence": "high"
}
Valid confidence values are "high", "medium", or "low".`;
}

// Calls Ollama with one retry if JSON parsing fails
async function getSuggestionFromOllama(file, resolvedFolderPath) {
  const originalBase = path.parse(file.name).name;
  const ext = file.extension;
  const modifiedDate = file.modified;
  const isImage = file.category === 'image';

  let base64Image = null;
  let tempImagePath = null;

  if (isImage) {
    try {
      const fullPath = path.join(resolvedFolderPath, file.name);
      tempImagePath = path.join(
        os.tmpdir(),
        `sloth-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`
      );
      // Downscale with macOS sips tool (longest side 768px)
      await execFilePromise('sips', [
        '-s',
        'format',
        'jpeg',
        '-Z',
        '768',
        fullPath,
        '--out',
        tempImagePath
      ]);
      const imageBuffer = await fs.promises.readFile(tempImagePath);
      base64Image = imageBuffer.toString('base64');
    } catch {
      // Fall back to name-only analysis if sips fails
      base64Image = null;
    } finally {
      if (tempImagePath) {
        fs.promises.unlink(tempImagePath).catch(() => {});
      }
    }
  }

  const prompt = buildOllamaPrompt({
    fileName: file.name,
    baseName: originalBase,
    ext,
    modifiedDate,
    hasImage: !!base64Image
  });

  // Attempt up to 2 times (initial attempt + 1 retry on invalid JSON)
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const payload = {
        model: REQUIRED_MODEL,
        prompt,
        stream: false,
        format: 'json',
        options: {
          temperature: 0.3
        }
      };

      if (base64Image) {
        payload.images = [base64Image];
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000);

      const res = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (!res.ok) {
        throw new Error(`Ollama returned status ${res.status}`);
      }

      const data = await res.json();
      const parsed = JSON.parse(data.response);

      if (parsed && typeof parsed === 'object') {
        return {
          rawName: parsed.new_name,
          folder: parsed.folder,
          reason: parsed.reason,
          confidence: parsed.confidence
        };
      }
    } catch {
      if (attempt === 2) {
        return {
          rawName: originalBase,
          folder: 'Review',
          reason: 'Could not decide',
          confidence: 'low'
        };
      }
    }
  }

  return {
    rawName: originalBase,
    folder: 'Review',
    reason: 'Could not decide',
    confidence: 'low'
  };
}

// Background worker to process proposal files one by one
async function processProposeJob(job, filesToProcess) {
  const usedPlanNames = new Set();

  for (let i = 0; i < filesToProcess.length; i++) {
    if (job.cancelled) {
      job.status = 'cancelled';
      break;
    }

    const file = filesToProcess[i];
    job.currentFile = file.name;

    const originalBase = path.parse(file.name).name;
    const rawSuggestion = await getSuggestionFromOllama(file, job.folder);

    if (job.cancelled) {
      job.status = 'cancelled';
      break;
    }

    const sanitizedBase = sanitizeBaseName(rawSuggestion.rawName, originalBase);
    const enforcedFolder = enforceFolder(rawSuggestion.folder);
    const enforcedConfidence = enforceConfidence(rawSuggestion.confidence);
    const reason =
      typeof rawSuggestion.reason === 'string' && rawSuggestion.reason.trim()
        ? rawSuggestion.reason.trim()
        : enforcedConfidence === 'low'
        ? 'Could not decide'
        : 'Suggested based on file analysis';

    // Keep original extension (never from model)
    const extLabel = file.extension ? `.${file.extension}` : '';

    // Enforce uniqueness within the plan by adding -2, -3
    let candidateBase = sanitizedBase;
    let candidateName = candidateBase + extLabel;
    let counter = 2;
    while (usedPlanNames.has(candidateName.toLowerCase())) {
      candidateBase = `${sanitizedBase}-${counter}`;
      candidateName = candidateBase + extLabel;
      counter++;
    }
    usedPlanNames.add(candidateName.toLowerCase());

    job.results.push({
      original_name: file.name,
      extension: file.extension,
      category: file.category,
      suggested_name: candidateName,
      folder: enforcedFolder,
      reason,
      confidence: enforcedConfidence
    });

    job.done = i + 1;
  }

  if (!job.cancelled) {
    job.status = 'done';
    job.currentFile = '';
  }
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
    const result = await validateAndScanFolder(folder);
    return res.json({
      ok: true,
      folder: result.resolved,
      files: result.files,
      summary: result.summary
    });
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).json({
      ok: false,
      error: err.message || 'Failed to scan folder.'
    });
  }
});

// Start AI proposal job (read-only suggestions)
app.post('/api/propose', async (req, res) => {
  try {
    const { folder, limit = 12 } = req.body || {};
    const clampedLimit = Math.min(60, Math.max(1, parseInt(limit, 10) || 12));

    // Re-validate and re-scan folder directly on the server
    const scanResult = await validateAndScanFolder(folder);
    const filesToPropose = scanResult.files.slice(0, clampedLimit);

    const jobId = crypto.randomUUID();
    const job = {
      id: jobId,
      status: 'running',
      folder: scanResult.resolved,
      done: 0,
      total: filesToPropose.length,
      currentFile: filesToPropose[0]?.name || '',
      results: [],
      cancelled: false,
      error: null,
      createdAt: Date.now()
    };

    proposeJobs.set(jobId, job);

    // Process files asynchronously in background
    processProposeJob(job, filesToPropose).catch((err) => {
      job.status = 'error';
      job.error = err.message;
    });

    return res.json({ ok: true, jobId });
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).json({
      ok: false,
      error: err.message || 'Failed to start proposal job.'
    });
  }
});

// Check progress of an AI proposal job
app.get('/api/propose/:jobId', (req, res) => {
  const job = proposeJobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ ok: false, error: 'Proposal job not found.' });
  }

  return res.json({
    ok: true,
    status: job.status,
    done: job.done,
    total: job.total,
    currentFile: job.currentFile,
    results: job.results,
    error: job.error
  });
});

// Cancel a running AI proposal job
app.post('/api/propose/:jobId/cancel', (req, res) => {
  const job = proposeJobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ ok: false, error: 'Proposal job not found.' });
  }

  job.cancelled = true;
  job.status = 'cancelled';
  return res.json({ ok: true, message: 'Proposal job cancelled.' });
});

// Periodically clean up old jobs older than 1 hour
setInterval(() => {
  const oneHourAgo = Date.now() - 3600000;
  for (const [id, job] of proposeJobs.entries()) {
    if (job.createdAt < oneHourAgo) {
      proposeJobs.delete(id);
    }
  }
}, 600000);

// Explicitly bind to 127.0.0.1 for local security
app.listen(PORT, HOST, () => {
  console.log(`DownloadsSloth listening on http://${HOST}:${PORT}`);
});
