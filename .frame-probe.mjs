import { readFileSync } from 'fs';
import { PNG } from 'pngjs';
const png = PNG.sync.read(readFileSync('public/bubble-frame.png'));
console.log(`${png.width}x${png.height}`);
const probe = (x, y) => {
  const i = (png.width * y + x) * 4;
  return `${x},${y}: rgba(${png.data[i]},${png.data[i+1]},${png.data[i+2]},${png.data[i+3]})`;
};
// Sample a grid
for (let y = 0; y <= 1098; y += 100) {
  let line = `y=${y}: `;
  for (let x = 0; x <= 700; x += 100) {
    const i = (png.width * y + Math.min(x, png.width - 1)) * 4;
    const a = png.data[i + 3];
    line += a > 50 ? 'X' : '.';
  }
  console.log(line);
}
