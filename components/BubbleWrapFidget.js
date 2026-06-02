'use client';

import { useEffect } from 'react';
import * as THREE from 'three';

/* Bump this on every change you want to verify is deployed. The
   badge sits in the top-right corner of the viewport so you can
   confirm at a glance that the iOS PWA cache has picked up the
   latest build. */
const APP_VERSION = 'v21';

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
const HUE_MAP = [4, 32, 54, 100, 170, 215, 270, 325];
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
/* Threshold 0.35 — yellow / green / cyan / orange all have luminance
   ≥ 0.37 and read better with dark navy glyphs; red / blue / purple /
   pink fall below and need white. Lower than the WCAG-style 0.45
   threshold because orange (L≈0.38) genuinely looks better with dark
   text per the design reference. */
function numTextColor(h) { return ballLuminance(h) > 0.35 ? '#0b1140' : '#ffffff'; }

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
const NUMBERS_PER_GAME = 8;
const DEFAULT_GAMES = 20;

/* Spin-in: ball enters from below the ring slot, spins on Y, then
   settles dead-front with the glyph upright. With the front disc at
   (lat=0, lon=π/2) the disc centre already lands on +Z at rotation
   (0, 0, 0), so the final pose needs no tilt at all. The stamp's "up"
   maps to sphere-north (+Y), which projects to screen +Y → upright. */
