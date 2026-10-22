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

// Determines if a filename is meaningless/generic and needs renaming
function isMeaninglessName(rawBaseName) {
  if (!rawBaseName || typeof rawBaseName !== 'string') return true;
  const base = rawBaseName.trim();

  // Anything under 4 letters
  if (base.length < 4) return true;

  const lower = base.toLowerCase();

  // Camera / phone / scanner presets
  if (/^img[-_]?\d+/i.test(lower)) return true;
  if (/^img[-_]?\d+[-_]?wa\d+/i.test(lower)) return true;
  if (/^dsc[-_]?\d+/i.test(lower)) return true;
  if (/^pxl[-_]?\d+/i.test(lower)) return true;
  if (/^whatsapp\s+(image|video)/i.test(lower)) return true;
  if (/^screen\s*shot/i.test(lower)) return true;
  if (/^screenshot/i.test(lower)) return true;
  if (/^scan[-_]?\d+/i.test(lower)) return true;
  if (lower === 'scan') return true;

  // Generic document / download / copy patterns
  if (/^untitled(\s+document)?(\s*[\(_-]?\d+[\)]?)?$/i.test(lower)) return true;
  if (/^document(\s*[\(_-]?\d+[\)]?)?$/i.test(lower)) return true;
  if (/^download(s)?(\s*[\(_-]?\d+[\)]?)?$/i.test(lower)) return true;
  if (/^file(\s*[\(_-]?\d+[\)]?)?$/i.test(lower)) return true;
  if (/^copy\s+of\s+/i.test(lower)) return true;

  // Long run of digits (e.g. timestamps, sequence numbers)
  if (/^\d{6,}$/.test(base)) return true;
  if (/^[\d-_]{8,}$/.test(base) && !/[a-zA-Z]/.test(base)) return true;

  // Hex or hash-like strings (at least 10 hex characters)
  if (/^[0-9a-fA-F]{10,}$/.test(base)) return true;

  // UUID strings
  if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/i.test(base)) return true;

  // Random alphanumeric string with no vowels or spaces (min length 7)
  if (base.length >= 7 && !/[\saeiouy]/i.test(base)) return true;

  return false;
}

// Determines folder for files whose name is already clear (category + keyword based default)
function assignFolderForClearFile(file) {
  const normalized = file.name.toLowerCase().replace(/[^a-z0-9]+/g, ' ');

  // Keyword-based classification
  if (/\b(receipt|receipts|bill|bills|invoice|invoices|tax|taxes|statement|statements|payment|fee|utility|utilities|payroll)\b/i.test(normalized)) {
    return 'Receipts and Bills';
  }
  if (/\b(ticket|tickets|boarding|flight|flights|hotel|hotels|airbnb|passport|visa|itinerary|trip|travel|vacation)\b/i.test(normalized)) {
    return 'Travel';
  }
  if (/\b(syllabus|lecture|lectures|assignment|assignments|homework|essay|essays|exam|exams|thesis|course|quiz|study|studies|chapter)\b/i.test(normalized)) {
    return 'Study';
  }
  if (/\b(meeting|meetings|contract|contracts|resume|cv|client|clients|project|deck|presentation|roadmap|specs|spec|brief|work)\b/i.test(normalized)) {
    return 'Work';
  }
  if (/\b(screenshot|screenshots|screengrab)\b/i.test(normalized)) {
    return 'Screenshots';
  }
  if (/\b(budget|finances|financial|spreadsheet|spreadsheets|ledger|metrics|dataset|data|inventory)\b/i.test(normalized)) {
    return 'Spreadsheets and Data';
  }
  if (/\b(photo|photos|portrait|selfie|family)\b/i.test(normalized)) {
    return 'Photos';
  }

  // Category fallback
  switch (file.category) {
    case 'spreadsheet':
      return 'Spreadsheets and Data';
    case 'pdf':
    case 'document':
      return 'Documents';
    case 'image':
      return 'Photos';
    case 'archive':
      return 'Documents';
    case 'installer':
      return 'Work';
    default:
      if (['js', 'ts', 'json', 'py', 'go', 'rs', 'c', 'cpp', 'h', 'css', 'html', 'sh', 'yml', 'yaml', 'md'].includes(file.extension)) {
        return 'Work';
      }
      return 'Review';
  }
}

