# PaperLens

A fully in-browser document scanner. Point your camera at a page (or drop in a
photo) and PaperLens finds the edges, flattens the perspective, cleans it up,
and can pull the text out with OCR — **entirely on your device**. No uploads, no
accounts, no server. Installable as a PWA and works offline after the first load.

## Features

- **Edge detection** — OpenCV.js Canny + contour pipeline auto-finds the page.
- **Draggable corners** — nudge the four handles when auto-detect isn't perfect.
- **Perspective correction** — warps the page to a flat, head-on rectangle.
- **Cleanup filters** — Enhance (magic color), Grayscale, and B&W (adaptive
  threshold) for crisp text scans.
- **Multi-page capture** — build up a stack of pages in one session.
- **OCR** — extract selectable text from any page via Tesseract.js.
- **Export** — one combined PDF, or the recognized text as `.txt`.
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
