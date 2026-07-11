/*
 * app.js — PaperLens UI controller.
 *
 * Flow:  library → camera/upload → edit (detect + drag corners) →
 *        filter (clean up) → save page → library.  Pages can be OCR'd,
 *        exported to a single PDF, or exported as combined text.
 */

const BRAND = 'PaperLens';
const MAX_DIM = 1600; // cap the working resolution for speed/memory

// ---- Application state -----------------------------------------------------
const state = {
  pages: [],          // { id, dataUrl, width, height, text }
  edit: {
    sourceCanvas: null, // full-res working image for the current scan
    displayScale: 1,    // sourceCanvas px -> editCanvas px
    quad: null,         // 4 points in editCanvas (display) coords
    dragIndex: -1,
    targetPageId: null, // when re-cropping, the page to replace instead of append
  },
  filter: {
    warpedCanvas: null, // perspective-corrected page, pre-filter
    rotation: 0,
    current: 'enhance',
  },
  modalPageId: null,
  ocrWorker: null,
  ocrProgress: { i: 0, n: 0 }, // for whole-document OCR status text
};

// ---- Tiny DOM helpers ------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const views = ['library', 'camera', 'edit', 'filter'];

function showView(name) {
  views.forEach((v) => $(`#view-${v}`).classList.toggle('active', v === name));
  if (name !== 'camera') stopCamera();
}

function showLoader(text = 'Working…') {
  $('#loaderText').textContent = text;
  $('#loader').hidden = false;
}
function hideLoader() { $('#loader').hidden = true; }

let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

// ---- Library rendering -----------------------------------------------------
function renderLibrary() {
  const hasPages = state.pages.length > 0;
  $('#emptyState').hidden = hasPages;
  $('#library').hidden = !hasPages;
  $('#pageCount').textContent = state.pages.length;
  $('#btnExportPdf').disabled = !hasPages;
  $('#btnExportText').disabled = !hasPages;

  const grid = $('#pageGrid');
  grid.innerHTML = '';
  state.pages.forEach((p, i) => {
    const card = document.createElement('div');
    card.className = 'page-card';
    card.innerHTML = `
      <img src="${p.dataUrl}" alt="Page ${i + 1}" />
      <span class="idx">${i + 1}</span>
      ${p.text ? '<span class="badge">TEXT</span>' : ''}`;
    card.addEventListener('click', () => openPageModal(p.id));
    grid.appendChild(card);
  });
}

// ---- Image intake ----------------------------------------------------------
function fitCanvasToImage(img) {
  let { width, height } = img;
  const scale = Math.min(1, MAX_DIM / Math.max(width, height));
  width = Math.round(width * scale);
  height = Math.round(height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(img, 0, 0, width, height);
  return canvas;
}

function loadImageFromBlob(blob) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(img.src); resolve(img); };
    img.onerror = reject;
    img.src = URL.createObjectURL(blob);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// Enter the manual editor for a single image. Pass a page id to replace that
// page on save (re-crop); otherwise a new page is appended.
async function startEditFromImage(img, targetPageId = null) {
  state.edit.sourceCanvas = fitCanvasToImage(img);
  state.edit.targetPageId = targetPageId;
  showView('edit');
  await cvReady();
  layoutEditCanvas();
  autoDetect(); // seed the quad with a detected page (falls back to inset)
}

// Run the full pipeline (detect -> warp -> enhance) on a source canvas with no
// manual step, returning a finished page canvas. Used for batch import.
function autoProcessCanvas(srcCanvas) {
  const src = matFromCanvas(srcCanvas);
  let warped;
  try {
    const pts = detectDocumentQuad(src);
    warped = pts ? warpToDocument(src, pts) : src.clone();
  } finally {
    src.delete();
  }
  const enhanced = applyFilter(warped, 'enhance');
  warped.delete();
  const out = document.createElement('canvas');
  cvShow(enhanced, out);
  enhanced.delete();
  return out;
}

function pushPage(processedCanvas, originalCanvas) {
  state.pages.push({
    id: crypto.randomUUID(),
    dataUrl: processedCanvas.toDataURL('image/jpeg', 0.92),
    original: originalCanvas.toDataURL('image/jpeg', 0.85), // kept for re-crop
    width: processedCanvas.width,
    height: processedCanvas.height,
    text: '',
    words: null,
  });
}

