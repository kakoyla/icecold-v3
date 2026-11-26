// QR display and camera scanning (SPEC §4.1, DECISIONS A18).
// Display: draw the module matrix onto a <canvas> (no data: URLs, no inline
// styles). Scanning: getUserMedia + jsQR, the same way v2 did.
import qrcode from 'qrcode-generator';
import jsQR from 'jsqr';
import { h } from './dom.js';
import { onWipe } from './session.js';

const QUIET = 4;

/** A canvas showing `text` as a QR code. Byte mode, error correction M. */
export function qrCanvas(text, { scale = 0, label } = {}) {
  const q = qrcode(0, 'M');
  q.addData(text, 'Byte');
  q.make();
  const n = q.getModuleCount();
  const s = scale || Math.max(3, Math.floor(560 / (n + 2 * QUIET)));
  const size = (n + 2 * QUIET) * s;
  const c = h('canvas', { class: 'qr', width: size, height: size });
  if (label) c.setAttribute('aria-label', label);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#000000';
  for (let r = 0; r < n; r++) {
    for (let col = 0; col < n; col++) {
      if (q.isDark(r, col)) ctx.fillRect((col + QUIET) * s, (r + QUIET) * s, s, s);
    }
  }
  return c;
}

/**
 * Start the camera and call onText(text) for every QR code read.
 * onText returns true to stop scanning. Returns { el, stop }.
 */
export function scanner(onText, { hint = 'Hold the QR code up to the webcam.' } = {}) {
  const video = h('video', { class: 'scan-video', muted: true, playsInline: true, autoplay: true });
  const canvas = h('canvas', { class: 'hidden' });
  const status = h('p', { class: 'scan-status', text: 'Starting camera…' });
  const el = h('div', { class: 'scanner' }, video, h('p', { class: 'note', text: hint }), status, canvas);
  let stream = null;
  let stopped = false;
  let last = '';

  const stop = () => {
    stopped = true;
    if (stream) for (const t of stream.getTracks()) t.stop();
    stream = null;
    video.srcObject = null;
  };
  onWipe(stop);

  const frame = () => {
    if (stopped) return;
    if (video.readyState >= 2 && video.videoWidth) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
      if (code && code.data && code.data !== last) {
        last = code.data;
        let done = false;
        try { done = onText(code.data, status) === true; } catch (e) { status.textContent = String(e.message || e); }
        if (done) { stop(); return; }
      }
    }
    requestAnimationFrame(frame);
  };

  (async () => {
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('no camera support in this browser');
      stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
      if (stopped) { stop(); return; }
      video.srcObject = stream;
      await video.play().catch(() => {});
      status.textContent = 'Camera on. Scanning…';
      requestAnimationFrame(frame);
    } catch (e) {
      status.textContent = `Camera not available: ${e.message || e}`;
      status.classList.add('error');
    }
  })();

  return { el, stop };
}
