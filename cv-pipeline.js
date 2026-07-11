/*
 * cv-pipeline.js — document-scanning primitives on top of OpenCV.js.
 *
 * Every function that returns a cv.Mat hands ownership to the caller: draw it
 * with cvShow() and then call mat.delete(). Intermediate Mats are freed here.
 * These functions assume window.cv exists and its runtime is initialized;
 * use cvReady() to await that.
 */

/** Resolves once the OpenCV.js WASM runtime is ready to use. */
function cvReady() {
  return new Promise((resolve) => {
    const tick = () => {
      if (window.cv && cv.Mat && typeof cv.matFromImageData === 'function') resolve();
      else setTimeout(tick, 60);
    };
    tick();
  });
}

/** Draw a cv.Mat onto a canvas element. */
function cvShow(mat, canvas) {
  cv.imshow(canvas, mat);
}

/** Read a canvas into a fresh RGBA cv.Mat. */
function matFromCanvas(canvas) {
  const ctx = canvas.getContext('2d');
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return cv.matFromImageData(imgData);
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Order four points as [top-left, top-right, bottom-right, bottom-left].
 * Uses the classic sum/diff trick: TL has min x+y, BR has max x+y,
 * TR has min (y-x), BL has max (y-x).
 */
function orderCorners(pts) {
  const bySum = [...pts].sort((a, b) => (a.x + a.y) - (b.x + b.y));
  const byDiff = [...pts].sort((a, b) => (a.y - a.x) - (b.y - b.x));
  return {
    tl: bySum[0],
    br: bySum[3],
    tr: byDiff[0],
    bl: byDiff[3],
  };
}

/**
 * Detect the page boundary in an RGBA Mat and return its four corners as an
 * array of {x, y} in source-image coordinates (or null if nothing convincing
 * is found).
 *
 * Rather than trusting a single contour to trace the whole page — Gaussian
 * blur plus dilation tends to split a border into a thin double-walled ring
 * whose enclosed area collapses to ~0, and diagonal edges fragment into
 * several contours — we pool *every* edge point and take one global convex
 * hull. For a single dominant document the hull is the page outline (interior
 * text sits inside it and doesn't affect the boundary). The hull is then
 * reduced to a quadrilateral, widening the approximation tolerance until four
 * corners remain, with a rotated-rectangle fallback.
 */
function detectDocumentQuad(src) {
  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  const edges = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  let allPoints = null;
  let hull = null;
  let result = null;

  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
    cv.Canny(blurred, edges, 75, 200);

    // Thicken edges so fragments of the same border sit adjacent in the hull.
    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
    cv.dilate(edges, edges, kernel);
    kernel.delete();

    cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    // Pool all contour points into one set.
    const pts = [];
    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const d = cnt.data32S;
      for (let j = 0; j < d.length; j += 2) pts.push(d[j], d[j + 1]);
      cnt.delete();
    }
    if (pts.length < 8) return null;

    allPoints = cv.matFromArray(pts.length / 2, 1, cv.CV_32SC2, pts);
    hull = new cv.Mat();
    cv.convexHull(allPoints, hull, false, true);

    const imgArea = src.rows * src.cols;
    if (cv.contourArea(hull) < imgArea * 0.15) return null; // page too small / not found

    const peri = cv.arcLength(hull, true);
    for (let f = 0.02; f <= 0.12 && !result; f += 0.01) {
      const approx = new cv.Mat();
      cv.approxPolyDP(hull, approx, f * peri, true);
      if (approx.rows === 4) {
        result = [];
        for (let r = 0; r < 4; r++) {
          result.push({ x: approx.data32S[r * 2], y: approx.data32S[r * 2 + 1] });
        }
      }
      approx.delete();
    }

    // Fallback: a rotated bounding rectangle always yields four corners.
    if (!result) {
      const rr = cv.minAreaRect(hull);
      result = cv.RotatedRect.points(rr).map((p) => ({ x: p.x, y: p.y }));
    }
  } finally {
    gray.delete(); blurred.delete(); edges.delete();
    contours.delete(); hierarchy.delete();
    if (allPoints) allPoints.delete();
    if (hull) hull.delete();
  }
  return result;
}