// Generic words that must never comprise the entire suggested name or description
const GENERIC_NAME_WORDS = new Set([
  'pdf',
  'document',
  'documents',
  'file',
  'files',
  'image',
  'images',
  'photo',
  'photos',
  'scene',
  'scenes',
  'portrait',
  'portraits'
]);

// Checks if a candidate name or description consists only of generic words or file extension
function isOnlyGenericWordsOrExtension(name, ext) {
  if (!name || typeof name !== 'string') return true;

  // Strip leading date YYYY-MM-DD or YYYYMMDD or YYYY_MM_DD, and leading screenshot prefix
  let stripped = name
    .toLowerCase()
    .replace(/^\d{4}[-_]?\d{2}[-_]?\d{2}[-_]*/, '')
    .replace(/^screenshot[-_]*/i, '')
    .replace(/^[-_]+|[-_]+$/g, '');

  if (!stripped) return true;

  const tokens = stripped.split(/[-_]+/).filter(Boolean);
  if (tokens.length === 0) return true;

  const extLower = (ext || '').toLowerCase().replace(/^\./, '');

  return tokens.every(
    (token) =>
      GENERIC_NAME_WORDS.has(token) ||
      (extLower && token === extLower) ||
      /^\d+$/.test(token)
  );
}

// Extracts YYYY-MM-DD, YYYY_MM_DD, or YYYYMMDD from filename
function extractDateFromFileName(fileName) {
  if (!fileName || typeof fileName !== 'string') return null;

  // 1. YYYY-MM-DD
  const m1 = fileName.match(/(?:^|[^0-9])(19\d\d|20\d\d)-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(?:[^0-9]|$)/);
  if (m1) {
    return `${m1[1]}-${m1[2]}-${m1[3]}`;
  }

  // 2. YYYY_MM_DD
  const m2 = fileName.match(/(?:^|[^0-9])(19\d\d|20\d\d)_(0[1-9]|1[0-2])_(0[1-9]|[12]\d|3[01])(?:[^0-9]|$)/);
  if (m2) {
    return `${m2[1]}-${m2[2]}-${m2[3]}`;
  }

  // 3. YYYYMMDD (with optional trailing timestamp digits)
  const m3 = fileName.match(/(?:^|[^0-9])(19\d\d|20\d\d)(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?:\d{4}|\d{6})?(?:[^0-9]|$)/);
  if (m3) {
    return `${m3[1]}-${m3[2]}-${m3[3]}`;
  }

  return null;
}

