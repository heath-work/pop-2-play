'use client';

import { useEffect } from 'react';
import * as THREE from 'three';

/* Bump this on every change you want to verify is deployed. The
   badge sits in the top-right corner of the viewport so you can
   confirm at a glance that the iOS PWA cache has picked up the
   latest build. */
const APP_VERSION = 'v49';

/* ════════════════════════════════════════════════════════════════════
   3D LOTTO BALL TEXTURE — ported from the shakeit app.
   Each ball is a coloured sphere with six numbered "discs" arranged on
   a triangular antiprism (3 upper + 3 lower, offset 60° in longitude).
   Discs are drawn as upright stamps and warped onto an equirectangular
   texture, so the rendered sphere shows geometrically true circles
   instead of stretched ellipses near the poles.

   Why duplicated here (vs. imported from a shared util): keeping the
   renderer self-contained means tuning disc layout / fonts for this
   app doesn't reach back into shakeit. Single-file footprint also
   keeps Next.js per-route code-splitting simple.
   ════════════════════════════════════════════════════════════════════ */
// Hue palette — orange (32) removed by request; 7 hues cycle through
// the numbered balls.
const HUE_MAP = [4, 54, 100, 170, 215, 270, 325];
function ballHue(n) { return HUE_MAP[(n - 1) % HUE_MAP.length]; }
/* Lightness sits at 0.50 — vivid mid-tone, close to the raw hex.
   We render through MeshBasicMaterial (unlit) so the texture colour
   reaches the screen unattenuated; pushing lightness higher just makes
   the ball look washed out / pastel rather than punchier. */
const BALL_SAT = 0.95, BALL_LIGHT = 0.50;
function ballFillCss(h) {
  return `hsl(${h}, ${BALL_SAT * 100}%, ${BALL_LIGHT * 100}%)`;
}
/* sRGB relative luminance of the ball's solid fill — drives white-vs-dark
   glyph contrast since we draw numbers directly on the coloured sphere
   now (no white disc backing). Yellows/cyans/greens → dark navy text;
   purples/pinks → white text. */
