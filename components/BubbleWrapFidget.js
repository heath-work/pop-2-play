'use client';

import { useEffect } from 'react';

/* Intro / splash sequence timings (ms). The DOM-side useEffect below
   schedules class toggles against these so the overlay can self-remove
   without React state churn. Logo sequence finishes at ~990ms; confetti
   spawns then with a 3s arc. Fade-out starts mid-arc on purpose so the
   game becomes interactive without waiting on the full confetti tail. */
const INTRO_FADE_AT = 2400;   // start fade-out (mid-confetti-arc)
const INTRO_REMOVE_AT = 2700; // remove from layout (after fade-out)

/* Emoji explode-from-bottom: triggers as Lott settles (~990ms = 490ms
   delay + 500ms slide). All seven emojis sampled with replacement; each
   gets randomised trajectory + rotation + size via CSS vars. */
const EMOJI_SPAWN_AT = 990;
const EMOJI_COUNT = 8;
const EMOJI_SVGS = [
  '/img/logo-ani/emojis/⚡ - High Voltage.svg',
  '/img/logo-ani/emojis/🌈 - Rainbow.svg',
  '/img/logo-ani/emojis/👾 - Alien Monster.svg',
  '/img/logo-ani/emojis/🔥 - Fire.svg',
  '/img/logo-ani/emojis/🕹️ - Joystick.svg',
  '/img/logo-ani/emojis/😎 - Smiling Face with Sunglasses.svg',
  '/img/logo-ani/emojis/🫶 - Heart Hands.svg',
];

/* The bubble-wrap fidget is an inherently imperative piece of UI: it
   manipulates a lot of DOM (canvas-drawn clouds, dynamically positioned
   bubbles, animation lifecycle classes, audio nodes, etc.). Rather than
   rewrite all of that into React state, we render the static skeleton in
   JSX and run the original logic inside a single useEffect. An
   AbortController scopes window/document listeners so dev-time strict-mode
   double-mounts (and unmounts) clean up after themselves. */