// Auto-process several images and append them all as pages.
async function batchImport(files) {
  await cvReady();
  showLoader(`Processing ${files.length} pages…`);
  let added = 0;
  for (let i = 0; i < files.length; i++) {
    $('#loaderText').textContent = `Processing page ${i + 1} of ${files.length}…`;
    try {
      const img = await loadImageFromBlob(files[i]);
      const srcCanvas = fitCanvasToImage(img);
      const processed = autoProcessCanvas(srcCanvas);
      pushPage(processed, srcCanvas);
      added++;
    } catch (err) {
      console.error('Skipped an image during batch import:', err);
    }
    await new Promise((r) => setTimeout(r, 0)); // let the progress text paint
  }
  hideLoader();
  showView('library');
  renderLibrary();
  toast(added === files.length ? `Added ${added} pages` : `Added ${added} of ${files.length} pages`);
}

// ---- Camera ----------------------------------------------------------------
let cameraStreamRef = null;

async function openCamera() {
  showView('camera');
  try {
    cameraStreamRef = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
    $('#cameraStream').srcObject = cameraStreamRef;
  } catch (err) {
    toast('Camera unavailable — pick an image instead');
    $('#filePicker').click();
    showView('library');
  }
}

function stopCamera() {
  if (cameraStreamRef) {
    cameraStreamRef.getTracks().forEach((t) => t.stop());
    cameraStreamRef = null;
  }
}

async function captureFromCamera() {
  const video = $('#cameraStream');
  if (!video.videoWidth) return;
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  stopCamera();
  const img = new Image();
  img.onload = () => startEditFromImage(img);
  img.src = canvas.toDataURL('image/jpeg', 0.95);
}

// ---- Edit stage: canvas + draggable corners --------------------------------
const HANDLE_R = 12;

function layoutEditCanvas() {
  const src = state.edit.sourceCanvas;
  const stage = $('#view-edit .stage');
  const maxW = stage.clientWidth - 32;
  const maxH = stage.clientHeight - 32;
  const scale = Math.min(maxW / src.width, maxH / src.height, 1);
  state.edit.displayScale = scale;

  const canvas = $('#editCanvas');
  canvas.width = Math.round(src.width * scale);
  canvas.height = Math.round(src.height * scale);
}

function defaultQuad() {
  const c = $('#editCanvas');
  const mx = c.width * 0.12;
  const my = c.height * 0.12;
  return [
    { x: mx, y: my },
    { x: c.width - mx, y: my },
    { x: c.width - mx, y: c.height - my },
    { x: mx, y: c.height - my },
  ];
}

function drawEditor() {
  const canvas = $('#editCanvas');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(state.edit.sourceCanvas, 0, 0, canvas.width, canvas.height);

  const q = state.edit.quad;
  if (!q) return;

  // shaded outside, clear document region
  ctx.save();
  ctx.fillStyle = 'rgba(8,10,14,.55)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath();
  ctx.moveTo(q[0].x, q[0].y);
  for (let i = 1; i < 4; i++) ctx.lineTo(q[i].x, q[i].y);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // outline
  ctx.strokeStyle = '#4f8cff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(q[0].x, q[0].y);
  for (let i = 1; i < 4; i++) ctx.lineTo(q[i].x, q[i].y);
  ctx.closePath();
  ctx.stroke();

  // handles
  q.forEach((p) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, HANDLE_R, 0, Math.PI * 2);
    ctx.fillStyle = '#4f8cff';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(p.x, p.y, HANDLE_R - 5, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
  });
}

function autoDetect() {
  const src = matFromCanvas(state.edit.sourceCanvas);
  let quad;
  try {
    const pts = detectDocumentQuad(src);
    if (pts) {
      const s = state.edit.displayScale;
      quad = pts.map((p) => ({ x: p.x * s, y: p.y * s }));
      toast('Edges detected — drag the corners to fine-tune');
    } else {
      quad = defaultQuad();
      toast('No clear edges found — set the corners manually');
    }
  } finally {
    src.delete();
  }
  state.edit.quad = quad;
  drawEditor();
}

function canvasPoint(evt) {
  const canvas = $('#editCanvas');
  const rect = canvas.getBoundingClientRect();
  const x = (evt.clientX - rect.left) * (canvas.width / rect.width);
  const y = (evt.clientY - rect.top) * (canvas.height / rect.height);
  return { x, y };
}