// Converts a Date to YYYY-MM-DD in the system's local timezone (not UTC)
function formatLocalDate(dateObj) {
  const d = dateObj instanceof Date && !isNaN(dateObj.getTime()) ? dateObj : new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Builds target YYYY-MM-DD date: extracted date from filename if present, else local modified date
function extractTargetDate(fileName, modifiedDate) {
  const fromName = extractDateFromFileName(fileName);
  if (fromName) return fromName;

  if (modifiedDate) {
    const d = new Date(modifiedDate);
    if (!isNaN(d.getTime())) {
      return formatLocalDate(d);
    }
  }

  return formatLocalDate(new Date());
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

// Evaluates and caps confidence in code (never trusting model blindly)
function capConfidence({ rawConfidence, isImage, reason, isMeaningless }) {
  const normConf = typeof rawConfidence === 'string' ? rawConfidence.trim().toLowerCase() : 'low';

  if (!isImage) {
    // For non-images, confidence may be "medium" at most, and "low" if the file name is generic
    if (isMeaningless) {
      return 'low';
    }
    return normConf === 'high' || normConf === 'medium' ? 'medium' : 'low';
  }

  // For images, "high" is allowed only if the reason mentions text or an object that is clearly visible
  if (normConf === 'high') {
    const reasonText = (reason || '').toLowerCase();
    const hasVisibleOrText =
      /\b(text|written|words|labeled|titled|sign|headline|reads)\b/i.test(reasonText) ||
      (/\b(visible|clearly|depicts|shows|displays|contains)\b/i.test(reasonText) &&
       /\b(receipt|invoice|bill|document|screenshot|photo|person|group|portrait|car|dog|cat|building|landscape|chart|table|logo|screen|interface|diagram|editor|code|terminal|browser|window|app|website|page)\b/i.test(reasonText));

    if (hasVisibleOrText) {
      return 'high';
    }
    return 'medium';
  }

  if (normConf === 'medium') return 'medium';
  return 'low';
}

// Builds the Ollama prompt for Gemma 3 4B
function buildOllamaPrompt({ fileName, baseName, ext, targetDate, hasImage, isScreenshot }) {
  return `You are a local file organization assistant.
Analyze this file and propose a short, descriptive file name and select an appropriate destination folder.

File Information:
- Current filename: "${fileName}"
- Base name: "${baseName}"
- Extension: "${ext || '(none)'}"
- Date: "${targetDate}"
${
  isScreenshot
    ? '- This file is a SCREENSHOT image.'
    : hasImage
      ? '- An image preview of this file is attached.'
      : '- Non-image file.'
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
1. "new_name": Short descriptive filename WITHOUT extension. Use lowercase words joined by hyphens.
${
  isScreenshot
    ? `Must start with "screenshot-${targetDate}-" followed by a short description of what application, website, code, or interface is visible on screen (example: "screenshot-${targetDate}-code-editor"). NEVER describe a screenshot as a "portrait" or "photo".`
    : `Must start with the date "${targetDate}-" followed by a short description of the subject. Example: "${targetDate}-utility-bill".`
}
2. "folder": ${isScreenshot ? 'Must be "Screenshots".' : 'Must be one of the Allowed Folders listed above.'}
3. Describe ONLY what is visible in the image. Do not invent names, amounts, places, or facts.
4. Image Privacy & Accuracy Rules:
   - Do not identify real people by their face, and do not name actors, celebrities or characters; describe the scene generically.
   - Do not guess brands or places unless the text is visible in the image.
   ${isScreenshot ? '- Never describe a screenshot as a "portrait" or "photo".' : ''}
5. Never produce names made only of the extension or generic words (pdf, document, file, image, photo, scene, portrait).
6. Return ONLY a single JSON object with this exact structure:
{
  "new_name": "${isScreenshot ? `screenshot-${targetDate}-short-description` : `${targetDate}-short-description`}",
  "folder": "${isScreenshot ? 'Screenshots' : 'Photos'}",
  "reason": "One short sentence explaining why.",
  "confidence": "high"
}
Valid confidence values are "high", "medium", or "low".`;
}

// Calls Ollama with one retry if JSON parsing fails
async function getSuggestionFromOllama(file, resolvedFolderPath, { isScreenshot, targetDate }) {
  const originalBase = path.parse(file.name).name;
  const ext = file.extension;
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
    targetDate,
    hasImage: !!base64Image,
    isScreenshot
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
          rawName: isScreenshot ? `screenshot-${targetDate}` : originalBase,
          folder: isScreenshot ? 'Screenshots' : 'Review',
          reason: 'Could not decide',
          confidence: 'low'
        };
      }
    }
  }

  return {
    rawName: isScreenshot ? `screenshot-${targetDate}` : originalBase,
    folder: isScreenshot ? 'Screenshots' : 'Review',
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
    const isImage = file.category === 'image';
    const isMeaningless = isMeaninglessName(originalBase);
    const isScreenshot = /^(screenshot|screen\s*shot)/i.test(originalBase);
    const targetDate = extractTargetDate(file.name, file.modified);

    let candidateBase = '';
    let targetFolder = '';
    let reason = '';
    let confidence = 'medium';
    let nameKept = false;

    if (!isMeaningless) {
      // 1. Name is NOT meaningless: keep original name, do not add date prefix, do not call model for a new name
      candidateBase = originalBase;
      targetFolder = isScreenshot ? 'Screenshots' : assignFolderForClearFile(file);
      reason = 'Name is already clear';
      confidence = 'medium';
      nameKept = true;
    } else if (!isImage) {
      // 2. Non-image files with meaningless names: cannot be understood without reading them,
      // so do not invent a descriptive name: keep the original base name, set folder to "Review"
      // (or "Screenshots" if original name starts with Screenshot), confidence "low", reason "Name is unclear and the content is not read"
      candidateBase = originalBase;
      targetFolder = isScreenshot ? 'Screenshots' : 'Review';
      confidence = 'low';
      reason = 'Name is unclear and the content is not read';
      nameKept = true;
    } else {
      // 3. Meaningless image: call model for suggestions
      const rawSuggestion = await getSuggestionFromOllama(file, job.folder, {
        isScreenshot,
        targetDate
      });

      if (job.cancelled) {
        job.status = 'cancelled';
        break;
      }

      if (isScreenshot) {
        // Screenshot image: force folder to "Screenshots"
        targetFolder = 'Screenshots';

        // Extract short description from model suggestion
        let desc = sanitizeBaseName(rawSuggestion.rawName, '')
          .replace(/^screenshot[-_]*/i, '')
          .replace(/^\d{4}[-_]?\d{2}[-_]?\d{2}[-_]*/, '')
          .replace(/\b(portrait|portraits|photo|photos)\b/gi, '')
          .replace(/-+/g, '-')
          .replace(/^[-_]+|[-_]+$/g, '');

        // Never describe a screenshot as a "portrait" or "photo" in reason
        reason =
          typeof rawSuggestion.reason === 'string' && rawSuggestion.reason.trim()
            ? rawSuggestion.reason
                .trim()
                .replace(/\b(portrait|portraits)\b/gi, 'screenshot')
                .replace(/\b(photo|photos)\b/gi, 'screenshot')
            : 'Screenshot of visible screen';

        // If description is empty or only generic words, try extracting descriptive words from reason
        if (isOnlyGenericWordsOrExtension(desc, file.extension)) {
          const reasonWords = reason
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .split(/\s+/)
            .filter(
              (w) =>
                w.length >= 3 &&
                !GENERIC_NAME_WORDS.has(w) &&
                !['screenshot', 'screenshots', 'screen', 'shows', 'depicts', 'view', 'with', 'that', 'this'].includes(w)
            );
          if (reasonWords.length > 0) {
            desc = reasonWords.slice(0, 3).join('-');
          }
        }

        // If still generic or empty, use 'screen'
        if (isOnlyGenericWordsOrExtension(desc, file.extension)) {
          desc = 'screen';
        }

        candidateBase = `screenshot-${targetDate}-${desc}`.slice(0, 60).replace(/[-_]+$/, '');
        confidence = capConfidence({
          rawConfidence: rawSuggestion.confidence,
          isImage: true,
          reason,
          isMeaningless: true
        });
        nameKept = false;
      } else {
        // Non-screenshot image:
        targetFolder = enforceFolder(rawSuggestion.folder);

        let desc = sanitizeBaseName(rawSuggestion.rawName, '')
          .replace(/^\d{4}[-_]?\d{2}[-_]?\d{2}[-_]*/, '')
          .replace(/^[-_]+|[-_]+$/g, '');

        reason =
          typeof rawSuggestion.reason === 'string' && rawSuggestion.reason.trim()
            ? rawSuggestion.reason.trim()
            : 'Suggested based on image analysis';

        // Never produce names made only of the extension or generic words
        if (isOnlyGenericWordsOrExtension(desc, file.extension)) {
          candidateBase = originalBase;
          targetFolder = 'Review';
          confidence = 'low';
          reason = 'Suggested name was generic';
          nameKept = true;
        } else {
          candidateBase = `${targetDate}-${desc}`.slice(0, 60).replace(/[-_]+$/, '');
          confidence = capConfidence({
            rawConfidence: rawSuggestion.confidence,
            isImage: true,
            reason,
            isMeaningless: true
          });
          nameKept = false;
        }
      }
    }

    // Keep original extension (never from model)
    const extLabel = file.extension ? `.${file.extension}` : '';

    // Enforce uniqueness within the plan by adding -2, -3
    let uniqueBase = candidateBase;
    let candidateName = uniqueBase + extLabel;
    let counter = 2;
    while (usedPlanNames.has(candidateName.toLowerCase())) {
      uniqueBase = `${candidateBase}-${counter}`;
      candidateName = uniqueBase + extLabel;
      counter++;
    }
    usedPlanNames.add(candidateName.toLowerCase());

    job.results.push({
      original_name: file.name,
      extension: file.extension,
      category: file.category,
      suggested_name: candidateName,
      folder: targetFolder,
      reason,
      confidence,
      name_kept: nameKept
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

// In-memory store for apply logs metadata
const applyRecords = new Map();
const APPLIES_INDEX_FILE = path.join(os.tmpdir(), '.sloth-applies-index.json');

async function loadApplyRecords() {
  try {
    if (await pathExists(APPLIES_INDEX_FILE)) {
      const data = JSON.parse(await fs.promises.readFile(APPLIES_INDEX_FILE, 'utf8'));
      if (Array.isArray(data)) {
        for (const item of data) {
          if (item && item.applyId && item.undoLogPath) {
            applyRecords.set(item.applyId, item);
          }
        }
      }
    }
  } catch {}
}

async function saveApplyRecord(record) {
  applyRecords.set(record.applyId, record);
  try {
    await loadApplyRecords();
    applyRecords.set(record.applyId, record);
    const all = Array.from(applyRecords.values());
    await fs.promises.writeFile(APPLIES_INDEX_FILE, JSON.stringify(all, null, 2), 'utf8');
  } catch {}
}

// Helper to check file or directory existence
async function pathExists(p) {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

// Validates output folder with safety rules: absolute, inside home, not system, not hidden, not source or inside source
async function validateOutputFolder(outputFolder, sourceResolved) {
  if (!outputFolder || typeof outputFolder !== 'string' || !outputFolder.trim()) {
    const err = new Error('Please enter an output folder path.');
    err.status = 400;
    throw err;
  }

  const trimmed = outputFolder.trim();

  // Must be an absolute path
  if (!path.isAbsolute(trimmed)) {
    const err = new Error('Output folder must be an absolute path (e.g. /Users/yourname/Desktop/folder-sorted).');
    err.status = 400;
    throw err;
  }

  const normalized = path.resolve(trimmed);

  // Refuse root /
  if (normalized === '/') {
    const err = new Error('Access denied: cannot write to root directory "/".');
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
    if (isSameOrInside(normalized, sysDir)) {
      const err = new Error(`Access denied: cannot write to protected system directory "${sysDir}".`);
      err.status = 400;
      throw err;
    }
  }

  // Refuse anything outside the user's home directory (os.homedir())
  const home = os.homedir();
  if (!isSameOrInside(normalized, home)) {
    const err = new Error(`Access denied: output folder must be inside your home directory (${home}).`);
    err.status = 400;
    throw err;
  }

  // Refuse ~/Library and anything inside it
  const homeLibrary = path.join(home, 'Library');
  if (isSameOrInside(normalized, homeLibrary)) {
    const err = new Error('Access denied: ~/Library is protected.');
    err.status = 400;
    throw err;
  }

  // Refuse hidden directories (any path segment starting with a dot in relative path from home)
  const relFromHome = path.relative(home, normalized);
  if (relFromHome) {
    const segments = relFromHome.split(path.sep);
    if (segments.some((seg) => seg.startsWith('.'))) {
      const err = new Error('Access denied: cannot use hidden folders or paths containing hidden directories.');
      err.status = 400;
      throw err;
    }
  }

  // If path exists, check if it's a directory
  let resolved = normalized;
  try {
    const stat = await fs.promises.stat(normalized);
    if (!stat.isDirectory()) {
      const err = new Error(`Output path exists and is not a directory: ${normalized}`);
      err.status = 400;
      throw err;
    }
    resolved = await fs.promises.realpath(normalized);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      const error = new Error(`Could not inspect output folder: ${err.message}`);
      error.status = 400;
      throw error;
    }
    // Does not exist yet: find nearest existing parent and resolve symlinks
    let curr = path.dirname(normalized);
    while (curr && curr !== path.dirname(curr)) {
      try {
        const pStat = await fs.promises.stat(curr);
        if (pStat.isDirectory()) {
          const pReal = await fs.promises.realpath(curr);
          const rel = path.relative(curr, normalized);
          resolved = path.resolve(pReal, rel);
          break;
        }
      } catch {
        curr = path.dirname(curr);
      }
    }
  }

  // Refuse if same as source folder or inside it
  if (isSameOrInside(resolved, sourceResolved)) {
    const err = new Error('Output folder cannot be the same as or inside the source folder.');
    err.status = 400;
    throw err;
  }

  // Refuse if source folder is inside output folder
  if (isSameOrInside(sourceResolved, resolved)) {
    const err = new Error('Output folder cannot contain the source folder.');
    err.status = 400;
    throw err;
  }

  return resolved;
}

// POST /api/apply - copies approved files into organized output folder (never moves/deletes original files)
app.post('/api/apply', async (req, res) => {
  const startTime = Date.now();
  try {
    const { folder, outputFolder, items } = req.body || {};

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ ok: false, error: 'No items provided to apply.' });
    }

    // 1. Re-validate folder with the same safety checks as /api/scan, and re-scan it on the server
    const scanResult = await validateAndScanFolder(folder);
    const scannedFilesMap = new Map();
    for (const f of scanResult.files) {
      scannedFilesMap.set(f.name, f);
    }

    // 2. Validate output folder
    const defaultOutput = `${scanResult.resolved}-sorted`;
    const targetOutputFolder =
      outputFolder && typeof outputFolder === 'string' && outputFolder.trim()
        ? outputFolder.trim()
        : defaultOutput;

    const validatedOutputFolder = await validateOutputFolder(targetOutputFolder, scanResult.resolved);

    // Ensure output folder directory exists
    await fs.promises.mkdir(validatedOutputFolder, { recursive: true });

    // 3. Cap an apply at 200 files
    const itemsToProcess = items.slice(0, 200);
    const skipped = [];
    if (items.length > 200) {
      for (let i = 200; i < items.length; i++) {
        skipped.push({
          name: items[i]?.original_name || `item-${i + 1}`,
          reason: 'Apply limit reached (capped at 200 files per apply)'
        });
      }
    }

    const copiedEntries = [];
    const createdSubfolders = new Set();
    const usedDestPaths = new Set();

    for (const item of itemsToProcess) {
      const origName = item?.original_name;
      if (!origName || typeof origName !== 'string') {
        skipped.push({ name: String(origName || 'unknown'), reason: 'Missing original filename' });
        continue;
      }

      // Check if found in server scan
      const scannedFile = scannedFilesMap.get(origName);
      if (!scannedFile) {
        skipped.push({ name: origName, reason: 'File not found in folder scan' });
        continue;
      }

      // Source path - strictly constructed on the server
      const sourcePath = path.join(scanResult.resolved, origName);

      // Check with lstat (must be regular file, not a symlink)
      let lstat;
      try {
        lstat = await fs.promises.lstat(sourcePath);
      } catch (err) {
        skipped.push({ name: origName, reason: `Could not inspect file: ${err.message}` });
        continue;
      }

      if (lstat.isSymbolicLink() || !lstat.isFile()) {
        skipped.push({ name: origName, reason: 'Not a regular file or is a symlink' });
        continue;
      }

      // Check if original's size or modified time changed since scan
      if (lstat.size !== scannedFile.size || lstat.mtime.toISOString() !== scannedFile.modified) {
        skipped.push({ name: origName, reason: 'File size or modified time changed since scan' });
        continue;
      }

      // Re-sanitise folder
      const targetFolder = enforceFolder(item.folder);
      const subFolderDir = path.join(validatedOutputFolder, targetFolder);

      // Re-sanitise suggested_name: lowercase [a-z0-9_-], keep ORIGINAL extension
      const originalExt = scannedFile.extension;
      const rawSuggested = item.suggested_name;
      const parsedSuggested = typeof rawSuggested === 'string' ? path.parse(rawSuggested).name : '';
      const baseName = sanitizeBaseName(parsedSuggested, path.parse(origName).name);
      const extLabel = originalExt ? `.${originalExt}` : '';

      // Create sub-folder if needed
      await fs.promises.mkdir(subFolderDir, { recursive: true });
      createdSubfolders.add(subFolderDir);

      // Find an available filename in destination (never overwrite, add -2, -3)
      let uniqueBase = baseName;
      let candidateFileName = uniqueBase + extLabel;
      let destPath = path.join(subFolderDir, candidateFileName);
      let counter = 2;

      while (usedDestPaths.has(destPath.toLowerCase()) || (await pathExists(destPath))) {
        uniqueBase = `${baseName}-${counter}`;
        candidateFileName = uniqueBase + extLabel;
        destPath = path.join(subFolderDir, candidateFileName);
        counter++;
      }
      usedDestPaths.add(destPath.toLowerCase());

      // Copy with COPYFILE_EXCL flag (never overwrite)
      try {
        await fs.promises.copyFile(sourcePath, destPath, fs.constants.COPYFILE_EXCL);
      } catch (err) {
        skipped.push({ name: origName, reason: `Copy failed: ${err.message}` });
        continue;
      }

      // Verify copy size equals original's size
      try {
        const copyStat = await fs.promises.stat(destPath);
        if (copyStat.size !== lstat.size) {
          // Remove defective copy
          await fs.promises.unlink(destPath).catch(() => {});
          skipped.push({ name: origName, reason: 'Copy verification failed: file size mismatch' });
          continue;
        }

        // Set copy's modified time to original's with utimes
        await fs.promises.utimes(destPath, lstat.atime, lstat.mtime);

        copiedEntries.push({
          source: sourcePath,
          destination: destPath,
          size: lstat.size,
          folder: targetFolder
        });
      } catch (err) {
        await fs.promises.unlink(destPath).catch(() => {});
        skipped.push({ name: origName, reason: `Post-copy verification failed: ${err.message}` });
        continue;
      }
    }

    // Write undo log to <outputFolder>/.sloth-undo-<timestamp>.json
    const timestamp = Date.now();
    const applyId = `${timestamp}-${crypto.randomUUID().slice(0, 8)}`;
    const undoLogName = `.sloth-undo-${timestamp}.json`;
    const undoLogPath = path.join(validatedOutputFolder, undoLogName);

    const undoLogData = {
      applyId,
      timestamp,
      sourceFolder: scanResult.resolved,
      outputFolder: validatedOutputFolder,
      copies: copiedEntries.map((c) => ({
        source: c.source,
        destination: c.destination,
        size: c.size,
        source_path: c.source,
        destination_path: c.destination
      })),
      createdSubfolders: Array.from(createdSubfolders)
    };

    await fs.promises.writeFile(undoLogPath, JSON.stringify(undoLogData, null, 2), 'utf8');

    // Store in memory and persistent index for reliable undo lookup
    await saveApplyRecord({
      applyId,
      undoLogPath,
      outputFolder: validatedOutputFolder,
      timestamp
    });

    const elapsedSeconds = parseFloat(((Date.now() - startTime) / 1000).toFixed(2));

    return res.json({
      ok: true,
      applyId,
      copied: copiedEntries.length,
      skipped,
      outputFolder: validatedOutputFolder,
      seconds: elapsedSeconds
    });
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).json({
      ok: false,
      error: err.message || 'Failed to apply file organization.'
    });
  }
});

