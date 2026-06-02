import puppeteer from 'puppeteer';

const url = process.argv[2] || 'http://localhost:3001/';
const out = process.argv[3] || '/tmp/p2p-shots/headless.png';
const waitMs = parseInt(process.argv[4] || '1500', 10);

const browser = await puppeteer.launch({
  headless: true,
  defaultViewport: { width: 430, height: 932, deviceScaleFactor: 2 },
});
const page = await browser.newPage();
page.on('pageerror', e => console.error('[pageerror]', e.message));
page.on('console', m => {
  if (m.type() === 'error' || m.type() === 'warning') {
    console.error(`[console.${m.type()}]`, m.text());
  }
});
await page.goto(url, { waitUntil: 'networkidle0' });
await new Promise(r => setTimeout(r, waitMs));
const cropY = process.argv[5] ? parseInt(process.argv[5], 10) : null;
const opts = { path: out, fullPage: false };
if (cropY != null) {
  opts.clip = { x: 0, y: cropY, width: 430, height: 932 - cropY };
}
await page.screenshot(opts);
console.log('saved', out);
await browser.close();
