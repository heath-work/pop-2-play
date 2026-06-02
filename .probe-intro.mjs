import { readFileSync } from 'fs';
import { PNG } from 'pngjs';
const png = PNG.sync.read(readFileSync('public/intro-bubble.png'));
console.log(`${png.width}x${png.height}`);
const probe = (x, y) => {
  const i = (png.width * y + x) * 4;
  return `${x},${y}: rgba(${png.data[i]},${png.data[i+1]},${png.data[i+2]},${png.data[i+3]})`;
};
console.log(probe(2, 2));                    // far corner
console.log(probe(134, 134));                // dead center
console.log(probe(134, 30));                 // top center
console.log(probe(134, 240));                // bottom center
console.log(probe(30, 134));                 // left center
console.log(probe(240, 134));                // right center
console.log(probe(100, 80));                 // upper-left interior
console.log(probe(180, 200));                // lower-right interior
