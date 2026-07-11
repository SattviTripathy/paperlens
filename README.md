# PaperLens

A fully in-browser document scanner. Point your camera at a page (or drop in a
photo) and PaperLens finds the edges, flattens the perspective, cleans it up,
and can pull the text out with OCR — **entirely on your device**. No uploads, no
accounts, no server. Installable as a PWA and works offline after the first load.

## Features

- **Edge detection** — OpenCV.js Canny + convex-hull pipeline auto-finds the page.
- **Draggable corners** — nudge the four handles when auto-detect isn't perfect.
- **Perspective correction** — warps the page to a flat, head-on rectangle.
- **Cleanup filters** — Enhance (magic color), Grayscale, and B&W (adaptive
  threshold) for crisp text scans.
- **Batch import** — select many photos at once; each is auto-detected,
  de-skewed, and enhanced into its own page.
- **Multi-page documents** — build up an ordered stack of pages in one session.
- **Re-crop** — re-open any saved page's original photo to fix a bad detection.
- **OCR** — Tesseract.js, per page or the **whole document** in one action.
- **Export**
  - **Searchable PDF** — all pages as one PDF with an invisible, selectable
    text layer positioned over each scan (search/copy from the document).
  - **Combined `.txt`** — the recognized text of every page in one file.
- **PWA** — installable, offline-capable, camera-ready.

## Tech

Pure vanilla JS, no build step. Three libraries loaded from CDN and cached by
the service worker:

| Library | Role |
|---|---|
| [OpenCV.js](https://docs.opencv.org/) | edge detection, warp, filters |
| [Tesseract.js](https://tesseract.projectnaptha.com/) | OCR |
| [jsPDF](https://github.com/parallax/jsPDF) | PDF export |

## Run locally

Any static server works (camera + service worker need `https://` or
`localhost`):

```bash
python -m http.server 8080
# then open http://localhost:8080
```

## Files

```
index.html      app shell + views
styles.css      UI
cv-pipeline.js  OpenCV document primitives (detect, warp, filter, rotate)
app.js          UI controller + state machine
manifest.json   PWA manifest
sw.js           service worker (offline shell + CDN runtime cache)
icon.svg        app icon
```

## Notes

- All processing is client-side; nothing leaves the browser.
- OCR currently ships English (`eng`); add more Tesseract language packs as needed.
- To rename the app, change the `BRAND` constant in `app.js` and the strings in
  `manifest.json` / `index.html`.
