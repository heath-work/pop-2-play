// Read a few pixels from bubble-static.png and report rgba
import { readFileSync } from 'fs';
import { PNG } from 'pngjs';

const file = process.argv[2];
const buf = readFileSync(file);
const png = PNG.sync.read(buf);
console.log(`${file}: ${png.width}x${png.height}`);
const probe = (x, y) => {
  const i = (png.width * y + x) * 4;
  return `${x},${y}: rgba(${png.data[i]}, ${png.data[i+1]}, ${png.data[i+2]}, ${png.data[i+3]})`;
};
console.log(probe(2, 2));               // corner (likely bg)
console.log(probe(10, 10));             // near corner
console.log(probe(56, 5));              // top of bubble (probably highlight)
console.log(probe(56, 56));             // center of bubble
console.log(probe(20, 56));             // left edge of bubble
console.log(probe(56, 100));            // bottom of bubble
// Sample edge to see if bg is transparent
console.log(probe(0, 56));
console.log(probe(112, 56));