/**
 * Warp the quadrilateral described by four (unordered) points into a flat,
 * head-on rectangle. Output size is derived from the edge lengths so the
 * aspect ratio is preserved. Returns a new RGBA Mat.
 */
function warpToDocument(src, pts) {
  const { tl, tr, br, bl } = orderCorners(pts);

  const widthTop = distance(tl, tr);
  const widthBottom = distance(bl, br);
  const heightLeft = distance(tl, bl);
  const heightRight = distance(tr, br);

  const outW = Math.max(1, Math.round(Math.max(widthTop, widthBottom)));
  const outH = Math.max(1, Math.round(Math.max(heightLeft, heightRight)));

  const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
    tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y,
  ]);
  const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
    0, 0, outW - 1, 0, outW - 1, outH - 1, 0, outH - 1,
  ]);

  const M = cv.getPerspectiveTransform(srcTri, dstTri);
  const dst = new cv.Mat();
  cv.warpPerspective(src, dst, M, new cv.Size(outW, outH), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar());

  srcTri.delete(); dstTri.delete(); M.delete();
  return dst;
}

/**
 * Apply a scan-cleanup filter. Returns a new RGBA Mat.
 *   'original' — untouched
 *   'enhance'  — white balance + contrast + gentle sharpen ("magic color")
 *   'gray'     — desaturated
 *   'bw'       — adaptive threshold, ideal for text documents
 */
function applyFilter(src, name) {
  if (name === 'original') return src.clone();

  if (name === 'gray') {
    const gray = new cv.Mat();
    const out = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.cvtColor(gray, out, cv.COLOR_GRAY2RGBA);
    gray.delete();
    return out;
  }

  if (name === 'bw') {
    const gray = new cv.Mat();
    const bin = new cv.Mat();
    const out = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.adaptiveThreshold(gray, bin, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 15, 12);
    cv.cvtColor(bin, out, cv.COLOR_GRAY2RGBA);
    gray.delete(); bin.delete();
    return out;
  }

  // 'enhance' (default): normalize lighting, lift contrast, unsharp mask.
  const rgb = new cv.Mat();
  cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);

  // Per-channel contrast stretch approximates a simple white balance.
  const channels = new cv.MatVector();
  cv.split(rgb, channels);
  for (let c = 0; c < 3; c++) {
    const ch = channels.get(c);
    cv.normalize(ch, ch, 0, 255, cv.NORM_MINMAX);
  }
  cv.merge(channels, rgb);
  channels.delete();

  // Slight global contrast/brightness bump.
  cv.convertScaleAbs(rgb, rgb, 1.12, 6);

  // Unsharp mask: sharpened = 1.5*img - 0.5*blur.
  const blur = new cv.Mat();
  cv.GaussianBlur(rgb, blur, new cv.Size(0, 0), 3);
  cv.addWeighted(rgb, 1.5, blur, -0.5, 0, rgb);
  blur.delete();

  const out = new cv.Mat();
  cv.cvtColor(rgb, out, cv.COLOR_RGB2RGBA);
  rgb.delete();
  return out;
}

/** Rotate a Mat by a multiple of 90 degrees (positive = clockwise). Returns a new Mat. */
function rotate90(src, steps) {
  const n = ((steps % 4) + 4) % 4;
  if (n === 0) return src.clone();
  const out = new cv.Mat();
  const code = n === 1 ? cv.ROTATE_90_CLOCKWISE
    : n === 2 ? cv.ROTATE_180
    : cv.ROTATE_90_COUNTERCLOCKWISE;
  cv.rotate(src, out, code);
  return out;
}