// POST /api/undo - reads undo log and removes destination copies (never touches source files)
app.post('/api/undo', async (req, res) => {
  try {
    const { applyId, outputFolder } = req.body || {};
    if (!applyId || typeof applyId !== 'string') {
      return res.status(400).json({ ok: false, error: 'applyId is required.' });
    }

    let undoLogPath = null;
    let targetOutputFolder = null;

    // 1. Check in-memory record, or reload from persistent index
    let record = applyRecords.get(applyId.trim());
    if (!record) {
      await loadApplyRecords();
      record = applyRecords.get(applyId.trim());
    }

    if (record) {
      undoLogPath = record.undoLogPath;
      targetOutputFolder = record.outputFolder;
    } else if (outputFolder && typeof outputFolder === 'string') {
      // If specified output folder, search in that folder
      const home = os.homedir();
      const norm = path.resolve(outputFolder.trim());
      if (isSameOrInside(norm, home)) {
        const files = await fs.promises.readdir(norm).catch(() => []);
        for (const f of files) {
          if (f.startsWith('.sloth-undo-') && f.endsWith('.json')) {
            const fullP = path.join(norm, f);
            try {
              const content = JSON.parse(await fs.promises.readFile(fullP, 'utf8'));
              if (content.applyId === applyId.trim()) {
                undoLogPath = fullP;
                targetOutputFolder = norm;
                break;
              }
            } catch {}
          }
        }
      }
    } else if (applyId.endsWith('.json') || path.isAbsolute(applyId)) {
      const candidate = path.resolve(applyId);
      if (await pathExists(candidate)) {
        undoLogPath = candidate;
        targetOutputFolder = path.dirname(candidate);
      }
    }

    if (!undoLogPath || !(await pathExists(undoLogPath))) {
      return res.status(404).json({ ok: false, error: 'Undo log not found for this apply ID.' });
    }

    // Read and parse undo log
    let logData;
    try {
      const content = await fs.promises.readFile(undoLogPath, 'utf8');
      logData = JSON.parse(content);
    } catch (err) {
      return res.status(500).json({ ok: false, error: `Could not read undo log: ${err.message}` });
    }

    // Validate output folder where log was read
    const home = os.homedir();
    const validatedOutputFolder = await fs.promises.realpath(targetOutputFolder || path.dirname(undoLogPath));
    if (!isSameOrInside(validatedOutputFolder, home)) {
      return res.status(403).json({ ok: false, error: 'Access denied: output folder is outside home directory.' });
    }

    let removed = 0;
    const skipped = [];
    const copies = Array.isArray(logData.copies) ? logData.copies : [];

    // Delete destination copy ONLY if it still exists and its size matches the log
    for (const entry of copies) {
      const destPath = entry.destination || entry.destination_path;
      const srcPath = entry.source || entry.source_path;
      const fileName = path.basename(destPath);

      // Must be inside validated output folder (never touch source files or files outside output folder)
      if (!isSameOrInside(destPath, validatedOutputFolder)) {
        skipped.push({ name: fileName, reason: 'Destination path outside output folder' });
        continue;
      }

      // Safeguard: Never touch source files!
      if (srcPath && path.resolve(destPath) === path.resolve(srcPath)) {
        skipped.push({ name: fileName, reason: 'Refused: cannot delete source file' });
        continue;
      }

      try {
        const stat = await fs.promises.stat(destPath);
        if (stat.size !== entry.size) {
          skipped.push({ name: fileName, reason: 'File size has changed since copy' });
          continue;
        }

        await fs.promises.unlink(destPath);
        removed++;
      } catch (err) {
        if (err.code === 'ENOENT') {
          skipped.push({ name: fileName, reason: 'File no longer exists' });
        } else {
          skipped.push({ name: fileName, reason: err.message });
        }
      }
    }

    // Remove any sub-folder that this tool created and that is now empty
    const subfoldersToCheck = Array.isArray(logData.createdSubfolders)
      ? logData.createdSubfolders
      : Array.from(new Set(copies.map((c) => path.dirname(c.destination || c.destination_path))));

    for (const subDir of subfoldersToCheck) {
      if (isSameOrInside(subDir, validatedOutputFolder) && subDir !== validatedOutputFolder) {
        try {
          const contents = await fs.promises.readdir(subDir);
          if (contents.length === 0) {
            await fs.promises.rmdir(subDir);
          }
        } catch {
          // Ignore if directory doesn't exist or is not empty
        }
      }
    }

    // Delete the undo log itself
    await fs.promises.unlink(undoLogPath).catch(() => {});
    applyRecords.delete(applyId.trim());
    try {
      const all = Array.from(applyRecords.values());
      await fs.promises.writeFile(APPLIES_INDEX_FILE, JSON.stringify(all, null, 2), 'utf8');
    } catch {}

    return res.json({
      ok: true,
      removed,
      skipped
    });
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).json({
      ok: false,
      error: err.message || 'Failed to undo file organization.'
    });
  }
});

// Periodically clean up old jobs older than 1 hour
setInterval(() => {
  const oneHourAgo = Date.now() - 3600000;
  for (const [id, job] of proposeJobs.entries()) {
    if (job.createdAt < oneHourAgo) {
      proposeJobs.delete(id);
    }
  }
  for (const [id, rec] of applyRecords.entries()) {
    if (rec.timestamp < oneHourAgo) {
      applyRecords.delete(id);
    }
  }
}, 600000);

// Explicitly bind to 127.0.0.1 for local security
app.listen(PORT, HOST, () => {
  console.log(`DownloadsSloth listening on http://${HOST}:${PORT}`);
});