function onEditPointerDown(evt) {
  if (!state.edit.quad) return;
  const p = canvasPoint(evt);
  let nearest = -1, best = Infinity;
  state.edit.quad.forEach((c, i) => {
    const d = Math.hypot(c.x - p.x, c.y - p.y);
    if (d < best) { best = d; nearest = i; }
  });
  if (best <= HANDLE_R * 2.4) {
    state.edit.dragIndex = nearest;
    $('#editCanvas').setPointerCapture(evt.pointerId);
  }
}

function onEditPointerMove(evt) {
  if (state.edit.dragIndex < 0) return;
  const canvas = $('#editCanvas');
  const p = canvasPoint(evt);
  p.x = Math.max(0, Math.min(canvas.width, p.x));
  p.y = Math.max(0, Math.min(canvas.height, p.y));
  state.edit.quad[state.edit.dragIndex] = p;
  drawEditor();
}

function onEditPointerUp() { state.edit.dragIndex = -1; }

function applyCrop() {
  const s = state.edit.displayScale;
  const srcPts = state.edit.quad.map((p) => ({ x: p.x / s, y: p.y / s }));
  const src = matFromCanvas(state.edit.sourceCanvas);
  let warped;
  try {
    warped = warpToDocument(src, srcPts);
  } finally {
    src.delete();
  }

  const canvas = document.createElement('canvas');
  cvShow(warped, canvas);
  warped.delete();

  state.filter.warpedCanvas = canvas;
  state.filter.rotation = 0;
  state.filter.current = 'enhance';
  document.querySelectorAll('#filterStrip .chip').forEach((c) =>
    c.classList.toggle('active', c.dataset.filter === 'enhance'));

  showView('filter');
  renderFilter();
}

// ---- Filter stage ----------------------------------------------------------
function renderFilter() {
  const base = state.filter.warpedCanvas;
  const src = matFromCanvas(base);
  const rotated = rotate90(src, state.filter.rotation);
  src.delete();

  const filtered = applyFilter(rotated, state.filter.current);
  rotated.delete();

  cvShow(filtered, $('#filterCanvas'));
  filtered.delete();
}

function savePage() {
  const canvas = $('#filterCanvas');
  const dataUrl = canvas.toDataURL('image/jpeg', 0.92);

  if (state.edit.targetPageId) {
    // Re-crop: replace the existing page in place and invalidate its OCR.
    const page = state.pages.find((p) => p.id === state.edit.targetPageId);
    if (page) {
      page.dataUrl = dataUrl;
      page.width = canvas.width;
      page.height = canvas.height;
      page.text = '';
      page.words = null;
    }
    state.edit.targetPageId = null;
    toast('Page updated');
  } else {
    state.pages.push({
      id: crypto.randomUUID(),
      dataUrl,
      original: state.edit.sourceCanvas.toDataURL('image/jpeg', 0.85),
      width: canvas.width,
      height: canvas.height,
      text: '',
      words: null,
    });
    toast('Page saved');
  }

  showView('library');
  renderLibrary();
}

// ---- Page modal + OCR ------------------------------------------------------
function openPageModal(id) {
  const page = state.pages.find((p) => p.id === id);
  if (!page) return;
  state.modalPageId = id;
  $('#modalImg').src = page.dataUrl;
  $('#ocrText').value = page.text || '';
  $('#ocrPanel').hidden = !page.text;
  $('#btnModalRecrop').hidden = !page.original; // older pages may lack an original
  $('#pageModal').hidden = false;
}

function closePageModal() {
  $('#pageModal').hidden = true;
  state.modalPageId = null;
}

function deleteCurrentPage() {
  state.pages = state.pages.filter((p) => p.id !== state.modalPageId);
  closePageModal();
  renderLibrary();
}

// Lazily create a single reusable OCR worker. Its progress text adapts to
// whether we're OCR'ing one page or the whole document (state.ocrProgress).
async function getOcrWorker() {
  if (!state.ocrWorker) {
    state.ocrWorker = await Tesseract.createWorker('eng', 1, {
      logger: (m) => {
        if (m.status !== 'recognizing text') return;
        const pct = Math.round(m.progress * 100);
        const pr = state.ocrProgress;
        $('#loaderText').textContent = pr.n > 1
          ? `Extracting text… page ${pr.i} of ${pr.n} (${pct}%)`
          : `Extracting text… ${pct}%`;
      },
    });
  }
  return state.ocrWorker;
}

