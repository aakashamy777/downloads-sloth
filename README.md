# DownloadsSloth

## What it is
DownloadsSloth is a local folder organizer that runs on your computer and helps tidy messy folders like Downloads or Desktop. It uses an open-weight local vision-language model (Gemma 3 4B via Ollama) to inspect messy filenames and image contents, proposes clear file names and categorized folders in a review table, and lets you safely copy approved items into an organized output directory with full undo capability.

## The problem
Most people have folders packed with hundreds of files named `IMG_1234.jpg`, `Screenshot 2026-03-01 at 10.30.00.png`, `doc.pdf`, `scan0003.pdf`, and `download (2).jpg`. Sorting them manually is tedious: you have to open each file, figure out what it is, invent a sensible date and descriptive name, create category folders, and drag files one by one. Because it takes too much time, messy folders stay unsorted.

## How it works
1. **Scan**: You provide an absolute path to a folder within your home directory. DownloadsSloth performs a top-level, read-only scan of regular files and displays file names, categories, sizes, and timestamps.
2. **Gemma 3 4B suggestions**: The tool runs local inference using Ollama. For images, it generates downscaled previews and asks the model to describe what is visible. For files whose names are already clear, it retains the original base name and only assigns a category folder. For non-image files with meaningless names, it assigns a folder like Review without inventing unverified names.
3. **Review**: The browser UI presents an editable preview table. High and medium confidence items are checked by default; low confidence items are unchecked. You can edit any suggested base name, switch target folders via dropdowns, and toggle file selections with "Select all" / "Select none".
4. **Copy**: Clicking apply copies only the checked files into a separate output folder (defaulting to `<source-folder>-sorted`). Subfolders are created as needed, collisions are avoided by appending `-2` or `-3`, timestamps are synchronized, and an undo log is recorded. Original files remain completely untouched.
5. **Undo**: Clicking "Undo this" reads the output folder's undo log, verifies that destination copy sizes match, removes the copies, cleans up empty subfolders created during apply, and deletes the log.

## Safety rules
- **Read-only scan**: Scanning only reads file metadata and generates temporary downscaled previews for image analysis.
- **Home directory only**: The server refuses root `/`, system folders (`/System`, `/Library`, `/usr`, `/Applications`, etc.), hidden directories, and anything outside your home directory.
- **Never touches originals**: DownloadsSloth never moves, renames, overwrites, or deletes your original files. It only copies files into a separate output directory.
- **Safe copy destination**: The output directory cannot be the same as or nested inside the source folder.
- **Strict undo scope**: Undo only deletes destination copies whose path and file size match the undo log. It will never touch a source file.
- **Code-level enforcement**: Suggested names are sanitized in code (lowercase `a-z`, `0-9`, hyphen, underscore, with the original file extension always preserved). Folder names must belong to an approved whitelist. Model confidence is capped in code rather than trusted blindly.
- **Local privacy**: Files never leave your computer. There are no cloud endpoints, external API keys, or analytics tracking.

## Why open-weight
- **Privacy for personal files**: Download and desktop folders often contain sensitive items—utility bills, bank receipts, ID scans, personal photos, and work contracts. Running an open-weight model locally ensures that private documents and images are never uploaded to remote servers or third-party APIs.
- **Zero per-file cost**: Running batch organization on hundreds of files incurs no token fees or subscription costs.
- **Model flexibility**: Because the system integrates via Ollama's local HTTP API, you can swap or update models as open-weight models evolve.

## Setup
1. **Install Ollama**: Download and install [Ollama](https://ollama.com).
2. **Pull the Gemma 3 model**:
   ```bash
   ollama pull gemma3:4b
   ```
3. **Install Node dependencies**:
   ```bash
   npm install
   ```
4. **Start the application**:
   ```bash
   npm start
   ```
5. **Open in browser**: Navigate to [http://127.0.0.1:3000](http://127.0.0.1:3000).

*Note: Generating downscaled image previews for model analysis uses the macOS built-in command-line tool `sips`. Image analysis is therefore supported on macOS.*

## Known limits
- **Small model guesses can be inaccurate**: Gemma 3 4B is a compact model and may misidentify objects or context; every suggestion is designed to be reviewed by a human before applying.
- **Documents and PDFs are not read**: PDFs, Word documents, and spreadsheets are judged by their filename alone; their internal text contents are not extracted or parsed.
- **No facial recognition**: The prompt specifically forbids naming or identifying individuals; images of people are described generically (e.g. `group-photo`, `portrait`).
- **Empty output folder on zero copies**: If an apply runs with zero selected items, an empty output directory is still created.
- **Character replacement**: Slashes, dots, whitespace, and special symbols in suggested names are automatically normalized to hyphens.

## Licence
MIT
