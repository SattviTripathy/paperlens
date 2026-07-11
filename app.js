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
  },
  filter: {
    warpedCanvas: null, // perspective-corrected page, pre-filter
    rotation: 0,
    current: 'enhance',
  },
  modalPageId: null,
  ocrWorker: null,
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

async function startEditFromImage(img) {
  state.edit.sourceCanvas = fitCanvasToImage(img);
  showView('edit');
  await cvReady();
  layoutEditCanvas();
  autoDetect(); // seed the quad with a detected page (falls back to inset)
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
  state.pages.push({
    id: crypto.randomUUID(),
    dataUrl,
    width: canvas.width,
    height: canvas.height,
    text: '',
  });
  toast('Page saved');
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

async function runOcr() {
  const page = state.pages.find((p) => p.id === state.modalPageId);
  if (!page) return;
  if (typeof Tesseract === 'undefined') { toast('OCR engine still loading…'); return; }

  showLoader('Recognizing text…');
  try {
    if (!state.ocrWorker) {
      state.ocrWorker = await Tesseract.createWorker('eng', 1, {
        logger: (m) => {
          if (m.status === 'recognizing text') {
            $('#loaderText').textContent = `Recognizing text… ${Math.round(m.progress * 100)}%`;
          }
        },
      });
    }
    const { data } = await state.ocrWorker.recognize(page.dataUrl);
    page.text = (data.text || '').trim();
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

      state.pages.forEach((p, i) => {
        if (i > 0) doc.addPage();
        const ratio = Math.min(pw / p.width, ph / p.height);
        const w = p.width * ratio;
        const h = p.height * ratio;
        doc.addImage(p.dataUrl, 'JPEG', (pw - w) / 2, (ph - h) / 2, w, h);
      });

      doc.save(`${BRAND}-scan-${Date.now()}.pdf`);
      toast('PDF exported');
    } catch (err) {
      console.error(err);
      toast('PDF export failed');
    } finally {
      hideLoader();
    }
  }, 50);
}

function exportText() {
  const withText = state.pages.filter((p) => p.text);
  if (!withText.length) { toast('No recognized text yet — run OCR on a page first'); return; }
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

  // Camera
  $('#btnShutter').addEventListener('click', captureFromCamera);
  $('#btnCameraCancel').addEventListener('click', () => showView('library'));
  $('#filePicker').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const img = await loadImageFromBlob(file);
    startEditFromImage(img);
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
