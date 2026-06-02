import puppeteer from 'puppeteer';

const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();
page.on('console', m => console.log(`[${m.type()}]`, m.text()));
page.on('pageerror', e => console.error('[pageerror]', e.message));
await page.setViewport({ width: 430, height: 932, deviceScaleFactor: 1 });
await page.goto('http://localhost:3001/?autopop=2', { waitUntil: 'networkidle0' });
await new Promise(r => setTimeout(r, 2500));

const data = await page.evaluate(() => {
  const rings = Array.from(document.querySelectorAll('.ring'));
  const cvs = document.getElementById('trayBallCanvas');
  const trayRings = document.getElementById('trayRings');
  return {
    ringCount: rings.length,
    ringRects: rings.map(r => {
      const b = r.getBoundingClientRect();
      return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) };
    }),
    canvasRect: cvs ? cvs.getBoundingClientRect().toJSON() : null,
    canvasSize: cvs ? { w: cvs.width, h: cvs.height, cssW: cvs.style.width, cssH: cvs.style.height } : null,
    trayRingsRect: trayRings.getBoundingClientRect().toJSON(),
  };
});
console.log(JSON.stringify(data, null, 2));
await browser.close();