function ballLuminance(h) {
  const s = BALL_SAT, l = BALL_LIGHT;
  const c  = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x  = c * (1 - Math.abs((hp % 2) - 1));
  const m  = l - c / 2;
  let r = 0, g = 0, b = 0;
  if      (hp < 1) { r = c; g = x; }
  else if (hp < 2) { r = x; g = c; }
  else if (hp < 3) {         g = c; b = x; }
  else if (hp < 4) {         g = x; b = c; }
  else if (hp < 5) { r = x;         b = c; }
  else             { r = c;         b = x; }
  r += m; g += m; b += m;
  const lin = v => v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
/* Yellow / green / cyan have luminance ≥ 0.45 and read well with dark
   navy glyphs. Red / purple / pink fall well below and need white.
   Blue (hue 215, L ≈ 0.17) is special-cased to dark glyphs by request
   — its saturated mid-tone reads cleanly with #0b1140 even though the
   luminance-only heuristic would pick white. */
function numTextColor(h) {
  if (h === 215) return '#0b1140';                     // blue → dark
  return ballLuminance(h) > 0.45 ? '#0b1140' : '#ffffff';
}

/* Two antipodal discs at the equator: front (lon = +π/2 → maps to the
   camera +Z under three.js's default sphere mapping) and back.
   The earlier 6-disc antiprism (a leftover from shakeit's free-tumbling
   physics ball) let us see a number from any orientation, but our
   balls always settle to the same final pose, so we really only need
   the front disc. A back twin gives the spin-in mid-flight a number
   to show as the sphere half-turns.
   With only two discs π rad apart, DISC_ANGULAR_R can sit at 0.69 rad
   (~40°) without any rim bleed: each cap is bounded by z = R·cos(R),
   so it stays entirely in its hemisphere (z ≥ +0.77R for front, z ≤
   -0.77R for back) — never reaches the z=0 silhouette. */
const DISC_POSITIONS = [
  [0,  Math.PI / 2],   // front
  [0, -Math.PI / 2],   // back
];
const DISC_ANGULAR_R = 0.69;

/* Six-disc antiprism layout — 3 upper lats + 3 lower lats, offset
   60° in longitude so adjacent disc centres are ~0.83 rad apart.
   Used by the intro ball (free-tumbling) so there's always a disc
   near the camera; the 2-disc layout above is fine for in-game
   balls which always settle to the same front-facing pose. */
const ANTIPRISM_DISC_POSITIONS = [
  [ 36 * Math.PI / 180,  30 * Math.PI / 180],
  [ 36 * Math.PI / 180, 150 * Math.PI / 180],
  [ 36 * Math.PI / 180, 270 * Math.PI / 180],
  [-36 * Math.PI / 180,  90 * Math.PI / 180],
  [-36 * Math.PI / 180, 210 * Math.PI / 180],
  [-36 * Math.PI / 180, 330 * Math.PI / 180],
];

function buildStamp(number, textColorOverride) {
  const SIZE = 128;
  const stamp = document.createElement('canvas');
  stamp.width = SIZE; stamp.height = SIZE;
  const sctx = stamp.getContext('2d');
  const str = String(number);
  const FONT_SIZE = SIZE * 0.75;
  sctx.font = `500 ${FONT_SIZE}px "SharpGrotesk", "Larsseit", system-ui, sans-serif`;
  sctx.textAlign = 'center';
  sctx.textBaseline = 'alphabetic';
  // textColorOverride lets white powerballs use dark glyphs even though
  // the underlying number's hue would normally pick white text.
  sctx.fillStyle = textColorOverride || numTextColor(ballHue(number));
  const m = sctx.measureText(str);
  const inkH = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
  const yBaseline = (SIZE - inkH) / 2 + m.actualBoundingBoxAscent;
  sctx.fillText(str, SIZE / 2, yBaseline);
  if (str === '6' || str === '9') {
    const w = m.width;
    sctx.fillRect(
      SIZE / 2 - w / 2 + 2,
      yBaseline + FONT_SIZE * 0.06,
      w - 4,
      Math.max(2, FONT_SIZE * 0.06),
    );
  }
  return { size: SIZE, data: sctx.getImageData(0, 0, SIZE, SIZE) };
}

function warpDisc(texData, W, H, lat0, lon0, stamp, angularR) {
  const sData = stamp.data.data;
  const SIZE = stamp.size;
  const R = angularR != null ? angularR : DISC_ANGULAR_R;
  const cosR = Math.cos(R), sinR = Math.sin(R);
  const cLat = Math.cos(lat0), sLat = Math.sin(lat0);
  const vMax = Math.min(1, (lat0 + R) / Math.PI + 0.5);
  const vMin = Math.max(0, (lat0 - R) / Math.PI + 0.5);
  const yMin = Math.max(0,     Math.floor((1 - vMax) * H));
  const yMax = Math.min(H - 1, Math.ceil((1 - vMin) * H));
  for (let py = yMin; py <= yMax; py++) {
    const lat = (1 - (py + 0.5) / H - 0.5) * Math.PI;
    const cL = Math.cos(lat), sL = Math.sin(lat);
    const denom = cL * cLat;
    let halfLon;
    if (denom < 1e-9) {
      if (sL * sLat < cosR) continue;
      halfLon = Math.PI;
    } else {
      const arg = (cosR - sL * sLat) / denom;
      if (arg > 1) continue;
      halfLon = arg < -1 ? Math.PI : Math.acos(arg);
    }
    const pxStart = Math.floor((lon0 - halfLon) / (2 * Math.PI) * W);
    const pxEnd   = Math.ceil ((lon0 + halfLon) / (2 * Math.PI) * W);
    for (let px = pxStart; px <= pxEnd; px++) {
      const du = (px + 0.5) / W * 2 * Math.PI - lon0;
      const cU = Math.cos(du), sU = Math.sin(du);
      const d = sL * sLat + cL * cLat * cU;
      if (d < cosR) continue;
      const e = cL * sU;
      const n = sL * cLat - sLat * cL * cU;
      const six = Math.floor((e / sinR + 1) * 0.5 * SIZE);
      const siy = Math.floor((1 - n / sinR) * 0.5 * SIZE);
      if (six < 0 || six >= SIZE || siy < 0 || siy >= SIZE) continue;
      const sIdx = (siy * SIZE + six) * 4;
      const sa = sData[sIdx + 3];
      if (sa === 0) continue;
      const wrappedPx = ((px % W) + W) % W;
      const tIdx = (py * W + wrappedPx) * 4;
      const a = sa / 255, inv = 1 - a;
      texData[tIdx]     = sData[sIdx]     * a + texData[tIdx]     * inv;
      texData[tIdx + 1] = sData[sIdx + 1] * a + texData[tIdx + 1] * inv;
      texData[tIdx + 2] = sData[sIdx + 2] * a + texData[tIdx + 2] * inv;
      texData[tIdx + 3] = 255;
    }
  }
}

function makeBallTexture(number, white = false, opts = {}) {
  const W = 512, H = 256;
  const cvs = document.createElement('canvas');
  cvs.width = W; cvs.height = H;
  const ctx = cvs.getContext('2d');

  // Solid base colour:
  //   opts.fill      → explicit override (intro ball, etc.)
  //   white=true     → 8th-position powerball treatment
  //   default        → hue lookup from the ball's number
  ctx.fillStyle = opts.fill
    ? opts.fill
    : (white ? '#f4f4f6' : ballFillCss(ballHue(number)));
  ctx.fillRect(0, 0, W, H);

  // Vertical highlight/shadow gradient baked into the texture.
  // Skipped when `opts.noGradient` is set (intro ball uses real
  // lighting via MeshStandardMaterial instead of a baked sheen).
  if (!opts.noGradient) {
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0.00, 'rgba(255, 255, 255, 0.42)');
    grad.addColorStop(0.32, 'rgba(255, 255, 255, 0.00)');
    grad.addColorStop(0.68, 'rgba(0, 0, 0, 0.00)');
    grad.addColorStop(1.00, 'rgba(0, 0, 0, 0.40)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
  }

  const stamp = buildStamp(
    number,
    opts.textColor || (white ? '#0b1140' : null),
  );
  const img = ctx.getImageData(0, 0, W, H);
  // Optional disc-layout override — intro ball uses the 6-disc
  // antiprism so the equator band isn't an empty "hole" mid-spin.
  const discs = opts.discPositions || DISC_POSITIONS;
  const angR  = opts.angularR != null ? opts.angularR : DISC_ANGULAR_R;
  for (const [lat, lon] of discs) {
    warpDisc(img.data, W, H, lat, lon, stamp, angR);
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cvs);
  tex.wrapS = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

/* ════════════════════════════════════════════════════════════════════
   GAME CONFIG
   ════════════════════════════════════════════════════════════════════ */
/* MAX_NUMBERS_PER_GAME is the JSX render count for tray rings — we
   always render that many DOM slots and let the active draw mode
   hide the extras via CSS. NUMBERS_PER_GAME is the LIVE count used
   by game logic (8 for Powerball, 7 for Oz Lotto). It's a `let`
   because the draw-mode select on the intro updates it. */
const MAX_NUMBERS_PER_GAME = 8;
let   NUMBERS_PER_GAME     = 8;
const DEFAULT_GAMES = 14;

/* Spin-in: ball enters from below the ring slot, spins on Y, then
   settles dead-front with the glyph upright. With the front disc at
   (lat=0, lon=π/2) the disc centre already lands on +Z at rotation
   (0, 0, 0), so the final pose needs no tilt at all. The stamp's "up"
   maps to sphere-north (+Y), which projects to screen +Y → upright. */
const SPIN_DURATION_MS  = 700;
const SPIN_REVOLUTIONS  = 2.4;
const FINAL_ROT_X       = 0;
const FINAL_ROT_Y       = 0;
/* Brand-style balls use the 6-disc antiprism layout — no disc sits at
   (lat=0, lon=π/2) (front-centre), so a default rotation of (0,0,0)
   shows no number head-on. Rotating −36° around the X axis brings the
   southern-front disc (lat=−36°, lon=π/2) up to the equator at the
   front, giving a single big number facing the camera (with smaller
   ones peeking in from the upper hemisphere). */
const BRAND_FINAL_ROT_X = -36 * Math.PI / 180;

export default function BubbleWrapFidget() {
  useEffect(() => {
    const ac = new AbortController();
    const { signal } = ac;

    /* ── Grid sizing — recomputed on every layout/refill ────────── */
    let ROW_COUNTS = [];
    let TOTAL_NUMBERS = 0;

    let bubbleNumPermutation = null;
    function ensureBubblePermutation(total) {
      if (bubbleNumPermutation && bubbleNumPermutation.length === total) return;
      const arr = new Array(total);
      for (let i = 0; i < total; i++) arr[i] = i + 1;
      for (let i = total - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      bubbleNumPermutation = arr;
    }

    /* ── DOM refs ───────────────────────────────────────────────── */
    const stage      = document.getElementById('stage');
    const bubblesEl  = document.getElementById('bubbles');
    const toastEl    = document.getElementById('toast');
    const trayEl     = document.querySelector('.tray');
    const ringsEl    = document.getElementById('trayRings');
    const ringEls    = ringsEl ? Array.from(ringsEl.querySelectorAll('.ring')) : [];
    const ballCanvas = document.getElementById('ballOverlay');
    const ghostRowEl = document.getElementById('trayGhostRow');
    const gameLabelEl = document.getElementById('trayGameLabel');
    const ctaExitEl  = document.getElementById('ctaExit');
    const ctaPillEl  = document.getElementById('ctaPill');
    const ctaPillCountEl = document.getElementById('ctaPillCount');
    const ctaPillProgressEl = document.getElementById('ctaPillProgress');
    const ctaFastSelectEl = document.getElementById('ctaFastSelect');
    const gameMessageEl = document.getElementById('gameMessage');
    const gameMessageTextEl = document.getElementById('gameMessageText');

    if (!stage || !bubblesEl) return;

    /* ── Audio (bubble-pop.mp3 via Web Audio + <audio> pool) ────
       Pop sound is the recorded /bubble-pop.mp3 asset:
         1. Web Audio path — fetched + decoded into a buffer once,
            replayed by spinning up a fresh AudioBufferSourceNode per
            pop. Detune + gain randomised so adjacent pops vary.
         2. <audio> pool fallback — 8 pre-created Audio elements,
            unlocked on first user gesture via muted play(). Used
            when the Web Audio buffer isn't ready or the AC fails. */
    const POP_SRC = '/bubble-pop.mp3';
    const POP_POOL_SIZE = 8;
    let audioEnabled = true;
    // Brand style — when on, in-game balls render with the same look
    // as the outro orbit: flat unlit colour (no baked sheen gradient),
    // 6-disc antiprism number layout, 80% opacity. Off by default;
    // the toggle on the intro flips it.
    let brandEnabled = false;
    /* Draw mode — chosen via the intro's "Draws" select.
       'powerball' (default) → 8 balls per row, all non-white balls
       render BLUE, last slot is the white powerball.
       'ozlotto' → 7 balls per row, multi-colour palette, no white
       powerball at the end. */
    let drawMode = 'powerball';
    function isPowerballSlot(slotIdx) {
      return drawMode === 'powerball' && slotIdx === NUMBERS_PER_GAME - 1;
    }
    let audioCtx = null;
    let popBuffer = null;
    let popBufferLoading = false;
    const popPool = [];
    let popPoolIdx = 0;
    let popPoolUnlocked = false;
    for (let i = 0; i < POP_POOL_SIZE; i++) {
      const a = new Audio(POP_SRC);
      a.preload = 'auto';
      popPool.push(a);
    }
    function ensureAudio() {
      if (!audioCtx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) {
          try { audioCtx = new AC(); loadPopBuffer(); } catch (_) {}
        }
      }
      if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {});
      }
      if (!popPoolUnlocked) {
        popPoolUnlocked = true;
        for (const a of popPool) {
          a.muted = true;
          const p = a.play();
          if (p && typeof p.then === 'function') {
            p.then(() => { a.muted = false; }).catch(() => { a.muted = false; });
          } else {
            a.muted = false;
          }
        }
      }
    }
    async function loadPopBuffer() {
      if (popBufferLoading || popBuffer || !audioCtx) return;
      if (location.protocol === 'file:') return;
      popBufferLoading = true;
      try {
        const res = await fetch(POP_SRC);
        const data = await res.arrayBuffer();
        popBuffer = await new Promise((resolve, reject) =>
          audioCtx.decodeAudioData(data, resolve, reject));
      } catch (err) {
        console.warn('[pop] Web Audio decode failed; using <audio> pool:', err);
      } finally {
        popBufferLoading = false;
      }
    }
    function playPop(variation = 0) {
      if (!audioEnabled) return;
      if (audioCtx && popBuffer) {
        try {
          const src = audioCtx.createBufferSource();
          src.buffer = popBuffer;
          src.detune.value = variation * 30 + (Math.random() * 60 - 30);
          const gain = audioCtx.createGain();
          gain.gain.value = 0.85 + Math.random() * 0.15;
          src.connect(gain).connect(audioCtx.destination);
          src.start();
          return;
        } catch (_) {}
      }
      const a = popPool[popPoolIdx];
      popPoolIdx = (popPoolIdx + 1) % POP_POOL_SIZE;
      try {
        a.pause();
        a.muted = false;
        a.currentTime = 0;
        a.playbackRate = 0.92 + (variation * 0.04) + Math.random() * 0.14;
        a.volume = 0.85 + Math.random() * 0.15;
        const p = a.play();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch (_) {}
    }
    const ROW_COMPLETE_NOTE_FREQS    = [523.25, 659.25, 783.99];
    const ROW_COMPLETE_NOTE_INTERVAL = 0.07;
    const ROW_COMPLETE_NOTE_DECAY    = 0.10;
    const ROW_COMPLETE_ATTACK        = 0.005;
    const ROW_COMPLETE_PEAK_GAIN     = 0.22;
    function playRowComplete() {
      if (!audioEnabled || !audioCtx) return;
      try {
        const t0 = audioCtx.currentTime;
        ROW_COMPLETE_NOTE_FREQS.forEach((freq, i) => {
          const start = t0 + i * ROW_COMPLETE_NOTE_INTERVAL;
          const osc = audioCtx.createOscillator();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(freq, start);
          const gain = audioCtx.createGain();
          gain.gain.setValueAtTime(0.0001, start);
          gain.gain.exponentialRampToValueAtTime(
            ROW_COMPLETE_PEAK_GAIN, start + ROW_COMPLETE_ATTACK);
          gain.gain.exponentialRampToValueAtTime(
            0.0001, start + ROW_COMPLETE_ATTACK + ROW_COMPLETE_NOTE_DECAY);
          osc.connect(gain).connect(audioCtx.destination);
          osc.start(start);
          osc.stop(start + ROW_COMPLETE_ATTACK + ROW_COMPLETE_NOTE_DECAY + 0.02);
        });
      } catch (_) {}
    }
    function playSwoosh() {
      if (!audioEnabled || !audioCtx) return;
      try {
        const now = audioCtx.currentTime;
        const duration = 0.55;
        const sr = audioCtx.sampleRate;
        const len = Math.max(1, Math.floor(sr * duration));
        const buffer = audioCtx.createBuffer(1, len, sr);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
        const src = audioCtx.createBufferSource();
        src.buffer = buffer;
        const filter = audioCtx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.Q.value = 1.4;
        filter.frequency.setValueAtTime(180, now);
        filter.frequency.exponentialRampToValueAtTime(1800, now + 0.18);
        filter.frequency.exponentialRampToValueAtTime(640, now + duration);
        const gain = audioCtx.createGain();
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(0.5, now + 0.05);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
        src.connect(filter).connect(gain).connect(audioCtx.destination);
        src.start(now);
        src.stop(now + duration + 0.05);
      } catch (_) {}
    }
    /* Same recipe as playSwoosh but shorter, quieter, and pitched a
       touch lower — used when the settings / outro bottom sheets
       slide up so the audio cue matches their gentler motion. */
    function playSheetSwoosh() {
      if (!audioEnabled || !audioCtx) return;
      try {
        const now = audioCtx.currentTime;
        const duration = 0.32;
        const sr = audioCtx.sampleRate;
        const len = Math.max(1, Math.floor(sr * duration));
        const buffer = audioCtx.createBuffer(1, len, sr);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
        const src = audioCtx.createBufferSource();
        src.buffer = buffer;
        const filter = audioCtx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.Q.value = 1.6;
        filter.frequency.setValueAtTime(140, now);
        filter.frequency.exponentialRampToValueAtTime(900, now + 0.14);
        filter.frequency.exponentialRampToValueAtTime(420, now + duration);
        const gain = audioCtx.createGain();
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(0.22, now + 0.05);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
        src.connect(filter).connect(gain).connect(audioCtx.destination);
        src.start(now);
        src.stop(now + duration + 0.05);
      } catch (_) {}
    }

    /* ── Haptics (iOS switch-input + navigator.vibrate fallback) ── */
    const IS_IOS =
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    let _hapticSwitch = null;
    function ensureHapticSwitch() {
      if (_hapticSwitch) return _hapticSwitch;
      const label = document.createElement('label');
      label.setAttribute('aria-hidden', 'true');
      label.style.cssText =
        'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.setAttribute('switch', '');
      label.appendChild(input);
      document.body.appendChild(label);
      _hapticSwitch = { label, input };
      return _hapticSwitch;
    }
    function haptic(duration = 8) {
      if (IS_IOS) {
        try { ensureHapticSwitch().input.click(); } catch (_) {}
        return;
      }
      if (navigator.vibrate) {
        const ua = navigator.userActivation;
        if (ua && !ua.hasBeenActive) return;
        try { navigator.vibrate(duration); } catch (_) {}
      }
    }

    /* ── Bubble assets ──────────────────────────────────────────── */
    const BUBBLE_INTACT_SRC = '/bubble-static.png';
    const BUBBLE_POPPED_SRC = '/bubble-popped.png';

    /* ── Bubble frame layout — fixed pixel spec ──────────────────
       Frame:    362 × 548 (centred horizontally in the stage)
       Padding:  15 top · 14 bottom · 8 L/R (used by odd rows)
       Rows:     10 total, alternating 6 / 5 bubbles
       Bubble:   52 × 51
       Gaps:     7 px horizontal · 1 px vertical
       Even rows: 37 px L/R padding (5 bubbles centred wider)

       Vertical: 15 + 10·51 + 9·1 + 14 = 548 ✓
       Odd row : 8 + 6·52 + 5·7 + 8 = 363 ≈ 362
       Even row: 37 + 5·52 + 4·7 + 37 = 362 ✓
       Total numbers per sheet = 5·6 + 5·5 = 55. */
    const FRAME_W = 362;
    // FRAME_H = 548 — documented in the spec comment above; the layout
    // math derives Y per row from FRAME_TOP + FRAME_PAD_TOP, so no
    // runtime use of FRAME_H is needed (CSS pins the plate's height).
    const FRAME_TOP = 16;            // pixels below viewport/stage top — matches #bubbleFrame CSS top
    const FRAME_PAD_TOP = 15;
    const FRAME_PAD_LR_ODD  = 8;
    const FRAME_PAD_LR_EVEN = 37;
    const BUBBLE_W = 52;
    const BUBBLE_H = 51;
    const BUBBLE_GAP_X = 7;
    const ROW_GAP_Y   = 1;
    const ROW_TOTAL   = 10;
    function computeLayout() {
      const rect = stage.getBoundingClientRect();
      const width = rect.width;
      const height = rect.height;
      const frameX = Math.max(0, Math.round((width - FRAME_W) / 2));
      const frameY = FRAME_TOP;

      ROW_COUNTS = [];
      for (let r = 0; r < ROW_TOTAL; r++) {
        // Row 0 = first row, treated as "odd" (6 bubbles).
        ROW_COUNTS.push(r % 2 === 0 ? 6 : 5);
      }
      TOTAL_NUMBERS = ROW_COUNTS.reduce((a, b) => a + b, 0);
      ensureBubblePermutation(TOTAL_NUMBERS);

      const bubbles = [];
      let posIdx = 0;
      ROW_COUNTS.forEach((count, rowIdx) => {
        const padLR = count === 6 ? FRAME_PAD_LR_ODD : FRAME_PAD_LR_EVEN;
        const rowY  = frameY + FRAME_PAD_TOP + rowIdx * (BUBBLE_H + ROW_GAP_Y);
        for (let i = 0; i < count; i++) {
          const x = frameX + padLR + i * (BUBBLE_W + BUBBLE_GAP_X);
          bubbles.push({
            num: bubbleNumPermutation[posIdx++],
            cx: x + BUBBLE_W / 2,
            cy: rowY + BUBBLE_H / 2,
            w: BUBBLE_W,
            h: BUBBLE_H,
          });
        }
      });
      return { width, height, bubbles, frameX, frameY };
    }

    /* ── Bubble render + drag-to-pop ───────────────────────────── */
    const bubbleEls = new Map();
    const bubbleStates = new Map();
    let isDragging = false;
    function bubbleNumAt(clientX, clientY) {
      const hit = document.elementFromPoint(clientX, clientY);
      if (!hit) return null;
      const bubble = hit.closest && hit.closest('.bubble');
      if (!bubble) return null;
      const n = parseInt(bubble.dataset.num, 10);
      return Number.isFinite(n) ? n : null;
    }
    stage.addEventListener('pointermove', (ev) => {
      if (!isDragging) return;
      const num = bubbleNumAt(ev.clientX, ev.clientY);
      if (num != null) popBubble(num);
    }, { signal });
    const endDrag = () => { isDragging = false; };
    window.addEventListener('pointerup', endDrag, { signal });
    window.addEventListener('pointercancel', endDrag, { signal });

    function renderBubbles(layout) {
      bubblesEl.innerHTML = '';
      bubbleEls.clear();
      for (const b of layout.bubbles) {
        if (!bubbleStates.has(b.num)) {
          bubbleStates.set(b.num, { popped: false });
        }
        const state = bubbleStates.get(b.num);
        const el = document.createElement('button');
        el.className = 'bubble';
        el.type = 'button';
        el.style.left = (b.cx - b.w / 2) + 'px';
        el.style.top = (b.cy - b.h / 2) + 'px';
        el.style.width = b.w + 'px';
        el.style.height = b.h + 'px';
        el.dataset.num = b.num;
        const img = document.createElement('img');
        img.src = state.popped ? BUBBLE_POPPED_SRC : BUBBLE_INTACT_SRC;
        img.alt = '';
        img.draggable = false;
        el.appendChild(img);
        if (state.popped) el.classList.add('popped');
        el.addEventListener('pointerdown', (ev) => {
          ev.preventDefault();
          ensureAudio();
          isDragging = true;
          try { el.releasePointerCapture(ev.pointerId); } catch (_) {}
          popBubble(b.num);
        });
        bubblesEl.appendChild(el);
        bubbleEls.set(b.num, el);
      }
    }

    // Pop burst — spray of small translucent bubble particles flying
    // outward from the pop point with randomised angles and distances.
    // Each particle uses bubble-static.png with mix-blend-mode: screen
    // so it reads as a glassy droplet against the dark backdrop, then
    // fades out as it travels (CSS keyframes drive the movement).
    function spawnBurst(cx, cy, size, container = bubblesEl) {
      const PARTICLE_COUNT = 10;
      for (let i = 0; i < PARTICLE_COUNT; i++) {
        // Spread evenly around the circle then jitter so particles
        // don't form a perfect compass-rose pattern.
        const angle = (i / PARTICLE_COUNT) * Math.PI * 2 + (Math.random() - 0.5) * 0.6;
        const dist  = size * (0.65 + Math.random() * 0.6);
        const dx = Math.cos(angle) * dist;
        const dy = Math.sin(angle) * dist;
        const ps = size * (0.18 + Math.random() * 0.18);
        const el = document.createElement('div');
        el.className = 'burst-particle';
        el.style.left   = (cx - ps / 2) + 'px';
        el.style.top    = (cy - ps / 2) + 'px';
        el.style.width  = ps + 'px';
        el.style.height = ps + 'px';
        el.style.setProperty('--bx', dx + 'px');
        el.style.setProperty('--by', dy + 'px');
        // Slight per-particle delay/duration variance breaks up the
        // synchronised feel — looks more like a real spray than a
        // mechanical explosion.
        el.style.animationDelay    = (Math.random() * 40) + 'ms';
        el.style.animationDuration = (520 + Math.random() * 180) + 'ms';
        container.appendChild(el);
        el.addEventListener('animationend', () => el.remove(), { once: true });
      }
    }

    function popBubble(num) {
      const state = bubbleStates.get(num);
      if (!state || state.popped || state.popping) return false;
      // Game-limit block: once the user has completed their
      // selected number of games, no more pops register. (The
      // outro overlay also fades in on top, but this guard handles
      // the brief window between the last row completing and the
      // overlay actually showing.)
      if (currentGame >= totalGames) return false;
      // Note: NO `gameCompleting` block here — when a row just
      // completed we let pops keep flowing; addSelected will
      // immediately advance the game state so the new pop lands
      // in the next row without the user feeling any pause.
      state.popping = true;
      const el = bubbleEls.get(num);
      if (!el) return false;

      playPop((num % 5) - 2);
      haptic(8);
      const rect = el.getBoundingClientRect();
      const stageRect = stage.getBoundingClientRect();
      spawnBurst(
        rect.left - stageRect.left + rect.width / 2,
        rect.top - stageRect.top + rect.height / 2,
        rect.width,
      );
      el.classList.add('popping');
      el.addEventListener('animationend', () => {
        state.popping = false;
        state.popped = true;
        el.classList.remove('popping');
        el.classList.add('popped');
        const img = el.querySelector('img');
        if (img) img.src = BUBBLE_POPPED_SRC;
        maybeRefillSheet();
      }, { once: true });

      addSelected(num);
      return true;
    }

    /* ── Sheet refill ──────────────────────────────────────────── */
    let refillScheduled = false;
    function allBubblesPopped() {
      if (!layout) return false;
      for (const b of layout.bubbles) {
        const s = bubbleStates.get(b.num);
        if (!s || !s.popped) return false;
      }
      return true;
    }
    function maybeRefillSheet() {
      if (refillScheduled) return;
      if (!allBubblesPopped()) return;
      refillScheduled = true;
      setTimeout(() => {
        refillScheduled = false;
        refillSheet();
      }, 280);
    }
    function refillSheet() {
      const sheetEl = document.getElementById('sheet');
      playSwoosh();
      const reset = () => {
        for (const state of bubbleStates.values()) {
          state.popped = false;
          state.popping = false;
        }
        bubbleNumPermutation = null;
        rebuild();
      };
      if (!sheetEl) { reset(); return; }
      // Phase 1: slide the popped sheet out.
      sheetEl.classList.remove('sheet-in');
      sheetEl.classList.add('sheet-out');
      setTimeout(() => {
        // Phase 2: reset state (which re-renders bubble buttons) and
        // slide the fresh sheet back in. The two animations are
        // sequenced via setTimeout so they don't race on the same
        // .animationend event.
        sheetEl.classList.remove('sheet-out');
        reset();
        void sheetEl.offsetWidth;        // reflow before re-adding class
        sheetEl.classList.add('sheet-in');
        setTimeout(() => sheetEl.classList.remove('sheet-in'), 600);
      }, 420);
    }

    /* ── Selection state ───────────────────────────────────────── */
    let currentGame = 0;
    let currentSelections = [];
    const allGames = [];
    let viewedGameIdx = 0;
    // displayedGameIdx lags behind viewedGameIdx during the row-
    // complete handoff: viewedGameIdx (and currentGame) bump up
    // the instant the 8th ball pops so logic stays correct, but
    // the count displayed on the pill only ticks over once the
    // previous row's balls have actually disappeared from screen.
    // advanceRow's hide-bank timeout updates this.
    let displayedGameIdx = 0;
    let totalGames = DEFAULT_GAMES;
    let gameCompleting = false;

    function refreshPill() {
      // Count uses displayedGameIdx (lags) so the X/Y label stays in
      // sync with what the user sees on screen. Clamped to totalGames
      // so the final row's advanceRow doesn't push it past the limit
      // before the hide timeout settles things.
      const shown = Math.min(displayedGameIdx + 1, totalGames);
      if (ctaPillCountEl) {
        ctaPillCountEl.textContent = `${shown}/${totalGames}`;
      }
      if (gameLabelEl) {
        gameLabelEl.textContent = `Game ${shown}/${totalGames}`;
      }
      if (ctaPillProgressEl) {
        /* pathLength="100" on the SVG rect normalises the perimeter to
           100 units, so the visible stroke length == the row's
           percentage complete. dashoffset 100 → empty, 0 → full ring. */
        const pct = Math.max(0, Math.min(100,
          (currentSelections.length / NUMBERS_PER_GAME) * 100));
        ctaPillProgressEl.style.strokeDasharray = '100 100';
        ctaPillProgressEl.style.strokeDashoffset = String(100 - pct);
      }
    }

    /* ── Three.js ball-tray scene ──────────────────────────────── */
    /* Single shared WebGL scene with a pool of 7 ball meshes (one per
       slot in the current game). Textures are baked per number, cached,
       and swapped onto the pool meshes on each pop. Mesh positions
       update from the slot rect measurements so the canvas can stretch
       responsively without realigning balls manually. */
    const ballScene = {
      renderer: null,
      camera:   null,
      scene:    null,
      geometry: null,
      // Two banks of NUMBERS_PER_GAME meshes (16 total). activeGroupBase
      // toggles between 0 and NUMBERS_PER_GAME each time a row
      // completes — the new row uses the fresh bank while the
      // previous bank's meshes keep their drop animations running
      // until naturally hidden by the post-advance timeout. This
      // lets new balls drop in front of still-settling previous
      // balls instead of replacing or queueing them.
      meshes:   [],
      activeGroupBase: 0,
      zCounter:        0,     // monotonically increasing — newer balls render in front
      slotCenters: [],
      animations: [],
      texCache:    new Map(),
      ballRadius:  22,
      width:  0,
      height: 0,
      raf:    null,
    };
    function getBallTexture(num, white = false) {
      // Cache key includes brand mode AND draw mode — Powerball
      // recolours all non-white balls to blue (#hue 215), so the
      // texture for ball "23" differs between Powerball and
      // Oz Lotto and they can't share a cache entry.
      const key = `${brandEnabled ? 'b' : ''}${drawMode[0]}${white ? 'w' : 'c'}${num}`;
      let t = ballScene.texCache.get(key);
      if (t) return t;
      const opts = {};
      if (brandEnabled) {
        opts.discPositions = ANTIPRISM_DISC_POSITIONS;
        opts.angularR      = 0.40;
        opts.noGradient    = true;
      }
      // Powerball: every non-white ball is BLUE. The number on the
      // ball remains its raw value (the bubble's printed num); only
      // the fill colour is recoloured.
      if (drawMode === 'powerball' && !white) {
        opts.fill      = ballFillCss(215);
        opts.textColor = numTextColor(215);
      }
      t = makeBallTexture(num, white, opts);
      ballScene.texCache.set(key, t);
      return t;
    }
    function setBrandEnabled(v) {
      if (brandEnabled === v) return;
      brandEnabled = v;
      // Drop cached textures so the next pop bakes them in the new
      // style. Dispose first so the GPU releases the old textures.
      // NOTE: in-game brand balls stay OPAQUE — the orbit balls are
      // 80% transparent over a dark-navy backdrop where that reads
      // correctly, but the tray sits over a pink/purple gradient
      // and a translucent red blends toward orange. Opaque
      // materials preserve the true hue while keeping the brand
      // TEXTURE style (flat fill, 6-disc antiprism numbering).
      for (const tex of ballScene.texCache.values()) tex.dispose();
      ballScene.texCache.clear();
    }
    /* Apply a new draw mode — updates NUMBERS_PER_GAME (8 vs 7),
       clears the texture cache (Powerball recolours non-white balls
       to blue), toggles the tray-rings class so CSS can hide the
       8th ring for Oz Lotto, and re-runs the ring-centre snapshot
       so the ball-scene aims at the new visible slot count. */
    function setDrawMode(mode) {
      if (mode !== 'powerball' && mode !== 'ozlotto') return;
      if (drawMode === mode) return;
      drawMode = mode;
      NUMBERS_PER_GAME = mode === 'powerball' ? 8 : 7;
      for (const tex of ballScene.texCache.values()) tex.dispose();
      ballScene.texCache.clear();
      // Body-level class so any descendant (tray rings, ghost rows,
      // PB label, etc.) can pick up the mode change via CSS without
      // each having its own toggle.
      document.body.classList.toggle('is-ozlotto', mode === 'ozlotto');
      // Re-measure slot centres so balls drop into the new visible
      // slot count (resizeBallScene reads the current ringEls and
      // trims to NUMBERS_PER_GAME — see its implementation). Defer
      // a frame so the body class swap has actually applied the
      // CSS grid change before we measure ring rects.
      if (ballScene.renderer) {
        requestAnimationFrame(() => resizeBallScene());
      }
    }
    function initBallScene() {
      if (!ballCanvas || !ringsEl) return;
      const renderer = new THREE.WebGLRenderer({
        canvas: ballCanvas, antialias: true, alpha: true,
      });
      renderer.setClearColor(0x000000, 0);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      const scene = new THREE.Scene();
      // No lights — MeshBasicMaterial below is unlit, so the texture's
      // raw colour shows through unattenuated. Any lit material (Std,
      // Lambert, Phong) muddies the hue regardless of ambient strength
      // because diffuse shading multiplies by a normal·light dot product
      // that's <1 for most surface fragments. The flat look this gives
      // up some 3D depth, but matches the "vibrant hex-code" spec.
      // Camera frustum gets sized to the canvas pixel dims in
      // resizeBallScene() so 1 world unit = 1 CSS pixel; the Y axis is
      // flipped (top = +H/2) to match DOM coordinates.
      const camera = new THREE.OrthographicCamera(0, 1, 1, 0, 0.1, 100);
      camera.position.z = 50;
      const geometry = new THREE.SphereGeometry(1, 32, 32);
      ballScene.renderer = renderer;
      ballScene.scene = scene;
      ballScene.camera = camera;
      ballScene.geometry = geometry;
      // Build TWO banks of MAX_NUMBERS_PER_GAME meshes (16 total) so
      // two consecutive rows can coexist briefly — previous row's
      // balls finish their drop animation in one bank while the new
      // row's pops spawn fresh meshes in the other bank. We size to
      // the MAX so the pool survives draw-mode switches without
      // rebuilding GPU resources.
      for (let i = 0; i < MAX_NUMBERS_PER_GAME * 2; i++) {
        const mat = new THREE.MeshBasicMaterial({ map: null });
        const mesh = new THREE.Mesh(geometry, mat);
        mesh.visible = false;
        scene.add(mesh);
        ballScene.meshes.push(mesh);
      }
      resizeBallScene();
      tickBallScene();
    }
    function resizeBallScene() {
      if (!ballScene.renderer || !ballCanvas) return;
      // The canvas spans the whole body via CSS `position:absolute;
      // inset:0`, so its bounding rect is the body's content area.
      // All ball positions (slots + bubble sources) are computed in
      // this same canvas-local coordinate space so the WebGL scene
      // can animate balls anywhere from stage to tray seamlessly.
      const rect = ballCanvas.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      ballScene.width = w;
      ballScene.height = h;
      ballScene.canvasRect = rect;
      ballScene.renderer.setSize(w, h, false);
      const cam = ballScene.camera;
      cam.left = 0;
      cam.right = w;
      cam.top = h;       // Y-up world; positionToWorld flips DOM y
      cam.bottom = 0;
      cam.near = 0.1;
      cam.far = 1000;
      cam.updateProjectionMatrix();
      // Snapshot each ring centre & radius in canvas-local pixel coords.
      // Slice to the ACTIVE slot count (Oz Lotto hides ring #8 via CSS,
      // so its bounding rect would collapse to 0×0 — skip it entirely
      // so the ball scene never targets a phantom slot).
      ballScene.slotCenters = ringEls.slice(0, NUMBERS_PER_GAME).map(ring => {
        const r = ring.getBoundingClientRect();
        return {
          x: r.left - rect.left + r.width / 2,
          y: r.top  - rect.top  + r.height / 2,
          r: Math.min(r.width, r.height) / 2,
        };
      });
      // Ball nearly fills the ring; 1px margin avoids subpixel clipping.
      const baseR = ballScene.slotCenters[0]?.r || 22;
      ballScene.ballRadius = Math.max(8, baseR - 1);
    }

    // Convert any DOM element's centre to canvas-local pixel coords.
    function elementCenter(el) {
      if (!el || !ballCanvas) return null;
      const r = el.getBoundingClientRect();
      const c = ballCanvas.getBoundingClientRect();
      return {
        x: r.left - c.left + r.width / 2,
        y: r.top  - c.top  + r.height / 2,
      };
    }
    function bubbleScreenPos(num) {
      return elementCenter(bubbleEls.get(num));
    }
    function tickBallScene() {
      if (!ballScene.renderer) return;
      const now = performance.now();
      // Process animations; mesh visibility / position derived per-frame.
      for (let i = ballScene.animations.length - 1; i >= 0; i--) {
        const anim = ballScene.animations[i];
        const t = Math.min(1, (now - anim.start) / anim.duration);
        const eased = easeOutCubic(t);
        // anim.meshIdx is set by spawnBallInSlot (which bank +
        // slot the animation is targeting); slotIdx is used for
        // slot-centre lookup. Fall back to slotIdx for any
        // legacy animations (e.g. slide-up-fade).
        const mIdx = (anim.meshIdx != null) ? anim.meshIdx : anim.slotIdx;
        const mesh = ballScene.meshes[mIdx];
        if (!mesh) {
          ballScene.animations.splice(i, 1);
          continue;
        }
        if (anim.kind === 'drop-in') {
          const slot = ballScene.slotCenters[anim.slotIdx];
          if (!slot) {
            ballScene.animations.splice(i, 1);
            continue;
          }
          const targetX = slot.x;
          const targetY = ballScene.height - slot.y;
          const startX  = anim.sourceX;
          const startY  = ballScene.height - anim.sourceY;
          const yProg = t * t;
          const xProg = eased;
          mesh.position.x = startX + (targetX - startX) * xProg;
          mesh.position.y = startY + (targetY - startY) * yProg;
          mesh.position.z = anim.zPos || 0;     // newer ball = higher z, renders in front
          mesh.scale.setScalar(ballScene.ballRadius);
          const spinPhase = (1 - eased) * Math.PI * 2;
          // Brand-style balls land on a different X rotation so a
          // number sits front-on (see BRAND_FINAL_ROT_X comment).
          const fx = brandEnabled ? BRAND_FINAL_ROT_X : FINAL_ROT_X;
          mesh.rotation.set(
            fx + anim.spinX * spinPhase,
            FINAL_ROT_Y + anim.spinY * spinPhase,
            0           + anim.spinZ * spinPhase,
          );
          mesh.visible = true;
          if (t >= 1) {
            mesh.position.set(targetX, targetY, anim.zPos || 0);
            mesh.rotation.set(fx, FINAL_ROT_Y, 0);
            ballScene.animations.splice(i, 1);
          }
        } else if (anim.kind === 'slide-up-fade') {
          const slot = ballScene.slotCenters[anim.slotIdx];
          if (!slot) {
            mesh.visible = false;
            ballScene.animations.splice(i, 1);
            continue;
          }
          // Active row balls drift up out of the slot (toward the bubble
          // frame) and fade their opacity to 0. The CSS ghost row picks
          // up the visual at the same screen position with a faint
          // blurred number for the persistent ghost (handed off when
          // this anim ends).
          const baseX  = slot.x;
          const baseY  = ballScene.height - slot.y;
          const upDist = ballScene.ballRadius * 2.4;
          mesh.position.x = baseX;
          mesh.position.y = baseY + upDist * eased;
          mesh.scale.setScalar(ballScene.ballRadius);
          mesh.material.opacity = 1 - eased;
          mesh.material.transparent = true;
          if (t >= 1) {
            mesh.visible = false;
            mesh.material.transparent = false;
            mesh.material.opacity = 1;
            ballScene.animations.splice(i, 1);
          }
        }
      }
      ballScene.renderer.render(ballScene.scene, ballScene.camera);
      ballScene.raf = requestAnimationFrame(tickBallScene);
    }
    function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

    /* Public ball-scene API used by game flow */
    function spawnBallInSlot(slotIdx, number, sourceX, sourceY, duration) {
      // Pick the mesh from the active bank so a row-in-progress in
      // the OTHER bank can finish its animations undisturbed.
      const meshIdx = ballScene.activeGroupBase + slotIdx;
      const mesh = ballScene.meshes[meshIdx];
      if (!mesh) return;
      const white = isPowerballSlot(slotIdx);
      const tex = getBallTexture(number, white);
      if (mesh.material.map !== tex) {
        mesh.material.map = tex;
        mesh.material.needsUpdate = true;
      }
      mesh.userData.number = number;
      mesh.userData.white = white;
      mesh.material.opacity = 1;
      mesh.material.transparent = false;
      mesh.visible = true;
      const slot = ballScene.slotCenters[slotIdx];
      const fallbackY = slot ? Math.max(0, slot.y - ballScene.ballRadius * 4) : 0;
      // Bump zCounter so newer balls always have higher z (closer to
      // camera). The depth test then naturally renders the newer
      // ball in front of any still-settling previous ball at the
      // same slot position.
      ballScene.zCounter += 0.05;
      const zPos = ballScene.zCounter;
      // Per-ball random spin axes — each ball tumbles on all three
       // axes with a random number of revolutions and direction. The
       // rotation interpolates these spins from their initial value
       // toward 0 as the ball settles, so they always land in the
       // same final pose (FINAL_ROT_X/Y/Z = 0) regardless of how
       // many random revs they accumulated during the fall.
      const spinSign = () => (Math.random() < 0.5 ? -1 : 1);
      const spinX = SPIN_REVOLUTIONS * (0.8 + Math.random() * 0.6) * spinSign();
      const spinY = SPIN_REVOLUTIONS * (0.4 + Math.random() * 0.8) * spinSign();
      const spinZ = SPIN_REVOLUTIONS * (0.2 + Math.random() * 0.4) * spinSign();
      ballScene.animations.push({
        kind: 'drop-in',
        slotIdx,
        meshIdx,
        zPos,
        number,
        sourceX: Number.isFinite(sourceX) ? sourceX : (slot ? slot.x : 0),
        sourceY: Number.isFinite(sourceY) ? sourceY : fallbackY,
        spinX, spinY, spinZ,
        start: performance.now(),
        duration: Number.isFinite(duration) ? duration : SPIN_DURATION_MS,
      });
    }
    function clearAllBalls(animate = true) {
      const now = performance.now();
      for (let i = 0; i < ballScene.meshes.length; i++) {
        const mesh = ballScene.meshes[i];
        if (!mesh.visible) continue;
        if (animate) {
          ballScene.animations.push({
            kind: 'slide-up-fade',
            slotIdx: i,
            start: now + i * 25,
            duration: 380,
          });
        } else {
          mesh.visible = false;
        }
      }
    }

    // Append a new ghost row for the completed game and animate it up
    // into the rest position (blur 4, opacity 0.6). Any rows already
    // resting get marked .ghost-leaving so they animate further up
    // and fade out — the visual is a "rolling" stack where every
    // game's numbers float up and disappear behind the one before.
    function populateGhostRow(nums) {
      if (!ghostRowEl) return;
      // Mark previous resting/entering rows as leaving (the new arrival
      // pushes them up + out). leaving rows are removed from the DOM
      // once their transition finishes.
      for (const row of ghostRowEl.querySelectorAll('.ghost-row:not(.ghost-leaving)')) {
        row.classList.add('ghost-leaving');
        row.classList.remove('ghost-rested');
        // Fallback removal in case transitionend doesn't fire.
        setTimeout(() => row.remove(), 900);
      }

      const row = document.createElement('div');
      row.className = 'ghost-row';
      nums.forEach((n, i) => {
        const isPowerball = isPowerballSlot(i);
        // Powerball mode forces every non-white ghost to render
        // blue (hue 215), matching the in-game ball recolour.
        const h = isPowerball
          ? null
          : (drawMode === 'powerball' ? 215 : ballHue(n));
        const cell = document.createElement('div');
        cell.className = 'ghost';
        cell.textContent = String(n);
        cell.style.background = isPowerball
          ? 'radial-gradient(circle at 35% 35%, #ffffff, #c8c8d4)'
          : `radial-gradient(circle at 35% 35%, hsl(${h}, 80%, 55%), hsl(${h}, 85%, 32%))`;
        cell.style.color = isPowerball ? '#0b1140' : numTextColor(h);
        row.appendChild(cell);
      });
      ghostRowEl.appendChild(row);
      // Force a reflow so the browser picks up the initial state
      // before the `.ghost-rested` class is added — otherwise the
      // transition would start mid-flight from the rested state and
      // we'd see no animation.
      void row.offsetWidth;
      row.classList.add('ghost-rested');
      row.addEventListener('transitionend', function onEnd(e) {
        if (e.propertyName !== 'transform') return;
        if (row.classList.contains('ghost-leaving')) row.remove();
        row.removeEventListener('transitionend', onEnd);
      });
    }

    /* ── Game flow ─────────────────────────────────────────────── */
    function triggerGameCompleteCelebration() {
      if (!gameMessageEl || !gameMessageTextEl) return;
      gameMessageTextEl.textContent = `GAME ${currentGame + 2}`;
      if (trayEl) {
        const h = trayEl.getBoundingClientRect().height;
        if (h > 0) gameMessageEl.style.setProperty('--tray-h', h + 'px');
      }
      gameMessageEl.classList.remove('is-active');
      void gameMessageEl.offsetWidth;
      gameMessageEl.classList.add('is-active');
      gameMessageEl.addEventListener('animationend', function onEnd() {
        gameMessageEl.classList.remove('is-active');
        gameMessageEl.removeEventListener('animationend', onEnd);
      });
    }

    // Swap to the OTHER mesh bank so new pops drop into a fresh
    // set of meshes while the previous bank's balls finish their
    // own drop animations. Once the previous bank's drops have had
    // time to settle, fire the visible handoff all together:
    // hide the previous bank, populate the ghost row, and tick the
    // count over. Doing all three at the same moment keeps the
    // user's perception in sync — balls disappear, ghosts appear,
    // the X/Y label moves on, all on one frame.
    function advanceRow(completedRow) {
      if (!gameCompleting) return;
      gameCompleting = false;
      const prevGroupBase = ballScene.activeGroupBase;
      ballScene.activeGroupBase =
        prevGroupBase === 0 ? NUMBERS_PER_GAME : 0;
      currentGame++;
      currentSelections = [];
      viewedGameIdx = currentGame;
      const hideAfter = SPIN_DURATION_MS + 200;
      setTimeout(() => {
        for (let i = 0; i < NUMBERS_PER_GAME; i++) {
          const m = ballScene.meshes[prevGroupBase + i];
          if (m) m.visible = false;
        }
        populateGhostRow(completedRow);
        displayedGameIdx = viewedGameIdx;
        refreshPill();
      }, hideAfter);
    }

    function addSelected(num) {
      // Powerball mode only: the last slot is the "powerball" —
      // override the bubble's number with a random value from
      // 1..25 that isn't already in this row. Oz Lotto has no
      // powerball; every slot is a regular multi-colour ball.
      const isPowerball = isPowerballSlot(currentSelections.length);
      if (isPowerball) {
        const exclude = new Set(currentSelections);
        const candidates = [];
        for (let i = 1; i <= 25; i++) {
          if (!exclude.has(i)) candidates.push(i);
        }
        if (candidates.length) {
          num = candidates[Math.floor(Math.random() * candidates.length)];
        }
      }

      currentSelections.push(num);
      viewedGameIdx = currentGame;
      const slotIdx = currentSelections.length - 1;
      // Spawn the ball at the bubble's screen position so it appears
      // to fall out of the popped bubble down to its slot. During
      // fast select (autoPlayQueue > 0) the drop animation is halved
      // so the whole flow runs at ~2× speed.
      const src = bubbleScreenPos(num);
      const dropDur = autoPlayQueue > 0 ? SPIN_DURATION_MS / 2 : SPIN_DURATION_MS;
      spawnBallInSlot(slotIdx, num, src?.x, src?.y, dropDur);

      if (currentSelections.length >= NUMBERS_PER_GAME) {
        gameCompleting = true;
        const completedRow = [...currentSelections];
        allGames[currentGame] = completedRow;
        playRowComplete();
        triggerGameCompleteCelebration();
        // Advance immediately — no settle delay. The mesh-bank swap
        // inside advanceRow lets the just-popped 8th ball finish
        // its drop in the OLD bank while any subsequent pop drops
        // a brand-new ball into the NEW bank.
        advanceRow(completedRow);
        // Full-completion check: if the user has finished the last
        // game of their selection, stop the fast-select cascade
        // and fade in the outro overlay after enough time for the
        // last drop animation to land.
        if (currentGame >= totalGames) {
          autoPlayQueue = 0;
          setFastSelectActive(false);
          setTimeout(showOutro, SPIN_DURATION_MS + 200);
        } else if (autoPlayQueue > 0) {
          autoPlayQueue--;
          if (autoPlayQueue > 0 || currentGame < totalGames) {
            const fast = autoPlayQueue > 0;
            const nextRowWait = fast ? 180 : 360;
            const myGen = autoFillCancelGen;
            setTimeout(() => {
              if (autoFillCancelGen !== myGen) return;
              autoFillCurrentRow();
            }, nextRowWait);
          } else {
            // Cascade ran out — flip the button back.
            setFastSelectActive(false);
          }
        }
        // No refreshPill() here — advanceRow's deferred timeout
        // does it once the previous row's balls have hidden, so
        // the X/Y count stays in sync with what's on screen.
        return;
      }
      refreshPill();
    }

    /* ── Bottom controls ───────────────────────────────────────── */
    // Full reset: refresh the sheet (animated slide-out/in), clear all
    // game progress, ghost rows and active balls. Called from the
    // Settings modal's Reset button.
    function resetAll() {
      autoPlayQueue = 0;
      autoFillCancelGen++;       // invalidate any in-flight cascade
      setFastSelectActive(false);
      gameCompleting = false;
      hideOutro();
      currentGame = 0;
      currentSelections = [];
      viewedGameIdx = 0;
      displayedGameIdx = 0;
      allGames.length = 0;
      // Hide WebGL balls instantly (clearAllBalls iterates all 16
      // meshes across both banks). Reset bank pointer + z counter.
      clearAllBalls(false);
      ballScene.activeGroupBase = 0;
      ballScene.zCounter = 0;
      // Drop persistent ghost rows.
      if (ghostRowEl) ghostRowEl.innerHTML = '';
      // Refill the sheet with the existing animation hook.
      refillSheet();
      refreshPill();
    }

    // The bottom-bar … button now opens the Settings modal instead of
    // resetting directly. Reset moved to a button inside the modal.
    const settingsBackdropEl     = document.getElementById('settingsBackdrop');
    const settingsCloseEl        = document.getElementById('settingsClose');
    const settingsAudioEl        = document.getElementById('settingsAudio');
    const settingsResetEl        = document.getElementById('settingsReset');
    const settingsFreshSheetEl   = document.getElementById('settingsFreshSheet');
    const settingsJumpTicketEl   = document.getElementById('settingsJumpToTicket');
    const settingsExitEl         = document.getElementById('settingsExit');
    const settingsHowToEl        = document.getElementById('settingsHowToPlay');
    const settingsHowtoBackEl    = document.getElementById('settingsHowtoBack');
    function refreshSettingsLabels() {
      if (settingsAudioEl) {
        settingsAudioEl.classList.toggle('is-off', !audioEnabled);
        const s = settingsAudioEl.querySelector('.settings-toggle-state');
        if (s) s.textContent = audioEnabled ? 'On' : 'Off';
      }
    }
    function openSettings() {
      if (!settingsBackdropEl) return;
      refreshSettingsLabels();
      settingsBackdropEl.classList.add('visible');
      playSheetSwoosh();
    }
    function closeSettings() {
      if (!settingsBackdropEl) return;
      settingsBackdropEl.classList.remove('visible');
      // Reset sub-panel so the next open shows the menu (not the
      // How to Play screen the user was last on).
      settingsBackdropEl.classList.remove('is-howto');
      // Kill the how-to demo loop + reset its visuals so a future
      // re-entry starts from a clean bubble-visible state.
      stopHowtoLoop();
    }
    if (ctaExitEl) ctaExitEl.addEventListener('click', openSettings, { signal });
    if (settingsCloseEl) settingsCloseEl.addEventListener('click', closeSettings, { signal });
    if (settingsHowtoBackEl) settingsHowtoBackEl.addEventListener('click', () => {
      // "Back to Popping" dismisses the whole settings modal so the
      // user lands back on the bubble grid (closeSettings also strips
      // .is-howto so reopening starts on the menu again).
      closeSettings();
    }, { signal });
    if (settingsBackdropEl) settingsBackdropEl.addEventListener('click', (e) => {
      // Click on the backdrop (outside the modal panel) closes.
      if (e.target === settingsBackdropEl) closeSettings();
    }, { signal });
    // Jump to ticket — fade in the outro overlay (for now). Hook the
    // real ticket view here when it's built.
    if (settingsJumpTicketEl) settingsJumpTicketEl.addEventListener('click', () => {
      closeSettings();
      showOutro();
    }, { signal });
    // Start over — wipe game state + fresh sheet animation.
    if (settingsResetEl) settingsResetEl.addEventListener('click', () => {
      resetAll();
      closeSettings();
    }, { signal });
    // Fresh sheet — slide out / slide in a new sheet of bubbles
    // WITHOUT touching the user's picked numbers, current game
    // counter or ghost row. Just gives them a refilled board.
    if (settingsFreshSheetEl) settingsFreshSheetEl.addEventListener('click', () => {
      refillSheet();
      closeSettings();
    }, { signal });
    if (settingsAudioEl) settingsAudioEl.addEventListener('click', () => {
      audioEnabled = !audioEnabled;
      refreshSettingsLabels();
    }, { signal });
    if (settingsHowToEl) settingsHowToEl.addEventListener('click', () => {
      // Slide the How to Play panel in from the right; menu slides
      // off to the left. Stay open; Back to Popping or the X close
      // the dialog.
      settingsBackdropEl?.classList.add('is-howto');
      // Kick off the bubble → ball reveal demo loop.
      startHowtoLoop();
    }, { signal });
    if (settingsExitEl) settingsExitEl.addEventListener('click', () => {
      // Exit Game = reset progress + bring the intro screen back.
      // The intro was hidden (not removed) by Get popping, so we
      // can re-show it just by stripping .intro-hide and resuming
      // the intro ball's rAF.
      closeSettings();
      resetAll();
      if (introEl) {
        introEl.classList.remove('intro-hide');
        if (resumeIntroBall) resumeIntroBall();
      }
    }, { signal });

    // Pill (>> ) — auto-pops enough bubbles to complete the current row
    // (one game = NUMBERS_PER_GAME bubbles). Re-tap to advance another
    // row; for filling all remaining games at once, use Fast select.
    if (ctaPillEl) ctaPillEl.addEventListener('click', () => {
      ensureAudio();
      autoFillCurrentRow();
    }, { signal });

    /* "Fast select" — fill the current row and queue up enough rows
       to complete `totalGames`. autoPlayQueue is decremented after each
       row completes (in addSelected) so successive rows auto-trigger.
       The button doubles as a Stop: once started, its label/icon flip
       to Stop and a second click aborts the cascade. Abort uses a
       generation counter so any setTimeouts that have already been
       scheduled (per-pop cascade + per-row chain) bail when they
       discover their generation is stale. */
    let autoPlayQueue = 0;
    let fastSelectActive = false;
    let autoFillCancelGen = 0;
    function setFastSelectActive(active) {
      if (active === fastSelectActive) return;
      fastSelectActive = active;
      if (!ctaFastSelectEl) return;
      ctaFastSelectEl.classList.toggle('is-stop', active);
      ctaFastSelectEl.setAttribute(
        'aria-label',
        active ? 'Stop fast select' : 'Fast select all remaining games',
      );
      const label = ctaFastSelectEl.querySelector('.ctl-fast-label');
      if (label) label.textContent = active ? 'Stop' : 'Fast select';
    }
    if (ctaFastSelectEl) ctaFastSelectEl.addEventListener('click', () => {
      ensureAudio();
      if (fastSelectActive) {
        // Abort: bump the gen so any in-flight setTimeouts skip,
        // zero the queue so addSelected doesn't schedule the next
        // row, and flip the button back.
        autoFillCancelGen++;
        autoPlayQueue = 0;
        setFastSelectActive(false);
        return;
      }
      // Start a fresh cascade.
      const remaining = Math.max(0, totalGames - currentGame - 1);
      if (remaining <= 0 && (NUMBERS_PER_GAME - currentSelections.length) <= 0) {
        return; // nothing to do
      }
      autoPlayQueue = remaining;
      setFastSelectActive(true);
      autoFillCurrentRow();
    }, { signal });

    function autoFillCurrentRow() {
      // Bail if the user has already hit the game limit (Fast select
      // / Skip cascades shouldn't keep firing past it).
      if (currentGame >= totalGames) {
        setFastSelectActive(false);
        return;
      }
      const needed = NUMBERS_PER_GAME - currentSelections.length;
      if (needed <= 0) return;
      const available = [];
      for (const b of layout.bubbles) {
        const s = bubbleStates.get(b.num);
        if (s && !s.popped && !s.popping && !currentSelections.includes(b.num)) {
          available.push(b.num);
        }
      }
      // Fisher-Yates partial shuffle of available
      for (let i = available.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [available[i], available[j]] = [available[j], available[i]];
      }
      const popInterval = autoPlayQueue > 0 ? 55 : 110;
      const toPick = Math.min(needed, available.length);
      // Snapshot the cancel generation so every setTimeout below
      // can bail if a Stop click invalidates the cascade.
      const myGen = autoFillCancelGen;

      if (toPick === 0) {
        setTimeout(() => {
          if (autoFillCancelGen !== myGen) return;
          autoFillCurrentRow();
        }, 280 + 420 + 540 + 80);
        return;
      }

      const picks = available.slice(0, toPick);
      picks.forEach((n, k) => setTimeout(() => {
        if (autoFillCancelGen !== myGen) return;
        popBubble(n);
      }, k * popInterval));

      if (toPick < needed) {
        const lastPopAt = (toPick - 1) * popInterval;
        const refillTotalMs = 320 + 280 + 420 + 540 + 100;
        setTimeout(() => {
          if (autoFillCancelGen !== myGen) return;
          autoFillCurrentRow();
        }, lastPopAt + refillTotalMs);
      }
    }

    /* ── Toast ─────────────────────────────────────────────────── */
    let toastTimer = null;
    function showToast(msg) {
      if (!toastEl) return;
      toastEl.textContent = msg;
      toastEl.classList.add('visible');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toastEl.classList.remove('visible'), 1800);
    }

    /* ── Boot + resize ─────────────────────────────────────────── */
    let layout;
    function rebuild() {
      layout = computeLayout();
      renderBubbles(layout);
    }
    window.addEventListener('resize', () => {
      rebuild();
      resizeBallScene();
    }, { signal });
    // iOS PWA: after "Add to Home Screen", the viewport, safe-area
    // insets and bottom toolbar height can shift in ways that don't
    // always fire `resize`. ResizeObserver on the canvas + the rings
    // strip catches every layout-driven dimension change so the slot
    // centres re-sync and balls stay aligned with their holders.
    let ro = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => {
        // rebuild() depends on stage size, resizeBallScene on canvas +
        // rings. Cheap to call both.
        rebuild();
        resizeBallScene();
      });
      if (ballCanvas) ro.observe(ballCanvas);
      if (ringsEl)    ro.observe(ringsEl);
      if (stage)      ro.observe(stage);
    }
    // orientation + page-visibility changes too — Safari sometimes
    // skips the resize event during these but the layout has changed.
    window.addEventListener('orientationchange', () => {
      rebuild(); resizeBallScene();
    }, { signal });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) { rebuild(); resizeBallScene(); }
    }, { signal });

    rebuild();
    initBallScene();
    refreshPill();

    /* Device-tilt parallax for the bubble sheet. The first orientation
       event seeds the "neutral" angle so the user's natural hold
       position reads as no tilt; subsequent events drive a clamped
       small rotation of the .sheet-tilt wrapper.

       iOS 13+ Safari requires DeviceOrientationEvent.requestPermission
       to be called *synchronously* inside a user-gesture handler. We
       therefore:
         1. Attach the gesture handler at *capture* phase so it runs
            before any inner handler (e.g. a bubble button's pointerdown
            that calls preventDefault).
         2. Call requestPermission() synchronously — no awaits before
            it — so the gesture context is intact.
         3. Attach the orientation listener inside the .then() once
            permission resolves.
         4. Fall through to a plain `addEventListener` when the
            permission API is absent (Android, desktop sensors). */
    let tiltNeutral = null;
    let tiltEnabled = false;
    const sheetTiltEl = document.getElementById('sheetTilt');
    // Shared, normalized tilt (-1..1) consumed by the outro ball scene
    // for parallax. Written by onTilt; read by the outro rAF tick.
    const outroTiltN = { x: 0, y: 0 };
    function onTilt(e) {
      if (e.beta == null || e.gamma == null || !sheetTiltEl) return;
      if (!tiltNeutral) tiltNeutral = { beta: e.beta, gamma: e.gamma };
      const db = e.beta  - tiltNeutral.beta;   // pitch (forward/back)
      const dg = e.gamma - tiltNeutral.gamma;  // roll  (left/right)
      const MAX = 6;
      const tiltX = Math.max(-MAX, Math.min(MAX, -db * (MAX / 22)));
      const tiltY = Math.max(-MAX, Math.min(MAX,  dg * (MAX / 22)));
      sheetTiltEl.style.setProperty('--tilt-x', tiltX.toFixed(2) + 'deg');
      sheetTiltEl.style.setProperty('--tilt-y', tiltY.toFixed(2) + 'deg');
      // Normalize for outro parallax. Negate so the balls shift
      // OPPOSITE the phone tilt — reads as "looking past" them
      // toward a deeper scene, classic window-parallax convention.
      outroTiltN.x = -tiltY / MAX;
      outroTiltN.y = -tiltX / MAX;
    }
    function attachOrientationListener() {
      if (tiltEnabled) return;
      window.addEventListener('deviceorientation', onTilt);
      tiltEnabled = true;
    }
    function enableTiltOnGesture() {
      if (tiltEnabled) return;
      if (typeof DeviceOrientationEvent === 'undefined') return;
      // Call requestPermission SYNCHRONOUSLY in the gesture handler —
      // do NOT use await here; the gesture context dies on the first
      // await tick and iOS silently drops the permission dialog.
      if (typeof DeviceOrientationEvent.requestPermission === 'function') {
        DeviceOrientationEvent.requestPermission()
          .then((result) => {
            if (result === 'granted') attachOrientationListener();
          })
          .catch(() => { /* denied or API failure */ });
      } else {
        attachOrientationListener();
      }
    }
    // Tilt is opted-in from either the intro screen toggle or the
    // settings modal toggle — both are user-gesture click handlers, so
    // they can call enableTiltOnGesture (and the iOS permission
    // request) directly. No window-level listeners needed.
    function disableTilt() {
      if (!tiltEnabled) return;
      window.removeEventListener('deviceorientation', onTilt);
      tiltEnabled = false;
      tiltNeutral = null;
      sheetTiltEl?.style.setProperty('--tilt-x', '0deg');
      sheetTiltEl?.style.setProperty('--tilt-y', '0deg');
      outroTiltN.x = 0;
      outroTiltN.y = 0;
    }

    /* ── Intro overlay ─────────────────────────────────────────── */
    const introEl       = document.getElementById('intro');
    const introStartEl  = document.getElementById('introStart');
    const introAudioEl  = document.getElementById('introAudio');
    const introTiltEl   = document.getElementById('introTilt');
    const introBrandEl  = document.getElementById('introBrand');
    const introGamesEl  = document.getElementById('introGames');
    const introDrawsEl  = document.getElementById('introDraws');

    /* ── Outro overlay ─────────────────────────────────────────── */
    const outroEl     = document.getElementById('outro');
    const outroViewEl = document.getElementById('outroViewTicket');
    function showOutro() {
      if (!outroEl) return;
      outroEl.setAttribute('aria-hidden', 'false');
      outroEl.classList.add('outro-show');
      playSheetSwoosh();
      if (startOutroBalls) startOutroBalls();
    }
    function hideOutro() {
      if (!outroEl) return;
      outroEl.classList.remove('outro-show');
      outroEl.setAttribute('aria-hidden', 'true');
      if (stopOutroBalls) stopOutroBalls();
    }

    /* Intro hero ball — a separate Three.js scene drawing one ball
       (number 35) inside the bubble cutout, slowly spinning on Y.
       Reuses makeBallTexture() so we get the same look as in-game
       balls. The intro overlay is HIDDEN (not removed) when the
       user starts the game; pause/resume let us stop the rAF while
       hidden and resume it if the user re-opens the intro via the
       settings modal's Exit Game button. Fully disposed only on
       component unmount. */
    let disposeIntroBall = null;
    let pauseIntroBall   = null;
    let resumeIntroBall  = null;
    (function initIntroBall() {
      const introBallCanvas = document.getElementById('introBallCanvas');
      if (!introBallCanvas) return;
      const renderer = new THREE.WebGLRenderer({
        canvas: introBallCanvas, antialias: true, alpha: true,
      });
      renderer.setClearColor(0x000000, 0);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      function sizeTo() {
        const r = introBallCanvas.getBoundingClientRect();
        const w = Math.max(1, Math.round(r.width));
        const h = Math.max(1, Math.round(r.height));
        renderer.setSize(w, h, false);
        camera.left = -w / 2; camera.right = w / 2;
        camera.top  =  h / 2; camera.bottom = -h / 2;
        camera.updateProjectionMatrix();
        // Ball sits at ~62% of the bubble's inner diameter — leaves
        // room for the bubble's edge glow / rim to read around it.
        mesh.scale.setScalar(Math.min(w, h) * 0.31);
      }
      const scene  = new THREE.Scene();
      const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 2000);
      // Camera positioned FAR outside the largest sphere we'll
      // render (ball radius scales with canvas; up to ~80 px).
      // Previously camera.position.z = 50 put the camera INSIDE the
      // sphere → back-face culling hid the whole front, leaving only
      // a thin ring where the sphere passed the camera plane (the
      // "donut hole" bug). Orthographic projection means moving the
      // camera back doesn't change apparent size.
      camera.position.z = 800;

      // Lighting temporarily disabled — using MeshBasicMaterial below
      // so the texture renders unlit (pure pink at 100% saturation,
      // no light direction or shadow). Re-enable by adding the
      // AmbientLight + DirectionalLight pair back and swapping to
      // MeshStandardMaterial with emissive matching the fill.

      const geometry = new THREE.SphereGeometry(1, 64, 64);
      // 6-disc antiprism layout so a "35" is visible from any angle
      // as the ball tumbles. noGradient: true skips the baked sheen
      // — we want pure flat colour, the numbers being the only
      // surface variation.
      const tex = makeBallTexture(35, false, {
        fill: '#EF40D5',
        textColor: '#ffffff',
        discPositions: ANTIPRISM_DISC_POSITIONS,
        angularR: 0.40,
        noGradient: true,
      });
      // Three.js r155+ defaults the renderer's output to SRGBColorSpace.
      // CanvasTexture defaults to NoColorSpace, which makes the
      // renderer treat the canvas's sRGB-encoded pixels as if they
      // were linear-space values — lightens everything noticeably.
      // Tagging the texture as SRGB tells Three.js to convert to
      // linear for math and back to sRGB on output, so the rendered
      // pixel == the source hex.
      tex.colorSpace = THREE.SRGBColorSpace;
      const mat = new THREE.MeshBasicMaterial({ map: tex });
      const mesh = new THREE.Mesh(geometry, mat);
      mesh.rotation.set(FINAL_ROT_X, FINAL_ROT_Y, 0);
      scene.add(mesh);
      sizeTo();
      const ro = (typeof ResizeObserver !== 'undefined')
        ? new ResizeObserver(sizeTo) : null;
      if (ro) ro.observe(introBallCanvas);
      // Multi-axis auto-tumble with periodic random direction
       // changes. While the user is dragging, auto-tumble pauses
       // and rotation comes directly from pointer delta; on
       // release, the drag's last velocity carries into the
       // auto-tumble lerp so motion stays continuous.
      let vx = 0.006, vy = 0.012, vz = 0.004;
      let tx = vx,    ty = vy,    tz = vz;
      let lastShuffle = 0;
      const SHUFFLE_EVERY = 2500;            // ms
      const MAX_SPEED    = 0.022;            // rad / frame
      const LERP         = 0.04;             // toward target per frame
      function shuffle() {
        const rand = () => (Math.random() - 0.5) * 2 * MAX_SPEED;
        tx = rand(); ty = rand(); tz = rand();
      }

      // ── Drag handling ──
      const dragEl = document.getElementById('introDragSurface');
      let dragging = false;
      let lastDragX = 0, lastDragY = 0;
      let lastDragT = 0;
      const DRAG_ROT_GAIN = 0.012;           // rad per pixel of drag
      if (dragEl) {
        dragEl.addEventListener('pointerdown', (ev) => {
          dragging = true;
          dragEl.classList.add('dragging');
          dragEl.setPointerCapture(ev.pointerId);
          lastDragX = ev.clientX;
          lastDragY = ev.clientY;
          lastDragT = performance.now();
          // Pause auto-shuffle while dragging.
          vx = vy = vz = 0;
        }, { signal });
        dragEl.addEventListener('pointermove', (ev) => {
          if (!dragging) return;
          const dx = ev.clientX - lastDragX;
          const dy = ev.clientY - lastDragY;
          const now = performance.now();
          const dt = Math.max(1, now - lastDragT);
          // Horizontal drag → Y rotation, vertical drag → X.
          mesh.rotation.y += dx * DRAG_ROT_GAIN;
          mesh.rotation.x += dy * DRAG_ROT_GAIN;
          // Capture velocity for momentum after release.
          vy = (dx * DRAG_ROT_GAIN) * (16 / dt);
          vx = (dy * DRAG_ROT_GAIN) * (16 / dt);
          vz = 0;
          lastDragX = ev.clientX;
          lastDragY = ev.clientY;
          lastDragT = now;
        }, { signal });
        const endDrag = (ev) => {
          if (!dragging) return;
          dragging = false;
          dragEl.classList.remove('dragging');
          try { dragEl.releasePointerCapture(ev.pointerId); } catch (_) {}
          // Clamp residual velocity so a wild swipe doesn't spin
          // forever before the auto-tumble lerps it down.
          const cap = MAX_SPEED * 3;
          vx = Math.max(-cap, Math.min(cap, vx));
          vy = Math.max(-cap, Math.min(cap, vy));
          // Trigger an immediate shuffle so the auto-tumble takes
          // back over with a new direction.
          lastShuffle = performance.now() - SHUFFLE_EVERY;
        };
        dragEl.addEventListener('pointerup',     endDrag, { signal });
        dragEl.addEventListener('pointercancel', endDrag, { signal });
      }

      let raf = null;
      let stopped = false;
      function tick(now) {
        if (stopped) { raf = null; return; }
        raf = requestAnimationFrame(tick);
        if (!dragging) {
          if (!lastShuffle || now - lastShuffle > SHUFFLE_EVERY) {
            shuffle();
            lastShuffle = now;
          }
          vx += (tx - vx) * LERP;
          vy += (ty - vy) * LERP;
          vz += (tz - vz) * LERP;
          mesh.rotation.x += vx;
          mesh.rotation.y += vy;
          mesh.rotation.z += vz;
        }
        renderer.render(scene, camera);
      }
      raf = requestAnimationFrame(tick);
      pauseIntroBall = () => {
        if (raf) { cancelAnimationFrame(raf); raf = null; }
      };
      resumeIntroBall = () => {
        if (!raf && !stopped) {
          lastShuffle = 0;          // force a fresh shuffle on resume
          raf = requestAnimationFrame(tick);
        }
      };
      disposeIntroBall = () => {
        stopped = true;
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        ro?.disconnect();
        geometry.dispose();
        tex.dispose();
        mat.dispose();
        renderer.dispose();
      };
    })();

    /* How-to-play hero — a small Three.js ball that sits in the same
       84×84 box as the .settings-howto-bubble PNG. Hidden by default;
       the loop driver below fades the bubble out, fades this canvas
       in, lets it spin for 3 s, then fades it back out for the next
       cycle. Steady Y-axis spin only — no drag, no shuffle. */
    let disposeHowtoBall = null;
    let startHowtoBallSpin = null;
    let stopHowtoBallSpin  = null;
    (function initHowtoBall() {
      const cvs = document.getElementById('settingsHowtoBallCanvas');
      if (!cvs) return;
      const renderer = new THREE.WebGLRenderer({
        canvas: cvs, antialias: true, alpha: true,
      });
      renderer.setClearColor(0x000000, 0);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      const scene  = new THREE.Scene();
      const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 2000);
      // Camera well outside the sphere so back-face culling never
      // eats the front (same trick as the intro hero).
      camera.position.z = 800;
      const geometry = new THREE.SphereGeometry(1, 64, 64);
      // Purple number "5" — matches the design reference for the
      // How to Play sequence. noGradient: true keeps it flat.
      const tex = makeBallTexture(5, false, {
        fill: '#9951DB',
        textColor: '#ffffff',
        discPositions: ANTIPRISM_DISC_POSITIONS,
        angularR: 0.40,
        noGradient: true,
      });
      tex.colorSpace = THREE.SRGBColorSpace;
      const mat  = new THREE.MeshBasicMaterial({ map: tex });
      const mesh = new THREE.Mesh(geometry, mat);
      mesh.rotation.set(0, 0, 0);
      scene.add(mesh);
      function sizeTo() {
        const r = cvs.getBoundingClientRect();
        const w = Math.max(1, Math.round(r.width));
        const h = Math.max(1, Math.round(r.height));
        renderer.setSize(w, h, false);
        camera.left = -w / 2; camera.right = w / 2;
        camera.top  =  h / 2; camera.bottom = -h / 2;
        camera.updateProjectionMatrix();
        // Sized to roughly match the visible bubble PNG's core so
        // the reveal reads as the bubble TURNING INTO the ball, not
        // a shrunken ball appearing inside the bubble's footprint.
        mesh.scale.setScalar(Math.min(w, h) * 0.44);
      }
      sizeTo();
      const ro = (typeof ResizeObserver !== 'undefined')
        ? new ResizeObserver(sizeTo) : null;
      if (ro) ro.observe(cvs);
      let raf = null;
      let stopped = false;
      function tick() {
        if (stopped) { raf = null; return; }
        raf = requestAnimationFrame(tick);
        mesh.rotation.y += 0.045;          // steady spin
        renderer.render(scene, camera);
      }
      startHowtoBallSpin = () => {
        if (!raf && !stopped) {
          // Re-measure on each reveal — the modal/panel may have
          // mounted with 0 size if the user opens settings for the
          // first time, and we want crisp pixels on the canvas.
          sizeTo();
          raf = requestAnimationFrame(tick);
        }
      };
      stopHowtoBallSpin = () => {
        if (raf) { cancelAnimationFrame(raf); raf = null; }
      };
      // Render one frame so the texture is on the canvas immediately
      // (otherwise the first reveal would briefly show a blank canvas
      // before the rAF tick lands a frame).
      renderer.render(scene, camera);
      disposeHowtoBall = () => {
        stopped = true;
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        ro?.disconnect();
        geometry.dispose();
        tex.dispose();
        mat.dispose();
        renderer.dispose();
      };
    })();

    /* Outro hero — three spinning lotto balls anchored to the top of
       the "All done, pop star." overlay. One Three.js scene + one
       orthographic camera; each ball is a mesh with its own texture,
       spin rate, base position, and parallax-depth multiplier. The
       rAF loop runs only while the outro is visible (start/stop are
       wired into show/hideOutro) so we're not burning frames on the
       game screen. */
    let disposeOutroBalls = null;
    let startOutroBalls   = null;
    let stopOutroBalls    = null;
    (function initOutroBalls() {
      const cvs = document.getElementById('outroBallsCanvas');
      if (!cvs) return;
      const renderer = new THREE.WebGLRenderer({
        canvas: cvs, antialias: true, alpha: true,
      });
      renderer.setClearColor(0x000000, 0);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      const scene  = new THREE.Scene();
      const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 2000);
      camera.position.z = 800;

      // Six balls evenly distributed around a single ring that's
      // tilted ~30° forward at the bottom so we see it from above.
      // Each ball spins on its own axis while the whole ring rotates
      // around its center. Numbers 1-6 give six distinct hues from
      // HUE_MAP (red/yellow/green/cyan/blue/purple). The depth-axis
      // ball position is used both for back-to-front render sorting
      // (transparency layering) and for a manual scale multiplier
      // (close balls bigger, far balls smaller).
      const RING_BALL_COUNT  = 6;
      const RING_RADIUS_K    = 0.36;     // ring radius as fraction of min(w,h)
      const ORBIT_SPEED      = 0.010;    // rad/frame → ~10 s per full orbit
      const RING_TILT        = Math.PI / 6;   // 30° forward at the bottom
      const RING_TILT_COS    = Math.cos(RING_TILT);
      const RING_TILT_SIN    = Math.sin(RING_TILT);
      // Per-ball scale = SCALE_BASE + zNorm * SCALE_AMP where
      // zNorm ∈ [-1, +1] is the ball's depth fraction along the
      // tilt axis. SCALE_BASE 1.0 keeps the side balls at nominal
      // size; ±0.45 puts the front ball ~45% bigger than nominal
      // and the back ball ~45% smaller.
      const SCALE_BASE = 1.00;
      const SCALE_AMP  = 0.45;
      const ringSpecs = Array.from({ length: RING_BALL_COUNT }, (_, i) => {
        const num = i + 1;
        // Ball #1 would normally map to red (HUE_MAP[0]=4); override
        // to pink (325) so the ring reads softer against the dark
        // navy backdrop and matches the brand palette better.
        const hue = num === 1 ? 325 : HUE_MAP[(num - 1) % HUE_MAP.length];
        return {
          num,
          hue,
          // Start with the foreground ball at the bottom-front of
          // the ring so the layout reads correctly from frame 1.
          angleOffset: (i / RING_BALL_COUNT) * Math.PI * 2 - Math.PI / 2,
          scaleK: 0.10,                  // base radius fraction of min(w,h)
          spinRate: 0.018 + (i % 3) * 0.004,
          depth: 0.45,                   // tilt-parallax multiplier
        };
      });

      const geometry = new THREE.SphereGeometry(1, 64, 64);
      function buildBall(spec) {
        const tex = makeBallTexture(spec.num, false, {
          fill: ballFillCss(spec.hue),
          textColor: numTextColor(spec.hue),
          discPositions: ANTIPRISM_DISC_POSITIONS,
          angularR: 0.40,
          noGradient: true,
        });
        tex.colorSpace = THREE.SRGBColorSpace;
        // transparent + opacity 0.8 → balls let the dark backdrop
        // bleed through slightly, softening them against the panel.
        const mat  = new THREE.MeshBasicMaterial({
          map: tex, transparent: true, opacity: 0.8,
        });
        const mesh = new THREE.Mesh(geometry, mat);
        mesh.rotation.y = spec.num * 0.73;
        mesh.rotation.x = spec.num * 0.21;
        return { spec, mesh, mat, tex };
      }
      const ring = ringSpecs.map(buildBall);
      for (const b of ring) scene.add(b.mesh);

      function sizeTo() {
        const r = cvs.getBoundingClientRect();
        const w = Math.max(1, Math.round(r.width));
        const h = Math.max(1, Math.round(r.height));
        renderer.setSize(w, h, false);
        camera.left = -w / 2; camera.right = w / 2;
        camera.top  =  h / 2; camera.bottom = -h / 2;
        camera.updateProjectionMatrix();
        // Base mesh scale — the tick multiplies this by the
        // depth-derived size factor each frame.
        const s = Math.min(w, h);
        for (const b of ring) b.mesh.userData.baseScale = s * b.spec.scaleK;
      }
      sizeTo();
      const ro = (typeof ResizeObserver !== 'undefined')
        ? new ResizeObserver(sizeTo) : null;
      if (ro) ro.observe(cvs);

      // Smoothed tilt — exponential lerp toward the latest raw value
      // so a sharp phone wobble doesn't make the balls snap. Lower
      // SMOOTH = more lag; 0.12 lands ~95% in 0.5 s at 60 fps.
      const SMOOTH = 0.12;
      const PARALLAX_AMP = 36;       // px shift at full tilt × depth
      let smoothTiltX = 0, smoothTiltY = 0;

      let raf = null;
      let stopped = false;
      // Orbit accumulator — increments each frame, drives the ring's
      // angular position. Stays in [0, 2π) for numerical stability
      // over long sessions.
      let orbitAngle = 0;
      function tick() {
        if (stopped) { raf = null; return; }
        raf = requestAnimationFrame(tick);
        smoothTiltX += (outroTiltN.x - smoothTiltX) * SMOOTH;
        smoothTiltY += (outroTiltN.y - smoothTiltY) * SMOOTH;
        orbitAngle = (orbitAngle + ORBIT_SPEED) % (Math.PI * 2);
        const r = cvs.getBoundingClientRect();
        const w = Math.max(1, Math.round(r.width));
        const h = Math.max(1, Math.round(r.height));
        const ringR = Math.min(w, h) * RING_RADIUS_K;

        // Tilted orbit: parametrize on a circle in the X axis, then
        // rotate the circle around X by RING_TILT so its bottom edge
        // pitches toward the camera. The Y component foreshortens by
        // cos(tilt); a new Z component drives both render order and
        // the per-ball scale (front bigger, back smaller).
        for (const b of ring) {
          b.mesh.rotation.y += b.spec.spinRate;
          b.mesh.rotation.x += b.spec.spinRate * 0.18;
          const a  = b.spec.angleOffset + orbitAngle;
          const sa = Math.sin(a), ca = Math.cos(a);
          const ox = ca * ringR;
          const oy = sa * ringR * RING_TILT_COS;
          // Sign: bottom of orbit (sa = -1) should be CLOSER to the
          // camera → positive z (camera looks down -Z by default).
          const oz = -sa * ringR * RING_TILT_SIN;
          b.mesh.position.x = ox + smoothTiltX * PARALLAX_AMP * b.spec.depth;
          b.mesh.position.y = oy + smoothTiltY * PARALLAX_AMP * b.spec.depth;
          b.mesh.position.z = oz;
          // Depth-fraction in [-1, +1]: +1 = closest, -1 = farthest.
          const zNorm = oz / (ringR * RING_TILT_SIN || 1);
          const scale = b.mesh.userData.baseScale * (SCALE_BASE + zNorm * SCALE_AMP);
          b.mesh.scale.setScalar(scale);
        }

        renderer.render(scene, camera);
      }
      // Initial render so the canvas isn't blank during the
      // overlay's fade-in transition.
      renderer.render(scene, camera);

      startOutroBalls = () => {
        if (!raf && !stopped) {
          sizeTo();   // canvas may have been 0×0 on first paint
          raf = requestAnimationFrame(tick);
        }
      };
      stopOutroBalls = () => {
        if (raf) { cancelAnimationFrame(raf); raf = null; }
      };
      disposeOutroBalls = () => {
        stopped = true;
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        ro?.disconnect();
        geometry.dispose();
        for (const b of ring) { b.tex.dispose(); b.mat.dispose(); }
        renderer.dispose();
      };
    })();

    /* How-to-play loop driver — sequence is:
        [0]    bubble visible
        [2.0s] bubble pop (CSS scale + spawnBurst), 320 ms
        [2.3s] bubble fades, ball fades in + spins
        [5.3s] ball fades out, bubble fades back in
        [5.5s] back to [0]
       The loop runs only while the settings backdrop is visible
       AND the is-howto class is on it; either condition becoming
       false cancels the in-flight timeout and resets the visuals
       so re-opening the How-to-play panel starts cleanly. */
    let howtoTimers = [];
    let howtoLoopActive = false;
    function clearHowtoTimers() {
      for (const t of howtoTimers) clearTimeout(t);
      howtoTimers = [];
    }
    function isHowtoVisible() {
      return !!(settingsBackdropEl
        && settingsBackdropEl.classList.contains('visible')
        && settingsBackdropEl.classList.contains('is-howto'));
    }
    function resetHowtoVisuals() {
      const hero   = document.getElementById('settingsHowtoHero');
      const bubble = document.querySelector('.settings-howto-bubble');
      const ball   = document.getElementById('settingsHowtoBallCanvas');
      if (bubble) bubble.classList.remove('is-faded', 'howto-popping');
      if (ball)   ball.classList.remove('is-visible');
      // Clear any in-flight burst particles so re-opening the panel
      // doesn't show leftovers from the prior cycle.
      if (hero) {
        const stragglers = hero.querySelectorAll('.burst-particle');
        stragglers.forEach(el => el.remove());
      }
      if (stopHowtoBallSpin) stopHowtoBallSpin();
    }
    function runHowtoSequence() {
      if (!howtoLoopActive || !isHowtoVisible()) return;
      const hero   = document.getElementById('settingsHowtoHero');
      const bubble = document.querySelector('.settings-howto-bubble');
      const ball   = document.getElementById('settingsHowtoBallCanvas');
      if (!hero || !bubble || !ball) return;

      // Phase 1: pop the bubble + spray burst particles AND reveal
      // the spinning ball in the same frame so the ball blooms out
      // through the bursting bubble (rather than appearing after
      // the particles have already faded). The bubble's scale/fade
      // animation (320 ms) and the ball's CSS scale-in (280 ms)
      // overlap with the ~600 ms burst-particle spray.
      bubble.classList.add('howto-popping');
      const r = hero.getBoundingClientRect();
      spawnBurst(r.width / 2, r.height / 2, r.width, hero);
      ball.classList.add('is-visible');
      if (startHowtoBallSpin) startHowtoBallSpin();

      // Phase 2: lock the bubble at opacity 0 right as its pop
      // animation ends. We add .is-faded BEFORE removing the
      // animation class so the bubble is held hidden by one class
      // or the other at every frame — no flicker.
      howtoTimers.push(setTimeout(() => {
        if (!howtoLoopActive || !isHowtoVisible()) return;
        bubble.classList.add('is-faded');
        bubble.classList.remove('howto-popping');
      }, 320));

      // Phase 3: after the ball has spun for ~3 s (measured from
      // its reveal at phase 1), hide it and bring the bubble back.
      howtoTimers.push(setTimeout(() => {
        if (!howtoLoopActive || !isHowtoVisible()) return;
        ball.classList.remove('is-visible');
        bubble.classList.remove('is-faded');
        // Stop the rAF slightly after the fade so the user doesn't
        // catch a snap-stop mid-spin.
        howtoTimers.push(setTimeout(() => {
          if (stopHowtoBallSpin) stopHowtoBallSpin();
        }, 260));
        // Phase 4: wait, then loop.
        howtoTimers.push(setTimeout(runHowtoSequence, 1600));
      }, 3000));
    }
    function startHowtoLoop() {
      if (howtoLoopActive) return;
      howtoLoopActive = true;
      resetHowtoVisuals();
      // First pop lands 2 s after the panel slides in — gives the
      // user a beat to read the title before the demo kicks off.
      howtoTimers.push(setTimeout(runHowtoSequence, 2000));
    }
    function stopHowtoLoop() {
      howtoLoopActive = false;
      clearHowtoTimers();
      resetHowtoVisuals();
    }

    function refreshIntroToggles() {
      if (introAudioEl) introAudioEl.setAttribute('aria-pressed', audioEnabled ? 'true' : 'false');
      if (introTiltEl)  introTiltEl.setAttribute('aria-pressed',  tiltEnabled  ? 'true' : 'false');
      if (introBrandEl) introBrandEl.setAttribute('aria-pressed', brandEnabled ? 'true' : 'false');
    }
    refreshIntroToggles();
    // Games-count selector — drives totalGames so the bottom pill
    // and the outro-trigger check both pick up the user's choice.
    if (introGamesEl) {
      introGamesEl.value = String(totalGames);
      introGamesEl.addEventListener('change', () => {
        const v = parseInt(introGamesEl.value, 10);
        if (Number.isFinite(v) && v >= 4 && v <= 50) {
          totalGames = v;
          refreshPill();
        }
      }, { signal });
    }
    // Draws-mode selector — Powerball vs Oz Lotto. setDrawMode
    // updates NUMBERS_PER_GAME, the texture cache, and the visible
    // slot count + PB label all in one call.
    if (introDrawsEl) {
      introDrawsEl.value = drawMode;
      introDrawsEl.addEventListener('change', () => {
        setDrawMode(introDrawsEl.value);
      }, { signal });
    }
    if (outroViewEl) outroViewEl.addEventListener('click', () => {
      // For now: View my ticket sends the user back to the intro
      // (matches Exit Game's flow). Hook the real ticket view here
      // when the ticket screen is built.
      hideOutro();
      resetAll();
      if (introEl) {
        introEl.classList.remove('intro-hide');
        if (resumeIntroBall) resumeIntroBall();
      }
    }, { signal });
    if (introAudioEl) introAudioEl.addEventListener('click', () => {
      audioEnabled = !audioEnabled;
      refreshIntroToggles();
      refreshSettingsLabels();
    }, { signal });
    if (introTiltEl) introTiltEl.addEventListener('click', () => {
      // Click IS a user gesture — call enableTiltOnGesture/disableTilt
      // synchronously so iOS's requestPermission stays inside it.
      if (tiltEnabled) {
        disableTilt();
        refreshIntroToggles();
        refreshSettingsLabels();
      } else {
        enableTiltOnGesture();
        // requestPermission is async on iOS — refresh on next tick AND
        // again after the permission promise typically resolves, so
        // the toggle reflects the granted state.
        refreshIntroToggles();
        setTimeout(() => { refreshIntroToggles(); refreshSettingsLabels(); }, 400);
      }
    }, { signal });
    if (introBrandEl) introBrandEl.addEventListener('click', () => {
      setBrandEnabled(!brandEnabled);
      refreshIntroToggles();
    }, { signal });
    if (introStartEl) introStartEl.addEventListener('click', () => {
      // Don't call ensureAudio() here — see comment in the original
      // (matches the iOS-friendly bubble-wrap-fidget gesture flow).
      // .intro-hide fades it out + sets pointer-events:none so the
      // canvas underneath becomes interactive. We KEEP the element
      // in the DOM (no remove) so the Exit Game button can bring it
      // back later without re-mounting. Three.js rAF is paused
      // while hidden to save GPU.
      introEl?.classList.add('intro-hide');
      if (pauseIntroBall) pauseIntroBall();
    }, { signal });

    /* Rebake ball textures once SharpGrotesk Medium has loaded. Canvas
       2d uses the OS fallback if the font isn't ready when fillText is
       called, so any texture baked during the initial paint (e.g. a
       ball spawned via ?autopop= before the .otf finishes downloading)
       would freeze in the fallback font. After the font resolves we
       drop the cache and re-bake the texture for every currently-
       visible mesh so they swap in-place. */
    if (typeof document !== 'undefined' && document.fonts && document.fonts.load) {
      document.fonts.load('500 70px "SharpGrotesk"').then(() => {
        if (signal.aborted) return;
        for (const tex of ballScene.texCache.values()) tex.dispose();
        ballScene.texCache.clear();
        for (const mesh of ballScene.meshes) {
          const num = mesh.userData?.number;
          if (mesh.visible && num != null) {
            mesh.material.map?.dispose();
            mesh.material.map = getBallTexture(num, !!mesh.userData?.white);
            mesh.material.needsUpdate = true;
          }
        }
      }).catch(() => {});
    }

    /* Debug: ?autopop=N auto-pops a row after a short delay so the
       3D ball spin-in animation can be eyeballed without manual
       clicks. Safe to leave in — the URL flag is opt-in. */
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const autopop = parseInt(params.get('autopop') || '', 10);
      if (Number.isFinite(autopop) && autopop > 0) {
        setTimeout(() => {
          const targets = layout.bubbles
            .slice(0, Math.min(autopop, NUMBERS_PER_GAME))
            .map(b => b.num);
          targets.forEach((n, i) => setTimeout(() => popBubble(n), i * 150));
        }, 700);
      }
    }

    return () => {
      ac.abort();
      if (disposeIntroBall) { disposeIntroBall(); disposeIntroBall = null; }
      if (disposeHowtoBall) { disposeHowtoBall(); disposeHowtoBall = null; }
      if (disposeOutroBalls) { disposeOutroBalls(); disposeOutroBalls = null; }
      stopHowtoLoop();
      if (ro) ro.disconnect();
      if (bubblesEl) bubblesEl.innerHTML = '';
      if (_hapticSwitch && _hapticSwitch.label.parentNode) {
        _hapticSwitch.label.parentNode.removeChild(_hapticSwitch.label);
      }
      if (audioCtx) audioCtx.close().catch(() => {});
      if (ballScene.raf) cancelAnimationFrame(ballScene.raf);
      for (const mesh of ballScene.meshes) {
        mesh.material?.dispose();
      }
      ballScene.geometry?.dispose();
      for (const tex of ballScene.texCache.values()) tex.dispose();
      ballScene.renderer?.dispose();
    };
  }, []);

  return (
    <>
      {/* Build badge — top-right corner. Bump APP_VERSION at the top
          of this file on every change you want to verify is live. */}
      <div className="build-version" aria-hidden="true">{APP_VERSION}</div>

      {/* Retro noise grain — fixed full-screen overlay that lives
          above everything so the whole UI picks up subtle film-grain
          texture. */}
      <div className="noise-overlay" aria-hidden="true" />

      {/* Intro overlay — layered hero (gradient → ball → bubble → logo)
          plus tagline / CTA / toggles. Dismissed by "Get popping". */}
      <div className="intro" id="intro">
        {/* Background — radial gradient pulsing subtly. */}
        <div className="intro-bg" aria-hidden="true" />

        {/* Bubble is now a top-level child of #intro (was nested in
            .intro-bubble-wrap). Positioned absolutely so it lines up
            over the ball canvas + drag surface. */}
        <img
          src="/intro-bubble.png"
          className="intro-bubble"
          alt=""
          draggable="false"
        />

        {/* Hero stack: spinning 3D ball with the logo overlapping the
            bubble's bottom half from in front. */}
        <div className="intro-hero">
          <div className="intro-bubble-wrap">
            <canvas
              className="intro-ball-canvas"
              id="introBallCanvas"
              aria-hidden="true"
            />
            <div
              className="intro-drag-surface"
              id="introDragSurface"
              aria-label="Spin the ball"
            />
          </div>
          <img
            src="/logo.png"
            className="intro-logo"
            alt="Powerball Pop & Play"
            draggable="false"
          />
        </div>

        <div className="intro-content">
          <button className="intro-cta" id="introStart" type="button">
            Get popping
          </button>
          <p className="intro-tagline">
            Tap or swipe to pop the bubbles and unlock your lucky numbers.
          </p>
        </div>

        <div className="intro-toggles">
          <div className="intro-toggle">
            <span className="intro-toggle-label">Games</span>
            <select
              className="intro-select"
              id="introGames"
              aria-label="Number of games"
              defaultValue={String(DEFAULT_GAMES)}
            >
              {Array.from({ length: 47 }, (_, i) => i + 4).map(n => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </div>
          <div className="intro-toggle">
            <span className="intro-toggle-label">Audio</span>
            <button
              className="intro-switch"
              id="introAudio"
              type="button"
              aria-pressed="true"
              aria-label="Toggle audio"
            >
              <span className="intro-switch-off">Off</span>
              <span className="intro-switch-on">On</span>
            </button>
          </div>
          <div className="intro-toggle">
            <span className="intro-toggle-label">Tilt</span>
            <button
              className="intro-switch"
              id="introTilt"
              type="button"
              aria-pressed="false"
              aria-label="Toggle tilt"
            >
              <span className="intro-switch-off">Off</span>
              <span className="intro-switch-on">On</span>
            </button>
          </div>
          {/* Brand toggle hidden for now — markup kept so the
              setBrandEnabled logic stays wired for a future
              re-enable. */}
          <div className="intro-toggle" style={{ display: 'none' }}>
            <span className="intro-toggle-label">Brand</span>
            <button
              className="intro-switch"
              id="introBrand"
              type="button"
              aria-pressed="false"
              aria-label="Toggle brand style"
            >
              <span className="intro-switch-off">Off</span>
              <span className="intro-switch-on">On</span>
            </button>
          </div>
          <div className="intro-toggle">
            <span className="intro-toggle-label">Draws</span>
            <select
              className="intro-select"
              id="introDraws"
              aria-label="Lottery draw type"
              defaultValue="powerball"
            >
              <option value="powerball">Powerball</option>
              <option value="ozlotto">Oz Lotto</option>
            </select>
          </div>
        </div>
      </div>

      <div className="stage" id="stage">
        <div id="cloudLayer" />
        {/* Two-layer sheet:
            - .sheet handles the slide-out / slide-in refill (translateX).
            - .sheet-tilt handles the device-orientation tilt (rotateX/Y
              + perspective). Nesting keeps the two transform stacks
              independent so they compose cleanly. */}
        <div className="sheet" id="sheet">
          <div className="sheet-tilt" id="sheetTilt">
            <div id="bubbleFrame" />
            <div id="bubbles" />
          </div>
        </div>
        <div className="status-spacer" />
        <div className="toast" id="toast" />
      </div>

      {/* Tray middle — ghosts + labels + active slot row. Sits on the
          body's app_BG starfield, NOT inside the footer plate. This
          area is transparent so the bg shows through. */}
      <div className="tray-mid">
        <div className="tray-ghost-row" id="trayGhostRow" aria-hidden="true" />
        <div className="tray-ghost-gradient" aria-hidden="true" />

        <div className="tray-labels">
          <span className="tray-label tray-label-left">YOUR NUMBERS</span>
          <span className="tray-label tray-label-mid" id="trayGameLabel">
            Game 1/20
          </span>
          <span className="tray-label tray-label-right">PB</span>
        </div>

        <div className="tray-balls">
          <div className="tray-rings" id="trayRings">
            {Array.from({ length: MAX_NUMBERS_PER_GAME }, (_, i) => (
              <div className="ring" key={i} />
            ))}
          </div>
        </div>

        {/* Legacy stub — kept so older CSS selectors / swipe code
            referencing #visibleRow don't error. */}
        <div id="visibleRow" aria-hidden="true" />
      </div>

      {/* Tray foot — controls only. footer_bg.png paints its arc here
          so the dark plate visually starts BELOW the slot row. */}
      <div className="tray-foot">
        <div className="tray-ctas">
          {/* Three-dot menu — opens the Settings modal (How to play,
              Reset, Audio toggle, Tilt toggle, Skip, Exit). */}
          <button
            className="ctl ctl-round ctl-glass"
            id="ctaExit"
            type="button"
            aria-label="Open settings"
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <circle cx="4"  cy="10" r="1.6" fill="currentColor" />
              <circle cx="10" cy="10" r="1.6" fill="currentColor" />
              <circle cx="16" cy="10" r="1.6" fill="currentColor" />
            </svg>
          </button>

          {/* Count pill with a progress ring tracing the pill's outline.
              The cyan stroke fills clockwise as balls are added to the
              row; resets to empty when the row completes and clears.
              Tap the pill to cycle through the GAME_COUNT_CYCLE options. */}
          <button
            className="ctl ctl-pill ctl-glass"
            id="ctaPill"
            type="button"
            aria-label="Auto-fill current row"
          >
            <svg
              className="ctl-pill-progress"
              viewBox="0 0 120 44"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <rect
                x="1.5" y="1.5" width="117" height="41"
                rx="20.5" ry="20.5"
                pathLength="100"
                id="ctaPillProgress"
              />
            </svg>
            <span className="ctl-pill-count" id="ctaPillCount">1/20</span>
            <svg className="ctl-pill-chevrons" viewBox="0 0 20 16" aria-hidden="true">
              <polyline points="3,3 9,8 3,13"
                fill="none" stroke="currentColor" strokeWidth="2.2"
                strokeLinecap="round" strokeLinejoin="round" />
              <polyline points="11,3 17,8 11,13"
                fill="none" stroke="currentColor" strokeWidth="2.2"
                strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>

          {/* Wide "Fast select" button — pops enough bubbles to complete
              all remaining games up to totalGames. Replaces the prior
              ⏭ skip-to-end button; single-row ▶ is gone entirely. */}
          <button
            className="ctl ctl-fast-select"
            id="ctaFastSelect"
            type="button"
            aria-label="Fast select all remaining games"
          >
            {/* Two icons — CSS hides one based on .is-stop on the parent. */}
            <svg className="ctl-fast-icon ctl-fast-icon-lightning" viewBox="0 0 18 18" aria-hidden="true">
              <polygon points="10,1 3,10 8,10 7,17 15,7 10,7" fill="currentColor" />
            </svg>
            <svg className="ctl-fast-icon ctl-fast-icon-stop" viewBox="0 0 18 18" aria-hidden="true">
              <rect x="4" y="4" width="10" height="10" rx="1.5" fill="currentColor" />
            </svg>
            <span className="ctl-fast-label">Fast select</span>
          </button>
        </div>
      </div>

      <div className="game-message" id="gameMessage">
        <span className="game-message-text" id="gameMessageText" />
      </div>

      {/* WebGL canvas spans the whole body so a ball can animate from a
          bubble's screen position (up in the stage area) down to its
          slot in the tray, all in one continuous Three.js scene. */}
      <canvas className="ball-overlay" id="ballOverlay" />

      {/* Outro overlay — fades in once the user finishes all
          selected games. View my ticket dismisses it and returns
          to the intro. */}
      <div className="outro" id="outro" aria-hidden="true">
        {/* Spinning balls anchored to the top of the overlay. Driven
            by a separate Three.js scene that runs only while the
            outro is visible; mesh positions get translated by the
            tilt-parallax read each frame so the balls feel like
            they're floating above the surface. */}
        <canvas
          className="outro-balls"
          id="outroBallsCanvas"
          aria-hidden="true"
        />
        <h1 className="outro-title">All done, pop star.</h1>
        <p className="outro-body">
          Your numbers are locked, your rows are full, and your
          ticket is ready for its big moment.
        </p>
        <button className="outro-cta" id="outroViewTicket" type="button">
          View my ticket
        </button>
        <p className="outro-subtext">
          (No bubbles were harmed in the making of this ticket.)
        </p>
      </div>

      {/* Settings modal — opened by the bottom-bar … button. Glass
          panel over a dark-blue blurred overlay; clicking the
          backdrop or any action closes it. */}
      <div className="settings-backdrop" id="settingsBackdrop" aria-hidden="true">
        {/* Persistent X — pinned to the viewport's top-right (not the
            card) so it sits at a fixed 16/16 inset regardless of
            which sub-panel is showing. */}
        <button
          className="settings-close"
          id="settingsClose"
          type="button"
          aria-label="Close menu"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M6 6l12 12M18 6l-12 12"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </button>

        <div className="settings-card">
          {/* Horizontal slider: track is 200% wide and contains the
              menu (left half) + the How to Play panel (right half).
              .is-howto on the backdrop translates the track -50% so
              the menu slides off-screen left and How to Play slides
              in from the right. */}
          <div className="settings-slider">
            <div className="settings-slider-track">
              <div className="settings-modal" role="dialog" aria-label="Settings">
                <button
                  className="settings-btn settings-btn-primary"
                  id="settingsJumpToTicket"
                  type="button"
                >
                  <svg className="settings-btn-icon" viewBox="0 0 18 18" aria-hidden="true">
                    <polygon points="10,1 3,10 8,10 7,17 15,7 10,7" fill="currentColor" />
                  </svg>
                  <span>Jump to ticket</span>
                </button>
                <button
                  className="settings-btn settings-btn-secondary"
                  id="settingsFreshSheet"
                  type="button"
                >
                  Fresh sheet
                </button>
                <button className="settings-btn" id="settingsReset" type="button">
                  Start over
                </button>
                <button className="settings-btn settings-toggle" id="settingsAudio" type="button">
                  <span>Audio</span>
                  <span className="settings-toggle-state">On</span>
                </button>
                <button className="settings-btn" id="settingsHowToPlay" type="button">
                  How to play
                </button>
                <button
                  className="settings-btn settings-btn-exit"
                  id="settingsExit"
                  type="button"
                >
                  Exit
                </button>
              </div>

              <div className="settings-howto" role="dialog" aria-label="How to play">
                {/* Hero — bubble + lotto ball stacked in the same
                    84px box. JS swaps which is visible during the
                    pop → spin → reset loop. */}
                <div className="settings-howto-hero" id="settingsHowtoHero">
                  <img
                    className="settings-howto-bubble"
                    src="/intro-bubble.png"
                    alt=""
                    draggable="false"
                  />
                  <canvas
                    className="settings-howto-ball-canvas"
                    id="settingsHowtoBallCanvas"
                    aria-hidden="true"
                  />
                </div>
                <h2 className="settings-howto-title">Pop. Drop. Play.</h2>
                <p className="settings-howto-body">
                  Tap or swipe the bubbles to reveal your lucky numbers.
                </p>
                <p className="settings-howto-body">
                  Each pop adds a ball to your game row.
                </p>
                <p className="settings-howto-body">
                  Fill the rows, enjoy the PlaySMR, then we&rsquo;ll turn it
                  into your ticket.
                </p>
                <p className="settings-howto-body settings-howto-body-accent">
                  No strategy required. Just chaos with numbers.
                </p>
                <button
                  className="settings-howto-cta"
                  id="settingsHowtoBack"
                  type="button"
                >
                  Back to Popping
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
