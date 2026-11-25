# Peter Parker Study

An AI-powered book research, summarisation and study app. Type the name of a book (or upload your own material), choose exactly which pages to use, then:

- **Summarize** at five levels of detail (Insane → Low)
- **Quiz me** with questions for any subject, teacher-style feedback and step-by-step maths working
- **Study mode** with a tutor that teaches the material and checks your understanding
- **Combined study** that merges several books into one guide
- **Compare sources** to see similarities, differences and contradictions
- **Revision** guides with definitions, facts, formulas, dates and question styles

Everything is tied back to the page it came from: citations like `S1 p.12` open the exact extracted page text.

The front end is plain HTML, CSS and JavaScript. The back end is Node.js with Express and Claude (Anthropic API).

---

## Easiest: one HTML file (no installs)

Download **`dist/peter-parker-study.html`** and double-click it. It opens in your browser (Chrome, Edge, Firefox or Safari) and the whole app runs inside that page.

1. Open **Settings** and paste your Anthropic API key (get one at <https://platform.claude.com/> → API Keys).
2. Start a workspace, add books or upload files, and study.

Notes for the single-file version:
- Your key, books and results are saved **only in this browser on this device**, not in the file. Don't use it on a shared computer.
- Browsers can only download files from websites that allow it. When research finds a source the browser can't download, the app says so and links to it, so you can save the file and upload it.
- Rebuild it after code changes with `npm run build:single`.

## Quick start (server version, needs Node.js)

Requirements: **Node.js 22.13 or newer**.

```bash
npm install
cp .env.example .env        # then put your key in .env:  ANTHROPIC_API_KEY=sk-ant-...
npm start                   # → http://localhost:3000
```

Get an API key at <https://platform.claude.com/> → API Keys. The key is read on the server only and is never sent to the browser.

**Without a key** the app still runs. You can upload files, extract text, select pages, look books up in catalogues, and use clearly labelled **offline fallbacks**: extractive summaries and a fill-in-the-blank quiz. Web research, OCR, real summaries, intelligent marking and the tutor all need the key. Settings shows what is connected.

### Configuration (`.env`)

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Turns on every AI feature. |
| `ANTHROPIC_MODEL` | `claude-opus-5-5` | Model used for every AI call. |
| `AI_REFUSAL_FALLBACK` | `default` | Server-side refusal fallback (`off` disables it). |
| `GOOGLE_BOOKS_API_KEY` | — | Optional. Raises the Google Books rate limit. |
| `PORT` | `3000` | HTTP port. |
| `DATA_DIR` | `./data` | Where workspaces, extracted pages and results are stored. |
| `MAX_UPLOAD_MB` | `150` | Maximum size of each uploaded file. |
| `SINGLE_PASS_MAX_CHARS` | `300000` | Above this, material is processed in chunks (see below). |

If your network needs an HTTP proxy, start Node with `NODE_USE_ENV_PROXY=1` so the server's own downloads use `HTTPS_PROXY`.

---

## How it works

### 1. Book research (no invented content)

1. **Identify.** Open Library, Google Books and Project Gutenberg are searched in parallel. With a key, Claude also uses web search to confirm title, author, publisher, edition, year and ISBN. Similar titles (6A vs 6B, pupil book vs teacher guide) are listed separately, and **you pick the exact edition**.
2. **Locate.** Claude searches and reads the web for *legitimate* sources: publisher sample pages, open-licensed textbooks, public-domain texts and previews. It records exactly which pages each source shows, the table of contents, and any page-numbering quirks. Piracy and document-dump sites are blocked.
3. **Retrieve.** The **server** downloads what is genuinely accessible (PDF, EPUB, HTML, TXT) and extracts the real pages. Only text that was actually downloaded and extracted becomes study material. Public-domain books come in full from Project Gutenberg.
4. **Report.** Every source shows a status:

   `Book Identified` · `Researching` · `Content Found` · `Partially Accessible` · `Full Selected Content Accessible` · `Access Limited` · `Needs User Upload`

   "Full Selected Content Accessible" is shown only when **every page in your selection** was retrieved and readable. Pages that could not be accessed are listed as missing and are never summarised or quizzed. You can upload missing pages straight into the book, for example "this file starts at printed page 23".

Most commercial textbooks (such as Collins Busy Ant Maths) are not legally available in full online. For those, research usually ends in **Access Limited** with a clear explanation, and you upload the pages you need.

### 2. Documents

| Format | Units | Notes |
|---|---|---|
| PDF | pages | Text per page (pdf.js). PDF page labels and printed page numbers in headers and footers are detected. Scanned pages are read with OCR via Claude's vision; pages that fail are listed. |
| DOCX | pages or sections | Approximate pages from Word's last layout when available, otherwise sections by heading. |
| PPTX | slides | Title, body, tables and speaker notes. You select slides by number. |
| EPUB | chapters | Spine order, titles from the table of contents. |
| TXT / MD / HTML / pasted text | parts or pages | Form-feed characters become pages. |
| Images (PNG/JPG/WebP) | page | OCR via Claude's vision. |

### 3. Page selection

Each source has its own ranges (`4-67, 70`), exclusions (`23, 39, 52`), chapter checkboxes and a page map. When printed page numbers differ from PDF positions, the app tells you and lets you choose which numbering you are typing. Changing the selection never triggers new research or a new upload.

### 4. Large material

Material is sent to Claude in a tagged form (`<source key="S1">…<unit ref="p.12">…`), with each source kept separate. Selections larger than `SINGLE_PASS_MAX_CHARS` go through a **hierarchical pipeline**:

1. chunk on page boundaries
2. write detailed notes per chunk, keeping citations
3. merge the notes, in more rounds if still too long
4. write the final document

After generation, **every citation is checked** against the selected, available pages, and the result screen reports the outcome. Quiz questions carry a supporting quote that is checked against the cited page.

### 5. Quiz engine

- The subject is detected automatically, and question styles adapt to it.
- Settings: number of questions, Easy / Normal / Hard / Mixed, MCQ, true/false, written or mixed, topic selection or the whole material.
- **Test mode**: no hints or working until you submit. **Learning mode**: hints, guided working, retries and "show answer".
- Marking:
  - Multiple choice and numeric answers are marked deterministically (`10,368` = `10368`, `1/2` = `0.5` = `50%`).
  - Written answers are marked by meaning, so a correct answer in your own words is accepted.
  - Wrong answers get an explanation of the specific misconception, like a teacher would give.
- Maths controls: Try again, Reveal a hint, Show working, Explain this step, Show another method, Next question.
- The results screen shows your score, correct and incorrect answers, explanations, topics to improve, a retry, another quiz, and practice or study for weak topics.

---

## Project layout

```
server/
  index.js            HTTP API, SSE streaming, static files
  ai.js               Claude client: streaming text, structured JSON, web-research loop, OCR
  config.js store.js jobs.js
  selection.js        ranges, exclusions, numbering, honest status
  material.js         source-separated material, chunking, citation verification
  prompts.js          rules, 5 detail levels, mode tasks
  extract/            pdf, docx, pptx, epub, text/html, printed-number detection
  research/           catalogues, safe downloader, identify → research → retrieve
  modes/              generate (summaries etc.), quiz, tutor, offline fallbacks
public/
  index.html  css/app.css  js/{app,core,api,ui,workspace,results,quiz,study}.js
tests/
  unit/               extraction, selection, citations, marking
  e2e/                Playwright run through the real UI (scripted fake AI client)
  fixtures/           generates sample PDF/DOCX/PPTX/EPUB/TXT
```

## Tests

```bash
npm test                    # unit tests
node tests/e2e/run.mjs      # browser end-to-end (needs Playwright + Chromium installed)
```

The end-to-end test starts the server with `TEST_FAKE_AI_MODULE=tests/e2e/fake-ai.js`. This is a scripted stand-in for the Anthropic client, so the full UI flow can be tested without an API key or network. It covers:

- research
- uploads
- page selection
- summary
- citations
- detail-level change
- test and learning quizzes
- comparison
- study mode
- mobile layout

## Known limitations

- **Live AI calls were not exercised in the development sandbox** (no API key there). The Claude integration follows the current Anthropic SDK and was tested end to end with the scripted fake client. Watch the first real run.
- **Catalogue APIs** (Open Library, Gutenberg) were blocked in the development sandbox. Failures are handled and reported, but those lookups were not run live.
- **View-only previews** (for example the Google Books web reader) can be found and reported but not downloaded.
- **OCR needs the API key.** There is no local OCR engine.
- **Printed page detection for PDFs without labels is a heuristic.** It is always shown to you for confirmation.
- **Old `.doc` / `.ppt` files are not supported.** Save them as `.docx` / `.pptx` first.
- **This is a single-user local app.** It has no accounts or authentication and stores data as JSON files. Add authentication before exposing it on a network.
