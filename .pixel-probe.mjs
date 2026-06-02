import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';
import { readFileSync } from 'fs';

const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 430, height: 932, deviceScaleFactor: 1 });
await page.goto('http://localhost:3001/', { waitUntil: 'networkidle0' });
await new Promise(r => setTimeout(r, 1000));

// Get the bbox of a specific bubble so we know where to probe
const bbox = await page.evaluate(() => {
  const b = document.querySelector('.bubble');
  const r = b.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
});
console.log('bubble bbox:', bbox);

await page.screenshot({ path: '/tmp/p2p-shots/probe.png' });
const buf = readFileSync('/tmp/p2p-shots/probe.png');
const png = PNG.sync.read(buf);
const probe = (x, y, label) => {
  const i = (png.width * y + x) * 4;
  console.log(`${label} @ ${x},${y}: rgba(${png.data[i]}, ${png.data[i+1]}, ${png.data[i+2]}, ${png.data[i+3]})`);
};
// Center of first bubble
probe(Math.floor(bbox.x + bbox.w / 2), Math.floor(bbox.y + bbox.h / 2), 'bubble center');
// Top of first bubble (highlight area)
probe(Math.floor(bbox.x + bbox.w / 2), Math.floor(bbox.y + 5), 'bubble top');
// Outside bubble area (gap between rows / bg)
probe(2, 2, 'top-left of page');
// Below the stage (status spacer area)
probe(20, Math.floor(bbox.y) - 30, 'above bubbles (status?)');
await browser.close();
