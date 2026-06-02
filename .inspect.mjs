import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';
import { readFileSync } from 'fs';

const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 430, height: 932, deviceScaleFactor: 1 });
await page.goto('http://localhost:3001/?autopop=2', { waitUntil: 'networkidle0' });
await new Promise(r => setTimeout(r, 2500));

const rects = await page.evaluate(() => {
  const popped = document.querySelector('.bubble.popped');
  const intact = document.querySelector('.bubble:not(.popped)');
  return {
    popped: popped.getBoundingClientRect().toJSON(),
    intact: intact.getBoundingClientRect().toJSON(),
  };
});

await page.screenshot({ path: '/tmp/p2p-shots/v29-deep.png' });
const png = PNG.sync.read(readFileSync('/tmp/p2p-shots/v29-deep.png'));
const probe = (x, y, label) => {
  const i = (png.width * Math.round(y) + Math.round(x)) * 4;
  console.log(`${label} (${Math.round(x)},${Math.round(y)}): rgba(${png.data[i]},${png.data[i+1]},${png.data[i+2]},${png.data[i+3]})`);
};
const pr = rects.popped, ir = rects.intact;
probe(pr.x + pr.width/2, pr.y + pr.height/2, 'POPPED center');
probe(pr.x + 5, pr.y + 5, 'POPPED corner');
probe(ir.x + ir.width/2, ir.y + ir.height/2, 'INTACT center');
probe(ir.x + 5, ir.y + 5, 'INTACT corner');
probe(ir.x + ir.width + 5, ir.y + ir.height/2, 'BG just right of intact');
await browser.close();