// Recognize one page and store both plain text and per-word boxes. The boxes
// (in the page image's pixel space) power the searchable-PDF text layer.
async function recognizePage(worker, page) {
  const { data } = await worker.recognize(page.dataUrl, {}, { blocks: true });
  page.text = (data.text || '').trim();
  page.words = (data.words || [])
    .filter((w) => w.text && w.text.trim() && w.bbox)
    .map((w) => ({ text: w.text, bbox: w.bbox }));
  return page;
}

async function runOcr() {
  const page = state.pages.find((p) => p.id === state.modalPageId);
  if (!page) return;
  if (typeof Tesseract === 'undefined') { toast('OCR engine still loading…'); return; }

  showLoader('Extracting text…');
  state.ocrProgress = { i: 1, n: 1 };
  try {
    const worker = await getOcrWorker();
    await recognizePage(worker, page);
    $('#ocrText').value = page.text;
    $('#ocrPanel').hidden = false;
    renderLibrary();
    toast(page.text ? 'Text extracted' : 'No text found on this page');
  } catch (err) {
    console.error(err);
    toast('OCR failed — try again');
  } finally {
    hideLoader();
  }
}

// OCR every page that hasn't been recognized yet (whole-document extract).
async function ocrAllPages() {
  if (!state.pages.length) { toast('Add some pages first'); return; }
  if (typeof Tesseract === 'undefined') { toast('OCR engine still loading…'); return; }
  const pending = state.pages.filter((p) => !(p.words && p.words.length));
  if (!pending.length) { toast('All pages already have text'); return; }

  showLoader('Extracting text…');
  state.ocrProgress = { i: 0, n: pending.length };
  try {
    const worker = await getOcrWorker();
    for (let i = 0; i < pending.length; i++) {
      state.ocrProgress.i = i + 1;
      await recognizePage(worker, pending[i]);
    }
    renderLibrary();
    toast('Text extracted from all pages');
  } catch (err) {
    console.error(err);
    toast('OCR failed — try again');
  } finally {
    hideLoader();
  }
}

// Re-open the manual editor on a saved page's original photo to fix a crop.
async function recropPage() {
  const page = state.pages.find((p) => p.id === state.modalPageId);
  if (!page) return;
  if (!page.original) { toast('No original available to re-crop'); return; }
  const id = page.id;
  closePageModal();
  const img = await loadImage(page.original);
  startEditFromImage(img, id);
}

// ---- Exports ---------------------------------------------------------------
function exportPdf() {
  if (!state.pages.length) return;
  if (!window.jspdf) { toast('PDF engine still loading…'); return; }
  showLoader('Building PDF…');

  // Defer so the loader paints before the (synchronous) jsPDF work.
  setTimeout(() => {
    try {
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ unit: 'pt', format: 'a4', compress: true });
      const pw = doc.internal.pageSize.getWidth();
      const ph = doc.internal.pageSize.getHeight();
      let searchable = false;

      state.pages.forEach((p, i) => {
        if (i > 0) doc.addPage();
        const ratio = Math.min(pw / p.width, ph / p.height);
        const w = p.width * ratio;
        const h = p.height * ratio;
        const ox = (pw - w) / 2;
        const oy = (ph - h) / 2;
        doc.addImage(p.dataUrl, 'JPEG', ox, oy, w, h);

        // Lay an invisible, selectable text layer over the scan using the OCR
        // word boxes. Placed per word, so text is searchable and copyable
        // while the visible page stays the original image.
        if (p.words && p.words.length) {
          searchable = true;
          p.words.forEach((word) => {
            const b = word.bbox;
            const wpt = (b.x1 - b.x0) * ratio;
            const hpt = (b.y1 - b.y0) * ratio;
            if (wpt <= 0 || hpt <= 0) return;
            doc.setFontSize(Math.max(1, hpt));
            doc.text(word.text, ox + b.x0 * ratio, oy + b.y1 * ratio, {
              renderingMode: 'invisible',
              baseline: 'alphabetic',
            });
          });
        }
      });

      doc.save(`${BRAND}-scan-${Date.now()}.pdf`);
      toast(searchable ? 'Searchable PDF exported' : 'PDF exported');
    } catch (err) {
      console.error(err);
      toast('PDF export failed');
    } finally {
      hideLoader();
    }
  }, 50);
}