const SPIN_DURATION_MS  = 700;
const SPIN_REVOLUTIONS  = 2.4;
const FINAL_ROT_X       = 0;
const FINAL_ROT_Y       = 0;

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

    /* ── Audio (synthesised — Web Audio only, no asset files) ────
       The pop sound is a short downward-swept sine + percussive
       envelope, generated fresh per pop via the AudioContext —
       same pattern as playRowComplete / playSwoosh below. No file
       fetch, no <audio> pool, no buffer decode — just oscillators
       inside the running AC, which has been bulletproof on iOS. */
    let audioEnabled = true;
    let audioCtx = null;
    let keepaliveStarted = false;
    function ensureAudio() {
      if (!audioCtx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) {
          try { audioCtx = new AC(); } catch (_) {}
        }
      }
      if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {});
      }
      // iOS Safari aggressively suspends an AudioContext after a few
      // hundred ms of inactivity, even while "running" — once that
      // happens, createOscillator() silently produces no sound. A
      // permanent 1 Hz / gain-0 oscillator keeps the AC "in use" so
      // iOS leaves it active. Started once, runs for the AC's life.
      if (audioCtx && !keepaliveStarted) {
        keepaliveStarted = true;
        try {
          const osc = audioCtx.createOscillator();
          osc.frequency.value = 1;          // sub-audible
          const g = audioCtx.createGain();
          g.gain.value = 0;                 // silent
          osc.connect(g).connect(audioCtx.destination);
          osc.start();
          // never stop — runs for the lifetime of the AC
        } catch (_) {}
      }
    }
    function playPop(variation = 0) {
      if (!audioEnabled || !audioCtx) return;
      // Belt-and-braces: even with the keepalive, resume if iOS has
      // somehow managed to suspend us between pops. Safe to call
      // repeatedly.
      if (audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {});
      }
      try {
        const now = audioCtx.currentTime;
        // Pitch range per-pop: base ~520-720 Hz, plus a small offset
        // from the "variation" parameter passed by the caller so
        // adjacent bubbles vary musically.
        const baseFreq = 540 + variation * 35 + Math.random() * 180;
        // Sine oscillator with a fast downward pitch sweep — the
        // hallmark "blip" of a bubble pop.
        const osc = audioCtx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(baseFreq * 1.6, now);
        osc.frequency.exponentialRampToValueAtTime(baseFreq * 0.45, now + 0.075);
        // Percussive envelope: 5 ms attack, ~110 ms decay.
        const gain = audioCtx.createGain();
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(
          0.32 + Math.random() * 0.10, now + 0.005);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.13);
        osc.connect(gain).connect(audioCtx.destination);
        osc.start(now);
        osc.stop(now + 0.16);
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
    function spawnBurst(cx, cy, size) {
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
        bubblesEl.appendChild(el);
        el.addEventListener('animationend', () => el.remove(), { once: true });
      }
    }

    function popBubble(num) {
      const state = bubbleStates.get(num);
      if (!state || state.popped || state.popping) return false;
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
    let totalGames = DEFAULT_GAMES;
    let gameCompleting = false;

    function refreshPill() {
      if (ctaPillCountEl) {
        ctaPillCountEl.textContent = `${viewedGameIdx + 1}/${totalGames}`;
      }
      if (gameLabelEl) {
        gameLabelEl.textContent = `Game ${viewedGameIdx + 1}/${totalGames}`;
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
      meshes:   [],      // 7 pool meshes
      slotCenters: [],   // [{x, y, r}, ...] in canvas pixel coords (top-left origin)
      animations: [],    // active spin-in/-out anims
      texCache:    new Map(),
      ballRadius:  22,
      width:  0,
      height: 0,
      raf:    null,
    };
    function getBallTexture(num, white = false) {
      // Cache keyed on (number, whiteness) since the same number can be
      // a coloured regular ball OR a white powerball (the 8th of a row).
      const key = white ? `w${num}` : `c${num}`;
      let t = ballScene.texCache.get(key);
      if (t) return t;
      t = makeBallTexture(num, white);
      ballScene.texCache.set(key, t);
      return t;
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
      // Build a pool of 7 meshes (max balls visible in a single game).
      // They're created once with MeshStandardMaterial so the same
      // texture-swap path serves both first-render and re-render after
      // game completion.
      for (let i = 0; i < NUMBERS_PER_GAME; i++) {
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
      ballScene.slotCenters = ringEls.map(ring => {
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
        const mesh = ballScene.meshes[anim.slotIdx];
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
          // Source = bubble centre (canvas-local px); target = slot
          // centre. Y axis is gravity-accelerated (t²) for a physical
          // fall; X uses easeOutCubic for a smooth lateral glide.
          // Ball tumbles on X axis many times during the fall, easing
          // into FINAL_ROT_X so the number lands forward-facing.
          const targetX = slot.x;
          const targetY = ballScene.height - slot.y;
          const startX  = anim.sourceX;
          const startY  = ballScene.height - anim.sourceY;
          const yProg = t * t;             // accelerating fall
          const xProg = eased;             // smooth lateral
          mesh.position.x = startX + (targetX - startX) * xProg;
          mesh.position.y = startY + (targetY - startY) * yProg;
          mesh.position.z = 0;
          mesh.scale.setScalar(ballScene.ballRadius);
          // Tumble on all three axes by the per-ball random spin
          // counts; each axis interpolates its accumulated revolutions
          // toward 0 as the ball settles, so the final pose always
          // lands on FINAL_ROT_X/Y/Z.
          const spinPhase = (1 - eased) * Math.PI * 2;
          mesh.rotation.set(
            FINAL_ROT_X + anim.spinX * spinPhase,
            FINAL_ROT_Y + anim.spinY * spinPhase,
            0           + anim.spinZ * spinPhase,
          );
          mesh.visible = true;
          if (t >= 1) {
            mesh.position.set(targetX, targetY, 0);
            mesh.rotation.set(FINAL_ROT_X, FINAL_ROT_Y, 0);
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
      const mesh = ballScene.meshes[slotIdx];
      if (!mesh) return;
      // The last ball in each row is the white "powerball" — same
      // number on its face, but the ball itself is white with dark
      // navy glyphs (classic lottery convention for the bonus pick).
      const white = slotIdx === NUMBERS_PER_GAME - 1;
      const tex = getBallTexture(number, white);
      if (mesh.material.map !== tex) {
        mesh.material.map = tex;
        mesh.material.needsUpdate = true;
      }
      // Track number + whiteness on the mesh so the font-load rebake
      // can refresh visible balls once SharpGrotesk loads.
      mesh.userData.number = number;
      mesh.userData.white = white;
      mesh.material.opacity = 1;
      mesh.material.transparent = false;
      mesh.visible = true;
      // Fallback: if we have no source position (e.g. autopop debug or
      // missing bubble), start at the slot's own X just above the slot,
      // so the animation still plays sanely without referring to a
      // bubble's screen position.
      const slot = ballScene.slotCenters[slotIdx];
      const fallbackY = slot ? Math.max(0, slot.y - ballScene.ballRadius * 4) : 0;
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
        const h = ballHue(n);
        const isPowerball = i === NUMBERS_PER_GAME - 1;
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

    // Idempotent — does the row-complete work (clear active balls,
    // populate ghosts, bump game counter, reset selections). May be
    // called twice for the same row: once eagerly when the user pops
    // again during the settle wait, and once from the deferred
    // setTimeout when the last drop animation finishes. The
    // `gameCompleting` guard makes the second call a no-op.
    function advanceRow(completedRow) {
      if (!gameCompleting) return;
      gameCompleting = false;
      clearAllBalls(false);
      populateGhostRow(completedRow);
      currentGame++;
      currentSelections = [];
      viewedGameIdx = currentGame;
      refreshPill();
    }

    function addSelected(num) {
      // If the previous row just completed and is still in its
      // settle-wait window, advance NOW so this new pop lands in
      // the next row instead of being blocked. The deferred timeout
      // from the previous addSelected call will fire later and
      // no-op via advanceRow's guard.
      if (gameCompleting) {
        const prev = allGames[currentGame];
        if (prev) advanceRow(prev);
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
        // Schedule the row-advance for after the last ball's drop
        // animation. If the user pops again before this fires,
        // addSelected (above) calls advanceRow eagerly and this
        // becomes a no-op via the gameCompleting guard.
        const fast = autoPlayQueue > 0;
        const settleWait  = (fast ? SPIN_DURATION_MS / 2 : SPIN_DURATION_MS) + 80;
        const nextRowWait = fast ? 180 : 360;
        setTimeout(() => {
          advanceRow(completedRow);
          if (autoPlayQueue > 0) {
            autoPlayQueue--;
            if (autoPlayQueue > 0 || currentGame < totalGames) {
              setTimeout(autoFillCurrentRow, nextRowWait);
            }
          }
        }, settleWait);
        refreshPill();
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
      gameCompleting = false;
      currentGame = 0;
      currentSelections = [];
      viewedGameIdx = 0;
      allGames.length = 0;
      // Hide WebGL balls instantly.
      clearAllBalls(false);
      // Drop persistent ghost rows.
      if (ghostRowEl) ghostRowEl.innerHTML = '';
      // Refill the sheet with the existing animation hook.
      refillSheet();
      refreshPill();
    }

    // The bottom-bar … button now opens the Settings modal instead of
    // resetting directly. Reset moved to a button inside the modal.
    const settingsBackdropEl = document.getElementById('settingsBackdrop');
    const settingsAudioEl    = document.getElementById('settingsAudio');
    const settingsTiltEl     = document.getElementById('settingsTilt');
    const settingsResetEl    = document.getElementById('settingsReset');
    const settingsSkipEl     = document.getElementById('settingsSkip');
    const settingsExitEl     = document.getElementById('settingsExit');
    const settingsHowToEl    = document.getElementById('settingsHowToPlay');
    function refreshSettingsLabels() {
      if (settingsAudioEl) {
        settingsAudioEl.classList.toggle('is-off', !audioEnabled);
        const s = settingsAudioEl.querySelector('.settings-toggle-state');
        if (s) s.textContent = audioEnabled ? 'On' : 'Off';
      }
      if (settingsTiltEl) {
        settingsTiltEl.classList.toggle('is-off', !tiltEnabled);
        const s = settingsTiltEl.querySelector('.settings-toggle-state');
        if (s) s.textContent = tiltEnabled ? 'On' : 'Off';
      }
    }
    function openSettings() {
      if (!settingsBackdropEl) return;
      refreshSettingsLabels();
      settingsBackdropEl.classList.add('visible');
    }
    function closeSettings() {
      settingsBackdropEl?.classList.remove('visible');
    }
    if (ctaExitEl) ctaExitEl.addEventListener('click', openSettings, { signal });
    if (settingsBackdropEl) settingsBackdropEl.addEventListener('click', (e) => {
      // Click on the backdrop (outside the modal panel) closes.
      if (e.target === settingsBackdropEl) closeSettings();
    }, { signal });
    if (settingsResetEl) settingsResetEl.addEventListener('click', () => {
      resetAll();
      closeSettings();
    }, { signal });
    if (settingsAudioEl) settingsAudioEl.addEventListener('click', () => {
      audioEnabled = !audioEnabled;
      refreshSettingsLabels();
    }, { signal });
    if (settingsTiltEl) settingsTiltEl.addEventListener('click', () => {
      if (tiltEnabled) disableTilt();
      else             enableTiltOnGesture();
      refreshSettingsLabels();
      // iOS's permission resolves asynchronously; refresh again once
      // the promise typically settles so the toggle reflects reality.
      setTimeout(refreshSettingsLabels, 400);
    }, { signal });
    if (settingsSkipEl) settingsSkipEl.addEventListener('click', () => {
      ensureAudio();
      autoFillCurrentRow();
      closeSettings();
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
    if (settingsHowToEl) settingsHowToEl.addEventListener('click', () => {
      // Placeholder — How-to-play panel TBD.
      closeSettings();
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
       row completes (in addSelected) so successive rows auto-trigger. */
    let autoPlayQueue = 0;
    if (ctaFastSelectEl) ctaFastSelectEl.addEventListener('click', () => {
      ensureAudio();
      const remaining = Math.max(0, totalGames - currentGame - 1);
      autoPlayQueue = remaining;
      autoFillCurrentRow();
    }, { signal });

    function autoFillCurrentRow() {
      const needed = NUMBERS_PER_GAME - currentSelections.length;
      if (needed <= 0) return;
      const available = [];
      for (const b of layout.bubbles) {
        const s = bubbleStates.get(b.num);
        if (s && !s.popped && !s.popping && !currentSelections.includes(b.num)) {
          available.push(b.num);
        }
      }
      if (available.length < needed) return;
      // Fisher-Yates partial shuffle (only need the first `needed` picks)
      for (let i = available.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [available[i], available[j]] = [available[j], available[i]];
      }
      const picks = available.slice(0, needed);
      const popInterval = autoPlayQueue > 0 ? 55 : 110;
      picks.forEach((n, k) => setTimeout(() => popBubble(n), k * popInterval));
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
    }

    /* ── Intro overlay ─────────────────────────────────────────── */
    const introEl       = document.getElementById('intro');
    const introStartEl  = document.getElementById('introStart');
    const introAudioEl  = document.getElementById('introAudio');
    const introTiltEl   = document.getElementById('introTilt');

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

    function refreshIntroToggles() {
      if (introAudioEl) introAudioEl.setAttribute('aria-pressed', audioEnabled ? 'true' : 'false');
      if (introTiltEl)  introTiltEl.setAttribute('aria-pressed',  tiltEnabled  ? 'true' : 'false');
    }
    refreshIntroToggles();
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
            {Array.from({ length: NUMBERS_PER_GAME }, (_, i) => (
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
            <svg className="ctl-fast-icon" viewBox="0 0 18 18" aria-hidden="true">
              <polygon points="10,1 3,10 8,10 7,17 15,7 10,7" fill="currentColor" />
            </svg>
            <span>Fast select</span>
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

      {/* Settings modal — opened by the bottom-bar … button. Glass
          panel over a dark-blue blurred overlay; clicking the
          backdrop or any action closes it. */}
      <div className="settings-backdrop" id="settingsBackdrop" aria-hidden="true">
        <div className="settings-modal" role="dialog" aria-label="Settings">
          <button className="settings-btn" id="settingsHowToPlay" type="button">
            How to Play
          </button>
          <button className="settings-btn" id="settingsReset" type="button">
            Start over
          </button>
          <button className="settings-btn settings-toggle" id="settingsAudio" type="button">
            <span>Audio</span>
            <span className="settings-toggle-state">On</span>
          </button>
          <button className="settings-btn settings-toggle" id="settingsTilt" type="button">
            <span>Tilt</span>
            <span className="settings-toggle-state">On</span>
          </button>
          <button className="settings-btn" id="settingsSkip" type="button">
            Skip
          </button>
          <button className="settings-btn settings-btn-exit" id="settingsExit" type="button">
            Exit Game
          </button>
        </div>
      </div>
    </>
  );
}
