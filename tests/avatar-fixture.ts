import { PNG } from "pngjs";
export function avatarPNG(seed = 0) {
  const image = new PNG({ width: 256, height: 256 });
  for (let i = 0; i < image.data.length; i += 4) {
    image.data[i] = (i / 4 + seed) % 256;
    image.data[i + 1] = 80;
    image.data[i + 2] = 160;
    image.data[i + 3] = 255;
  }
  return PNG.sync.write(image);
}
