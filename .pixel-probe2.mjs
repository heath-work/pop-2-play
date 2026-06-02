import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';
import { readFileSync } from 'fs';

const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 430, height: 932, deviceScaleFactor: 1 });
await page.goto('http://localhost:3001/', { waitUntil: 'networkidle0' });
await new Promise(r => setTimeout(r, 1000));

const cs = await page.evaluate(() => {
  const stage = document.getElementById('stage');
  const win = window.getComputedStyle(stage);
  return {
    bg: win.background?.slice(0, 200),
    rect: stage.getBoundingClientRect().toJSON(),
  };
});
console.log('stage:', JSON.stringify(cs, null, 2));

// Probe by HIDING all bubbles to see naked bg
await page.evaluate(() => {
  document.querySelectorAll('.bubble').forEach(b => b.style.visibility = 'hidden');
});
await page.screenshot({ path: '/tmp/p2p-shots/no-bubbles.png' });
const buf = readFileSync('/tmp/p2p-shots/no-bubbles.png');
const png = PNG.sync.read(buf);
const probe = (x, y, label) => {
  const i = (png.width * y + x) * 4;
  console.log(`${label} @ ${x},${y}: rgba(${png.data[i]}, ${png.data[i+1]}, ${png.data[i+2]}, ${png.data[i+3]})`);
};
probe(200, 100, 'stage at y=100 (no bubble)');
probe(200, 300, 'stage at y=300');
probe(200, 500, 'stage at y=500');
probe(200, 700, 'tray area at y=700');
await browser.close();