export default function BubbleWrapFidget() {
  /* Intro overlay lifecycle: keeps the splash up while the CSS-driven
     animation chain plays, then fades it and removes it from layout so
     the game becomes interactive. Kept separate from the game's main
     useEffect so the intro never blocks game setup. */
  useEffect(() => {
    const introEl = document.getElementById('introOverlay');
    if (!introEl) return;
    const timeouts = [];
    timeouts.push(setTimeout(() => introEl.classList.add('is-fading'), INTRO_FADE_AT));
    timeouts.push(setTimeout(() => { introEl.style.display = 'none'; }, INTRO_REMOVE_AT));

    const burstEl = document.getElementById('introEmojiBurst');
    if (burstEl) {
      timeouts.push(setTimeout(() => {
        const rand = (lo, hi) => lo + Math.random() * (hi - lo);
        const sign = () => (Math.random() < 0.5 ? -1 : 1);
        const panelWidth = burstEl.getBoundingClientRect().width;
        for (let i = 0; i < EMOJI_COUNT; i++) {
          const img = document.createElement('img');
          img.className = 'intro-emoji';
          img.alt = '';
          img.src = encodeURI(EMOJI_SVGS[Math.floor(Math.random() * EMOJI_SVGS.length)]);
          const size = Math.round(rand(48, 128));
          const spawnX = sign() * rand(0, 0.4) * panelWidth;
          const x = sign() * rand(400, 1000);
          const yPeak = -rand(380, 820);
          const yEnd = rand(220, 500);
          const rotation = sign() * rand(360, 720);
          img.style.cssText =
            `--spawn-x:${spawnX.toFixed(0)}px;--x:${x.toFixed(0)}px;` +
            `--y-peak:${yPeak.toFixed(0)}px;--y-end:${yEnd.toFixed(0)}px;` +
            `--rotation:${rotation.toFixed(0)}deg;--size:${size}px;` +
            `--duration:3000ms;--delay:0ms;`;
          /* Fallback cleanup for emojis that finish before the overlay
             is removed; mid-flight ones get GC'd with the overlay. */
          img.addEventListener('animationend', () => img.remove(), { once: true });
          burstEl.appendChild(img);
        }
      }, EMOJI_SPAWN_AT));
    }

    return () => {
      timeouts.forEach(clearTimeout);
      if (burstEl) burstEl.replaceChildren();
    };
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    const { signal } = ac;

    /* ---------- Config ---------- */
    const NUMBERS_PER_GAME = 7;
    const COLS = 6;
    let ROW_COUNTS = [6, 5, 6, 5, 6, 5, 6, 5, 6];
    let TOTAL_NUMBERS = ROW_COUNTS.reduce((a, b) => a + b, 0);

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

    /* ---------- DOM ---------- */
    const stage = document.getElementById('stage');
    const bubblesEl = document.getElementById('bubbles');
    const cloudLayerEl = document.getElementById('cloudLayer');
    const trayCountEl = document.getElementById('trayCount');
    const trayPageNumEl = document.getElementById('trayPageNum');
    const trayProgressBarEl = document.getElementById('trayProgressBar');
    const visibleRowEl = document.getElementById('visibleRow');
    const trayUpEl = document.getElementById('trayUp');
    const trayDownEl = document.getElementById('trayDown');
    const trayModalBtnEl = document.getElementById('trayModalBtn');
    const modalBackdropEl = document.getElementById('modalBackdrop');
    const modalEl = document.getElementById('modalEl');
    const modalFiltersEl = document.getElementById('modalFilters');
    const modalPlayBtnEl = document.getElementById('modalPlayBtn');
    const modalCloseEl = document.getElementById('modalClose');
    const modalRowsEl = document.getElementById('modalRows');
    const toastEl = document.getElementById('toast');
    const trayEl = document.querySelector('.tray');
    const gameMessageEl = document.getElementById('gameMessage');
    const gameMessageTextEl = document.getElementById('gameMessageText');
    const lottoManEl = document.getElementById('lottoManArc');
    const ctaPlayEl = document.getElementById('ctaPlay');
    const ctaResetEl = document.getElementById('ctaReset');
    const ctaRandomiseEl = document.getElementById('ctaRandomise');
    const ctaHelpEl = document.getElementById('ctaHelp');

    if (!stage) return; // skeleton not mounted yet

    /* ---------- Audio ---------- */
    const POP_SRC = '/bubble-pop.wav';
    const POP_POOL_SIZE = 8;

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
          try {
            audioCtx = new AC();
            loadPopBuffer();
          } catch (_) {}
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
      // file:// origins can't fetch local assets — but Next.js always serves
      // over http(s), so this guard is only here for static-export use.
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

    /* Short ascending major-triad chime played when a row/game completes.
       Tweak the constants below to adjust pitch, pacing, timbre, or volume.
       To swap for an mp3 instead: drop a file in /public/ (e.g.
       /public/row-complete.mp3) and replace this function body with
       `new Audio('/row-complete.mp3').play().catch(() => {});`. */
    const ROW_COMPLETE_NOTE_FREQS    = [523.25, 659.25, 783.99]; // C5, E5, G5
    const ROW_COMPLETE_NOTE_INTERVAL = 0.07;   // seconds between note onsets
    const ROW_COMPLETE_NOTE_DECAY    = 0.10;   // seconds of decay per note
    const ROW_COMPLETE_ATTACK        = 0.005;  // seconds of attack per note
    const ROW_COMPLETE_PEAK_GAIN     = 0.22;   // peak gain (0..1)
    const ROW_COMPLETE_OSC_TYPE      = 'sine'; // 'sine' or 'triangle'
    function playRowComplete() {
      if (!audioCtx) return;
      try {
        const t0 = audioCtx.currentTime;
        ROW_COMPLETE_NOTE_FREQS.forEach((freq, i) => {
          const start = t0 + i * ROW_COMPLETE_NOTE_INTERVAL;
          const osc = audioCtx.createOscillator();
          osc.type = ROW_COMPLETE_OSC_TYPE;
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
      if (!audioCtx) return;
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

    /* ---------- Haptics ---------- */
    // iPadOS reports platform "MacIntel" but exposes touch points, so
    // we cover that case alongside the obvious UA strings.
    const IS_IOS =
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

    let _hapticSwitch = null;
    function ensureHapticSwitch() {
      if (_hapticSwitch) return _hapticSwitch;
      const label = document.createElement('label');
      label.setAttribute('aria-hidden', 'true');
      // 1×1 invisible. Fully zero-sized inputs may be skipped by the
      // haptic engine; keep the box real, just out of sight.
      label.style.cssText =
        'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;';
      const input = document.createElement('input');
      input.type = 'checkbox';
      // The `switch` attribute is iOS 17.4+ / Safari 17.4+. On older
      // versions it is ignored and no haptic fires (silent no-op).
      input.setAttribute('switch', '');
      label.appendChild(input);
      document.body.appendChild(label);
      _hapticSwitch = { label, input };
      return _hapticSwitch;
    }
    function haptic(duration = 8) {
      // On iOS, navigator.vibrate exists in some browsers (e.g. Chrome
      // iOS) but is a silent no-op — taking that branch swallows the
      // call. Always route iOS to the switch-input fallback.
      if (IS_IOS) {
        try {
          // .click() toggles checked AND fires click + change events,
          // closer to a real user gesture than dispatching change alone.
          ensureHapticSwitch().input.click();
        } catch (_) {}
        return;
      }
      if (navigator.vibrate) {
        const ua = navigator.userActivation;
        if (ua && !ua.hasBeenActive) return;
        try { navigator.vibrate(duration); } catch (_) {}
      }
    }

    /* ---------- Bubble assets ---------- */
    const BUBBLE_INTACT_SRC = '/bubble-static.png';
    const BUBBLE_POPPED_SRC = '/bubble-popped.png';

    /* ---------- Cloud sprites ---------- */
    const CLOUD_PATTERNS = [
      [
        '....##....',
        '..######..',
        '##########',
        '##########',
        '.########.',
      ],
      [
        '......####....',
        '....########..',
        '.#############',
        '##############',
        '##############',
        '.############.',
      ],
      [
        '....######........',
        '..############....',
        '.###############..',
        '##################',
        '##################',
        '.################.',
        '..##############..',
      ],
      [
        '....######..',
        '..########..',
        '.##########.',
        '############',
        '############',
        '.##########.',
        '..########..',
      ],
    ];

    function drawCloudSprite(canvas, pattern, scale) {
      const cols = pattern[0].length;
      const rows = pattern.length;
      canvas.width = cols * scale;
      canvas.height = rows * scale;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#ffffff';
      for (let y = 0; y < rows; y++) {
        const line = pattern[y];
        for (let x = 0; x < cols; x++) {
          if (line[x] === '#') ctx.fillRect(x * scale, y * scale, scale, scale);
        }
      }
    }

    function spawnClouds() {
      if (!cloudLayerEl) return;
      cloudLayerEl.innerHTML = '';
      const stageH = stage.clientHeight || 500;
      const count = 5;
      for (let i = 0; i < count; i++) {
        const pattern = CLOUD_PATTERNS[Math.floor(Math.random() * CLOUD_PATTERNS.length)];
        const scale = 2 + Math.floor(Math.random() * 2);
        const cloud = document.createElement('canvas');
        cloud.className = 'cloud';
        drawCloudSprite(cloud, pattern, scale);
        const yMax = Math.max(60, stageH * 0.7);
        cloud.style.top = (16 + Math.random() * yMax) + 'px';
        const duration = 50 + Math.random() * 50;
        const delay = -Math.random() * duration;
        cloud.style.animation = `cloud-drift ${duration}s linear ${delay}s infinite`;
        cloudLayerEl.appendChild(cloud);
      }
    }

    function drawBurstSprite(canvas) {
      const S = canvas.width;
      const ctx = canvas.getContext('2d');
      const C = S / 2;
      ctx.clearRect(0, 0, S, S);
      const rings = [
        { r: S / 2 - 1, alpha: 1,   density: 0.7 },
        { r: S / 2 - 4, alpha: 0.6, density: 0.5 },
      ];
      for (const ring of rings) {
        ctx.fillStyle = ring.alpha === 1 ? '#ffffff' : 'rgba(255,255,255,0.6)';
        for (let y = 0; y < S; y++) {
          for (let x = 0; x < S; x++) {
            const dx = x + 0.5 - C;
            const dy = y + 0.5 - C;
            const d = Math.sqrt(dx * dx + dy * dy);
            if (d > ring.r - 0.6 && d <= ring.r + 0.4) {
              if (Math.random() < ring.density) ctx.fillRect(x, y, 1, 1);
            }
          }
        }
      }
    }

    /* ---------- Grid layout ---------- */
    const STRIP_H = 14;
    const VERTICAL_OVERLAP = 12;

    function computeLayout() {
      const rect = stage.getBoundingClientRect();
      const width = rect.width;
      const height = rect.height;
      const bubbleW = width / COLS;
      const radius = bubbleW / 2;
      const rowH = bubbleW - VERTICAL_OVERLAP;
      const startY = STRIP_H + radius;
      const startX = 0;

      const usableH = height - STRIP_H - bubbleW;
      const fitRows = Math.max(1, Math.floor(usableH / rowH) + 1);
      ROW_COUNTS = [];
      for (let r = 0; r < fitRows; r++) {
        // Even rows: COLS bubbles edge-to-edge.
        // Odd rows:  COLS+1 bubbles, first and last half-bleeding past
        //            the viewport for a hex-packed wrap-around look.
        ROW_COUNTS.push(r % 2 === 0 ? COLS : COLS + 1);
      }
      TOTAL_NUMBERS = ROW_COUNTS.reduce((a, b) => a + b, 0);

      ensureBubblePermutation(TOTAL_NUMBERS);

      const bubbles = [];
      let posIdx = 0;
      ROW_COUNTS.forEach((count, rowIdx) => {
        // For the wider odd rows, shift the row left by half a bubble so
        // the first bubble's centre sits on the viewport's left edge
        // (only its right half is visible) — and symmetrically on the right.
        const offset = count === COLS + 1 ? -bubbleW / 2 : 0;
        for (let i = 0; i < count; i++) {
          const cx = startX + offset + bubbleW * (i + 0.5);
          const cy = startY + rowH * rowIdx;
          bubbles.push({ num: bubbleNumPermutation[posIdx++], cx, cy, radius });
        }
      });

      const lastRowIdx = ROW_COUNTS.length - 1;
      const randCy = startY + rowH * lastRowIdx;
      const randCxStart = startX + bubbleW * 3;
      const randCxEnd = startX + bubbleW * 6 - 8;
      const randCx = (randCxStart + randCxEnd) / 2;
      const randW = randCxEnd - randCxStart;

      const gridTopY = bubbles[0].cy - radius;
      let gridBottomY = 0;
      for (const b of bubbles) gridBottomY = Math.max(gridBottomY, b.cy + b.radius);

      return {
        width, height, bubbles, bubbleW, rowH,
        gridTopY, gridBottomY,
        rand: { cx: randCx, cy: randCy, w: randW },
      };
    }

    /* ---------- Bubble render ---------- */
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
        el.style.left = (b.cx - b.radius) + 'px';
        el.style.top = (b.cy - b.radius) + 'px';
        el.style.width = (b.radius * 2) + 'px';
        el.style.height = (b.radius * 2) + 'px';
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

      const existing = stage.querySelector('.randomise');
      if (existing) existing.remove();
      const btn = document.createElement('button');
      btn.className = 'randomise';
      btn.textContent = 'RANDOMISE';
      btn.style.left = layout.rand.cx + 'px';
      btn.style.top = layout.rand.cy + 'px';
      btn.addEventListener('click', onRandomise);
      stage.appendChild(btn);
    }

    function spawnBurst(cx, cy, size) {
      const canvas = document.createElement('canvas');
      canvas.className = 'burst';
      canvas.width = 24;
      canvas.height = 24;
      drawBurstSprite(canvas);
      const s = size;
      canvas.style.left = (cx - s / 2) + 'px';
      canvas.style.top = (cy - s / 2) + 'px';
      canvas.style.width = s + 'px';
      canvas.style.height = s + 'px';
      bubblesEl.appendChild(canvas);
      canvas.addEventListener('animationend', () => canvas.remove(), { once: true });
    }

    function popBubble(num) {
      const state = bubbleStates.get(num);
      if (!state || state.popped || state.popping) return false;
      if (gameCompleting) return false;

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

    /* ---------- Sheet refill ---------- */
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
      for (const state of bubbleStates.values()) {
        state.popped = false;
        state.popping = false;
      }
      bubbleNumPermutation = null;
      rebuild();
      bubblesEl.classList.remove('slide-in');
      void bubblesEl.offsetWidth;
      bubblesEl.classList.add('slide-in');
      bubblesEl.addEventListener('animationend', function onSlideEnd() {
        bubblesEl.classList.remove('slide-in');
        bubblesEl.removeEventListener('animationend', onSlideEnd);
      });
      playSwoosh();
    }

    /* ---------- Selection & games tray ---------- */
    let currentGame = 0;
    let currentSelections = [];
    const allGames = [];
    let viewedGameIdx = 0;

    const BALL_IMAGES = [
      '/img/ball_purple.png',
      '/img/ball_blue.png',
      '/img/ball_green.png',
      '/img/ball_yellow.png',
      '/img/ball_orange.png',
      '/img/ball_pink.png',
    ];
    const HOT_NUMBERS = new Set([3, 7, 11, 17, 23, 27, 33, 42]);
    const COLD_NUMBERS = new Set([1, 9, 14, 19, 25, 31, 36, 41]);
    function isHotNumber(n) { return HOT_NUMBERS.has(n); }
    function temperatureClass(n) {
      if (HOT_NUMBERS.has(n)) return 'is-hot';
      if (COLD_NUMBERS.has(n)) return 'is-cold';
      return 'is-neutral';
    }

    function makeSlot(value, isActiveRow) {
      const slot = document.createElement('div');
      slot.className = 'slot';
      if (value != null) {
        slot.classList.add('filled');
        slot.classList.add(temperatureClass(value));
        const idx = Math.abs(value - 1) % BALL_IMAGES.length;
        slot.style.setProperty('--ball-img', `url('${BALL_IMAGES[idx]}')`);
        const num = document.createElement('span');
        num.className = 'num';
        num.textContent = value;
        slot.appendChild(num);
      } else if (isActiveRow) {
        slot.classList.add('active-row');
      }
      return slot;
    }

    function rowSlotsFor(idx) {
      const isActive = idx === currentGame;
      const nums = isActive ? currentSelections : (allGames[idx] || []);
      return { isActive, nums };
    }

    function renderTray(entryAnim = 'appear') {
      const { isActive, nums } = rowSlotsFor(viewedGameIdx);

      visibleRowEl.innerHTML = '';
      visibleRowEl.classList.remove('appear', 'row-slide-in', 'row-out');
      void visibleRowEl.offsetWidth;
      visibleRowEl.classList.add(entryAnim);
      for (let i = 0; i < NUMBERS_PER_GAME; i++) {
        const slot = makeSlot(nums[i], isActive);
        visibleRowEl.appendChild(slot);
      }

      const pct = (currentSelections.length / NUMBERS_PER_GAME) * 100;
      trayProgressBarEl.style.width = pct + '%';

      const completed = currentGame;
      trayCountEl.textContent = `${completed} GAME${completed === 1 ? '' : 'S'}`;
      trayPageNumEl.textContent = `...${viewedGameIdx + 1}`;

      trayUpEl.disabled = viewedGameIdx <= 0;
      trayDownEl.disabled = viewedGameIdx >= currentGame;

      if (ctaPlayEl) {
        ctaPlayEl.classList.toggle('is-disabled',
          currentGame === 0 && currentSelections.length === 0);
      }
    }

    let gameCompleting = false;

    /* Fired when a row/game completes: pops the "GAME N+1" banner up
       from behind the tray, and sends the lotto-man on a single arcing
       jump from off-screen left to off-screen right. Both clear their
       active class on animationend so they can re-fire next completion. */
    function triggerGameCompleteCelebration() {
      if (gameMessageEl && gameMessageTextEl) {
        gameMessageTextEl.textContent = `GAME ${currentGame + 2}`;
        if (trayEl) {
          const h = trayEl.getBoundingClientRect().height;
          if (h > 0) gameMessageEl.style.setProperty('--tray-h', h + 'px');
        }
        gameMessageEl.classList.remove('is-active');
        void gameMessageEl.offsetWidth;
        gameMessageEl.classList.add('is-active');
        gameMessageEl.addEventListener('animationend', function onMsgEnd() {
          gameMessageEl.classList.remove('is-active');
          gameMessageEl.removeEventListener('animationend', onMsgEnd);
        });
      }
      if (lottoManEl) {
        const lowJump = !!(trayEl && trayEl.classList.contains('is-collapsed'));
        const jumpClass = lowJump ? 'is-jumping-low' : 'is-jumping';
        lottoManEl.classList.remove('is-jumping', 'is-jumping-low');
        void lottoManEl.offsetWidth;
        lottoManEl.classList.add(jumpClass);
        lottoManEl.addEventListener('animationend', function onJumpEnd() {
          lottoManEl.classList.remove('is-jumping', 'is-jumping-low');
          lottoManEl.removeEventListener('animationend', onJumpEnd);
        });
      }
    }

    function addSelected(num) {
      currentSelections.push(num);
      viewedGameIdx = currentGame;

      if (currentSelections.length >= NUMBERS_PER_GAME) {
        gameCompleting = true;
        allGames[currentGame] = [...currentSelections];
        renderTray();
        if (modalOpen) renderModal();
        playRowComplete();
        triggerGameCompleteCelebration();

        visibleRowEl.classList.remove('appear', 'row-slide-in');
        void visibleRowEl.offsetWidth;
        visibleRowEl.classList.add('row-out');
        visibleRowEl.addEventListener('animationend', function onSlideOut(e) {
          if (e.animationName !== 'row-slide-out') return;
          visibleRowEl.removeEventListener('animationend', onSlideOut);
          currentGame++;
          currentSelections = [];
          viewedGameIdx = currentGame;
          renderTray('row-slide-in');
          if (modalOpen) renderModal();
          gameCompleting = false;
        });
        return;
      }

      renderTray();
      if (modalOpen) renderModal();
    }

    trayUpEl.addEventListener('click', () => {
      if (viewedGameIdx > 0) {
        viewedGameIdx--;
        renderTray();
      }
    }, { signal });
    trayDownEl.addEventListener('click', () => {
      if (viewedGameIdx < currentGame) {
        viewedGameIdx++;
        renderTray();
      }
    }, { signal });

    /* Swipe up/down on the slot row mirrors the trayUp/trayDown buttons.
       Calling .click() on a disabled button is a no-op, so the at-edge
       cases (no previous/next row) are handled automatically. */
    const SWIPE_VERTICAL_THRESHOLD = 30;  // px of vertical motion to fire a swipe
    const TAP_MAX_MOVEMENT = 10;          // total motion below this stays a tap
    let swipeStart = null;
    let swipeMaxMove = 0;

    visibleRowEl.addEventListener('pointerdown', (ev) => {
      swipeStart = { x: ev.clientX, y: ev.clientY, pointerId: ev.pointerId };
      swipeMaxMove = 0;
      try { visibleRowEl.setPointerCapture(ev.pointerId); } catch (_) {}
    }, { signal });

    visibleRowEl.addEventListener('pointermove', (ev) => {
      if (!swipeStart || ev.pointerId !== swipeStart.pointerId) return;
      const dx = ev.clientX - swipeStart.x;
      const dy = ev.clientY - swipeStart.y;
      const dist = Math.hypot(dx, dy);
      if (dist > swipeMaxMove) swipeMaxMove = dist;
    }, { signal });

    const endSwipe = (ev) => {
      if (!swipeStart || ev.pointerId !== swipeStart.pointerId) return;
      const start = swipeStart;
      const totalMove = swipeMaxMove;
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      swipeStart = null;
      try { visibleRowEl.releasePointerCapture(start.pointerId); } catch (_) {}

      if (totalMove < TAP_MAX_MOVEMENT) return;            // tap, not swipe
      if (Math.abs(dy) < SWIPE_VERTICAL_THRESHOLD) return; // not enough vertical
      if (Math.abs(dy) < Math.abs(dx)) return;             // mostly horizontal
      if (dy < 0) trayUpEl.click();
      else trayDownEl.click();
    };
    visibleRowEl.addEventListener('pointerup', endSwipe, { signal });
    visibleRowEl.addEventListener('pointercancel', endSwipe, { signal });

    /* ---------- Modal ---------- */
    let modalOpen = false;
    function openModal() {
      modalOpen = true;
      modalBackdropEl.classList.add('visible');
      renderModal();
    }
    function closeModal() {
      modalOpen = false;
      modalBackdropEl.classList.remove('visible');
    }
    function gameHeat(nums) {
      if (!nums || nums.length < NUMBERS_PER_GAME) return null;
      const hotCount = nums.reduce((acc, n) => acc + (isHotNumber(n) ? 1 : 0), 0);
      return hotCount >= 2 ? 'hot' : 'cold';
    }

    const selectedGames = new Set();
    let modalFilter = 'all';     // 'all' | 'hot' | 'cold'
    let modalSort = null;        // null | 'asc' (cold→hot) | 'desc' (hot→cold)
    const modalSortBtnEl = document.getElementById('modalSortBtn');

    function syncActionBar() {
      modalEl.classList.toggle('has-action-bar', selectedGames.size > 0);
    }

    function renderModal() {
      modalRowsEl.innerHTML = '';
      const totalRows = currentGame + 1;

      // Build the order in which to render rows. Default is chronological;
      // sort cycles through asc (cold→hot) and desc (hot→cold). Incomplete
      // games (no heat) always sort to the end so they don't get jumbled
      // among rated games.
      const indices = [];
      for (let g = 0; g < totalRows; g++) indices.push(g);
      if (modalSort) {
        const heatRank = (g) => {
          const isActive = g === currentGame;
          const nums = isActive ? currentSelections : allGames[g];
          const heat = gameHeat(nums);
          if (heat === 'hot') return 2;
          if (heat === 'cold') return 1;
          return 0;
        };
        indices.sort((a, b) => {
          const ra = heatRank(a);
          const rb = heatRank(b);
          if (ra === 0 && rb !== 0) return 1;
          if (rb === 0 && ra !== 0) return -1;
          if (ra === rb) return a - b; // stable within same heat
          return modalSort === 'asc' ? ra - rb : rb - ra;
        });
      }

      for (const g of indices) {
        const isActive = g === currentGame;
        const nums = isActive ? currentSelections : allGames[g];
        const heat = gameHeat(nums);

        if (modalFilter !== 'all' && heat !== modalFilter) continue;

        const row = document.createElement('div');
        row.className = 'modal-row';

        const labelCell = document.createElement('div');
        labelCell.className = 'modal-row-label';

        const labelText = document.createElement('span');
        labelText.textContent = `G${g + 1}`;
        if (heat) {
          const heatDot = document.createElement('span');
          heatDot.className = `modal-row-heat heat-${heat}`;
          heatDot.title = heat;
          labelText.appendChild(heatDot);
        }
        labelCell.appendChild(labelText);

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'modal-checkbox';
        cb.checked = selectedGames.has(g);
        cb.disabled = isActive && (!nums || nums.length < NUMBERS_PER_GAME);
        cb.addEventListener('change', () => {
          if (cb.checked) selectedGames.add(g);
          else selectedGames.delete(g);
          syncActionBar();
        });
        labelCell.appendChild(cb);

        row.appendChild(labelCell);

        for (let i = 0; i < NUMBERS_PER_GAME; i++) {
          row.appendChild(makeSlot(nums[i], isActive));
        }
        modalRowsEl.appendChild(row);
      }

      syncActionBar();

      requestAnimationFrame(() => {
        modalRowsEl.scrollTop = modalRowsEl.scrollHeight;
      });
    }

    modalFiltersEl.addEventListener('click', (ev) => {
      const btn = ev.target.closest('.filter-pill');
      if (!btn) return;
      modalFilter = btn.dataset.heat;
      modalFiltersEl.querySelectorAll('.filter-pill').forEach((p) => {
        p.classList.toggle('active', p.dataset.heat === modalFilter);
      });
      renderModal();
    }, { signal });

    if (modalSortBtnEl) {
      modalSortBtnEl.addEventListener('click', () => {
        // Cycle: off → asc → desc → off
        if (modalSort === null) modalSort = 'asc';
        else if (modalSort === 'asc') modalSort = 'desc';
        else modalSort = null;
        modalSortBtnEl.classList.toggle('asc', modalSort === 'asc');
        modalSortBtnEl.classList.toggle('desc', modalSort === 'desc');
        renderModal();
      }, { signal });
    }

    modalPlayBtnEl.addEventListener('click', () => {
      const n = selectedGames.size;
      if (n === 0) return;
      showToast(`Played ${n} game${n === 1 ? '' : 's'}!`);
      selectedGames.clear();
      renderModal();
    }, { signal });

    /* The tray's NE-arrow button now toggles the panel between expanded
       (default) and collapsed (only the head strip visible) instead of
       opening the modal. The modal is still reachable via the
       PLAY NUMBERS CTA below — but that button is hidden in the
       collapsed state, so the modal is only accessible when expanded. */
    function syncTrayToggleAria() {
      const collapsed = trayEl.classList.contains('is-collapsed');
      trayModalBtnEl.setAttribute(
        'aria-label', collapsed ? 'Expand panel' : 'Collapse panel');
      trayModalBtnEl.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    }
    syncTrayToggleAria();
    let trayToggleRebuildTimer = null;
    trayModalBtnEl.addEventListener('click', () => {
      trayEl.classList.toggle('is-collapsed');
      syncTrayToggleAria();
      // Re-layout bubbles after the panel transition (300ms) so the
      // grid fills the freed viewport space (or shrinks when expanding).
      clearTimeout(trayToggleRebuildTimer);
      trayToggleRebuildTimer = setTimeout(rebuild, 320);
    }, { signal });
    modalCloseEl.addEventListener('click', closeModal, { signal });
    modalBackdropEl.addEventListener('click', (ev) => {
      if (ev.target === modalBackdropEl) closeModal();
    }, { signal });
    window.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && modalOpen) closeModal();
    }, { signal });

    // PLAY NUMBERS now opens the modal — the actual "play" action lives on
    // the modal's own PLAY NUMBERS button after games are selected.
    ctaPlayEl.addEventListener('click', openModal, { signal });

    ctaResetEl.addEventListener('click', () => {
      if (currentSelections.length === 0) {
        showToast('Nothing to reset.');
        return;
      }
      for (const num of currentSelections) {
        const state = bubbleStates.get(num);
        if (state) { state.popped = false; state.popping = false; }
        const el = bubbleEls.get(num);
        if (el) {
          el.classList.remove('popped', 'popping');
          const img = el.querySelector('img');
          if (img) img.src = BUBBLE_INTACT_SRC;
        }
      }
      currentSelections = [];
      viewedGameIdx = currentGame;
      renderTray();
      if (modalOpen) renderModal();
    }, { signal });

    if (ctaRandomiseEl) {
      ctaRandomiseEl.addEventListener('click', onRandomise, { signal });
    }

    ctaHelpEl.addEventListener('click', () => {
      showToast('Pop bubbles to pick numbers. 7 per ticket.');
    }, { signal });

    function onRandomise() {
      ensureAudio();
      const needed = NUMBERS_PER_GAME - currentSelections.length;
      const available = [];
      for (let n = 1; n <= TOTAL_NUMBERS; n++) {
        const s = bubbleStates.get(n);
        if (s && !s.popped && !s.popping && !currentSelections.includes(n)) {
          available.push(n);
        }
      }
      if (available.length < needed) return;
      for (let i = available.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [available[i], available[j]] = [available[j], available[i]];
      }
      const picks = available.slice(0, needed);
      picks.forEach((n, k) => setTimeout(() => popBubble(n), k * 90));
    }

    /* ---------- Toast ---------- */
    let toastTimer = null;
    function showToast(msg) {
      toastEl.textContent = msg;
      toastEl.classList.add('visible');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toastEl.classList.remove('visible'), 1800);
    }

    /* ---------- Resize & boot ---------- */
    let layout;
    function positionSheetEdges(layout) {
      const top = stage.querySelector('.sheet-edge-top');
      const bot = stage.querySelector('.sheet-edge-bottom');
      // Strips overlap into the bubble grid by 10px so the visible bubble
      // tops/bottoms (which sit inside transparent PNG padding) sit closer
      // to the wrap edges.
      if (top) top.style.top    = (layout.gridTopY    - STRIP_H + 10) + 'px';
      if (bot) bot.style.top    = (layout.gridBottomY - 10) + 'px';
    }
    function rebuild() {
      layout = computeLayout();
      renderBubbles(layout);
      positionSheetEdges(layout);
    }
    window.addEventListener('resize', rebuild, { signal });

    rebuild();
    spawnClouds();
    renderTray();

    return () => {
      ac.abort();
      // Tear down dynamically inserted nodes so a strict-mode remount
      // doesn't double-stack bubbles, clouds, or the haptic switch.
      if (bubblesEl) bubblesEl.innerHTML = '';
      if (cloudLayerEl) cloudLayerEl.innerHTML = '';
      const rand = stage && stage.querySelector('.randomise');
      if (rand) rand.remove();
      if (_hapticSwitch && _hapticSwitch.label.parentNode) {
        _hapticSwitch.label.parentNode.removeChild(_hapticSwitch.label);
      }
      // Stop any in-flight audio
      if (audioCtx) audioCtx.close().catch(() => {});
    };
  }, []);

  return (
    <>
      <div className="intro-overlay" id="introOverlay">
        <div className="intro-panel">
          <div className="intro-cloud-bg" />
          <div className="intro-logo">
            <div className="intro-shadow" />
            <div className="intro-rainbow" />
            <div className="intro-the" />
            <div className="intro-lott" />
          </div>
          <div className="intro-emoji-burst" id="introEmojiBurst" />
        </div>
      </div>

      <div className="stage" id="stage">
        <div className="lotto-man-arc" id="lottoManArc">
          <div className="lotto-man-jump-img" />
        </div>
        <div id="cloudLayer" />
        <div className="sheet-edge sheet-edge-top" />
        <div id="bubbles" />
        <div className="sheet-edge sheet-edge-bottom" />
        <div className="status-spacer" />
        <div className="toast" id="toast" />
      </div>

      <div className="tray">
        <span className="tray-corner-bl" />
        <span className="tray-corner-br" />
        <div className="tray-head">
          <button
            className="tray-modal-btn"
            id="trayModalBtn"
            type="button"
            aria-label="View all games"
          />
          <div className="tray-progress" aria-hidden="true">
            <div className="tray-progress-bar" id="trayProgressBar" />
          </div>
          <span className="tray-page-num" id="trayPageNum">
            ...1
          </span>
        </div>
        <div className="tray-label" id="trayCount">
          0 GAMES
        </div>
        <div className="tray-row-wrapper">
          <div className="tray-nav">
            <button
              className="tray-arrow tray-up"
              id="trayUp"
              type="button"
              aria-label="Previous game"
            />
            <button
              className="tray-arrow tray-down"
              id="trayDown"
              type="button"
              aria-label="Next game"
            />
          </div>
          <div className="game-row" id="visibleRow" />
        </div>
        <div className="tray-ctas">
          <button
            className="cta cta-icon cta-reset"
            id="ctaReset"
            type="button"
            aria-label="Reset"
          />
          <button
            className="cta cta-icon cta-randomise"
            id="ctaRandomise"
            type="button"
            aria-label="Randomise"
          />
          <button
            className="cta cta-help"
            id="ctaHelp"
            type="button"
            aria-label="How to play"
          >
            ?
          </button>
          <button className="cta cta-primary" id="ctaPlay" type="button">
            PLAY NUMBERS
          </button>
        </div>
      </div>

      <div className="game-message" id="gameMessage">
        <span className="game-message-text" id="gameMessageText" />
      </div>

      <div className="modal-backdrop" id="modalBackdrop">
        <div
          className="modal"
          id="modalEl"
          role="dialog"
          aria-label="All your numbers"
        >
          <div className="modal-head">
            <span>YOUR NUMBERS</span>
            <button
              className="modal-close"
              id="modalClose"
              type="button"
              aria-label="Close"
            >
              x
            </button>
          </div>
          <div className="modal-filters" id="modalFilters">
            <div className="modal-filters-group">
              <button
                className="filter-pill all active"
                data-heat="all"
                type="button"
              >
                ALL
              </button>
              <button
                className="filter-pill hot"
                data-heat="hot"
                type="button"
              >
                HOT
              </button>
              <button
                className="filter-pill cold"
                data-heat="cold"
                type="button"
              >
                COLD
              </button>
            </div>
            <button
              className="modal-sort-btn"
              id="modalSortBtn"
              type="button"
              aria-label="Sort by heat"
            >
              SORT
            </button>
          </div>
          <div className="modal-rows" id="modalRows" />
          <div className="modal-action-bar">
            <button
              className="cta cta-primary"
              id="modalPlayBtn"
              type="button"
            >
              PLAY NUMBERS
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