async function exportText() {
  if (!state.pages.length) return;
  // If nothing has been recognized yet, OCR the whole document first.
  if (!state.pages.some((p) => p.text)) {
    await ocrAllPages();
  }
  const withText = state.pages.filter((p) => p.text);
  if (!withText.length) { toast('No text found in this document'); return; }
  const body = state.pages
    .map((p, i) => (p.text ? `--- Page ${i + 1} ---\n${p.text}` : ''))
    .filter(Boolean)
    .join('\n\n');
  const blob = new Blob([body], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${BRAND}-text-${Date.now()}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Text exported');
}

// ---- Wiring ----------------------------------------------------------------
function bindEvents() {
  $('#btnStartEmpty').addEventListener('click', openCamera);
  $('#btnStart').addEventListener('click', openCamera);
  $('#btnOcrAll').addEventListener('click', ocrAllPages);

  // Camera
  $('#btnShutter').addEventListener('click', captureFromCamera);
  $('#btnCameraCancel').addEventListener('click', () => showView('library'));
  $('#filePicker').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files);
    e.target.value = '';
    if (!files.length) return;
    if (files.length === 1) {
      // Single image → review it in the manual editor.
      const img = await loadImageFromBlob(files[0]);
      startEditFromImage(img);
    } else {
      // Several images → auto-process the whole batch into pages.
      await batchImport(files);
    }
  });

  // Edit
  const editCanvas = $('#editCanvas');
  editCanvas.addEventListener('pointerdown', onEditPointerDown);
  editCanvas.addEventListener('pointermove', onEditPointerMove);
  editCanvas.addEventListener('pointerup', onEditPointerUp);
  editCanvas.addEventListener('pointercancel', onEditPointerUp);
  $('#btnAutoDetect').addEventListener('click', autoDetect);
  $('#btnEditRotate').addEventListener('click', () => {
    // rotate the working image 90° cw, re-layout, re-detect
    const src = matFromCanvas(state.edit.sourceCanvas);
    const rot = rotate90(src, 1);
    const c = document.createElement('canvas');
    cvShow(rot, c);
    src.delete(); rot.delete();
    state.edit.sourceCanvas = c;
    layoutEditCanvas();
    autoDetect();
  });
  $('#btnEditApply').addEventListener('click', applyCrop);
  $('#btnEditCancel').addEventListener('click', () => showView('library'));

  // Filter
  $('#filterStrip').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    document.querySelectorAll('#filterStrip .chip').forEach((c) => c.classList.remove('active'));
    chip.classList.add('active');
    state.filter.current = chip.dataset.filter;
    renderFilter();
  });
  $('#btnFilterRotate').addEventListener('click', () => {
    state.filter.rotation = (state.filter.rotation + 1) % 4;
    renderFilter();
  });
  $('#btnFilterBack').addEventListener('click', () => showView('edit'));
  $('#btnFilterSave').addEventListener('click', savePage);

  // Modal
  $('#btnModalClose').addEventListener('click', closePageModal);
  $('#btnModalRecrop').addEventListener('click', recropPage);
  $('#btnModalDelete').addEventListener('click', deleteCurrentPage);
  $('#btnModalOcr').addEventListener('click', runOcr);
  $('#pageModal').addEventListener('click', (e) => {
    if (e.target.id === 'pageModal') closePageModal();
  });

  // Exports
  $('#btnExportPdf').addEventListener('click', exportPdf);
  $('#btnExportText').addEventListener('click', exportText);

  // Keep the edit canvas sized to the viewport.
  window.addEventListener('resize', () => {
    if ($('#view-edit').classList.contains('active') && state.edit.sourceCanvas) {
      const quadImg = state.edit.quad
        ? state.edit.quad.map((p) => ({ x: p.x / state.edit.displayScale, y: p.y / state.edit.displayScale }))
        : null;
      layoutEditCanvas();
      if (quadImg) state.edit.quad = quadImg.map((p) => ({ x: p.x * state.edit.displayScale, y: p.y * state.edit.displayScale }));
      drawEditor();
    }
  });
}

// ---- Boot ------------------------------------------------------------------
function init() {
  bindEvents();
  renderLibrary();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }
}

document.addEventListener('DOMContentLoaded', init);
