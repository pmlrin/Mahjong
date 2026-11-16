// Slim the Seed-san VRM for the 3D table's arms: only the body, suit and
// clothes are drawn there, small and far away. Reads the original download and
// writes a much smaller copy:
// - drops the head, hair, backpack, robot arm and other unused primitives;
// - drops VRM data the table never uses (expressions, first-person, look-at,
//   spring bones, thumbnail);
// - drops normal maps, halves the two colour textures and replaces images
//   nothing uses any more with a 1×1 placeholder;
// - rebuilds the binary chunk with only the data still referenced.
// Usage: node --import tsx scripts/slim-figure.ts <original.vrm> <out.vrm>
import { readFileSync, writeFileSync } from "node:fs";
import { PNG } from "pngjs";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error("usage: slim-figure.ts <original.vrm> <out.vrm>");
  process.exit(1);
}

/** Materials the table draws (see SHOWN in frontend/src/table3d/arms.tsx). */
const KEEP_MATERIALS = new Set(["body_bake", "body_nm", "huku_bake"]);
/** Meshes hidden on the table whatever their materials. */
const DROP_MESHES = /^(head|hair)/;
/** Colour textures are drawn at most a few hundred pixels across. */
const MAX_SIZE = 512;

const glb = readFileSync(input);
if (glb.readUInt32LE(0) !== 0x46546c67) throw new Error("not a GLB file");
const jsonLength = glb.readUInt32LE(12);
const json: Json = JSON.parse(glb.subarray(20, 20 + jsonLength).toString());
const binStart = 20 + jsonLength + 8;
const bin = glb.subarray(
  binStart,
  binStart + glb.readUInt32LE(20 + jsonLength),
);
const viewBytes = (i: number) => {
  const v = json.bufferViews[i];
  const at = v.byteOffset ?? 0;
  return bin.subarray(at, at + v.byteLength);
};

// Meshes: keep only drawn primitives; nodes lose meshes that end up empty.
const meshIndex = new Map<number, number>();
const meshes: Json[] = [];
json.meshes.forEach((mesh: Json, i: number) => {
  if (DROP_MESHES.test(mesh.name)) return;
  const primitives = mesh.primitives.filter((p: Json) =>
    KEEP_MATERIALS.has(json.materials[p.material]?.name),
  );
  if (!primitives.length) return;
  meshIndex.set(i, meshes.length);
  meshes.push({ ...mesh, primitives });
});
json.meshes = meshes;
for (const node of json.nodes) {
  if (node.mesh === undefined) continue;
  const kept = meshIndex.get(node.mesh);
  if (kept === undefined) {
    delete node.mesh;
    delete node.skin;
    delete node.weights;
  } else node.mesh = kept;
}

// VRM data the table does not use (some of it points at dropped meshes).
const vrm = json.extensions.VRMC_vrm;
delete vrm.expressions;
delete vrm.firstPerson;
delete vrm.lookAt;
delete vrm.meta.thumbnailImage;
delete json.extensions.VRMC_springBone;
json.extensionsUsed = json.extensionsUsed.filter(
  (e: string) => e !== "VRMC_springBone",
);

// Textures still read by the kept materials, without normal maps.
const kept = new Set<number>(
  meshes.flatMap((m) => m.primitives.map((p: Json) => p.material)),
);
const usedImages = new Set<number>();
const walk = (o: Json) => {
  if (!o || typeof o !== "object") return;
  for (const [key, value] of Object.entries<Json>(o)) {
    if (key === "normalTexture") delete o[key];
    else if (/Texture$/.test(key) && typeof value?.index === "number")
      usedImages.add(json.textures[value.index].source);
    else walk(value);
  }
};
for (const i of kept) walk(json.materials[i]);

// New image bytes: halved colour textures, a placeholder for the rest.
const encode = (png: PNG) => PNG.sync.write(png, { colorType: 2 });
const placeholder = (() => {
  const png = new PNG({ width: 1, height: 1 });
  png.data.set([128, 128, 128, 255]);
  return encode(png);
})();
function shrink(bytes: Buffer) {
  let png: PNG = PNG.sync.read(bytes);
  while (png.width > MAX_SIZE || png.height > MAX_SIZE) {
    const half = new PNG({ width: png.width >> 1, height: png.height >> 1 });
    for (let y = 0; y < half.height; y++)
      for (let x = 0; x < half.width; x++)
        for (let c = 0; c < 4; c++) {
          let sum = 0;
          for (const [dx, dy] of [
            [0, 0],
            [1, 0],
            [0, 1],
            [1, 1],
          ])
            sum += png.data[((2 * y + dy) * png.width + 2 * x + dx) * 4 + c];
          half.data[(y * half.width + x) * 4 + c] = Math.round(sum / 4);
        }
    png = half;
  }
  return encode(png);
}
const imageBytes = new Map<number, Buffer>();
json.images.forEach((image: Json, i: number) => {
  image.mimeType = "image/png";
  imageBytes.set(
    i,
    usedImages.has(i) ? shrink(viewBytes(image.bufferView)) : placeholder,
  );
});

// Accessors still referenced, renumbered.
const accessorIndex = new Map<number, number>();
const useAccessor = (i: number) => {
  if (!accessorIndex.has(i)) accessorIndex.set(i, accessorIndex.size);
  return accessorIndex.get(i)!;
};
for (const mesh of meshes)
  for (const p of mesh.primitives) {
    for (const k of Object.keys(p.attributes))
      p.attributes[k] = useAccessor(p.attributes[k]);
    if (p.indices !== undefined) p.indices = useAccessor(p.indices);
    for (const target of p.targets ?? [])
      for (const k of Object.keys(target)) target[k] = useAccessor(target[k]);
  }
for (const skin of json.skins ?? [])
  if (skin.inverseBindMatrices !== undefined)
    skin.inverseBindMatrices = useAccessor(skin.inverseBindMatrices);
for (const animation of json.animations ?? [])
  for (const sampler of animation.samplers) {
    sampler.input = useAccessor(sampler.input);
    sampler.output = useAccessor(sampler.output);
  }
const accessors: Json[] = [];
for (const [old, i] of accessorIndex) accessors[i] = json.accessors[old];
json.accessors = accessors;

// Buffer views still referenced, packed into a new binary chunk.
const chunks: Buffer[] = [];
let length = 0;
const bufferViews: Json[] = [];
const append = (bytes: Buffer, view: Json) => {
  const pad = (4 - (length % 4)) % 4;
  if (pad) chunks.push(Buffer.alloc(pad));
  length += pad;
  bufferViews.push({
    ...view,
    buffer: 0,
    byteOffset: length,
    byteLength: bytes.length,
  });
  chunks.push(bytes);
  length += bytes.length;
  return bufferViews.length - 1;
};
const viewIndex = new Map<number, number>();
const useView = (i: number) => {
  if (!viewIndex.has(i))
    viewIndex.set(i, append(viewBytes(i), json.bufferViews[i]));
  return viewIndex.get(i)!;
};
for (const a of accessors) {
  if (a.bufferView !== undefined) a.bufferView = useView(a.bufferView);
  if (a.sparse) {
    a.sparse.indices.bufferView = useView(a.sparse.indices.bufferView);
    a.sparse.values.bufferView = useView(a.sparse.values.bufferView);
  }
}
let placeholderView: number | undefined;
json.images.forEach((image: Json, i: number) => {
  const bytes = imageBytes.get(i)!;
  if (bytes === placeholder)
    image.bufferView = placeholderView ??= append(bytes, {});
  else image.bufferView = append(bytes, {});
});
json.bufferViews = bufferViews;
const pad = (4 - (length % 4)) % 4;
const newBin = Buffer.concat([...chunks, Buffer.alloc(pad)]);
json.buffers = [{ byteLength: newBin.length }];

// Write the GLB: header, JSON chunk (space-padded), BIN chunk.
let text = Buffer.from(JSON.stringify(json));
text = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]);
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + text.length + 8 + newBin.length, 8);
const chunkHeader = (n: number, type: number) => {
  const h = Buffer.alloc(8);
  h.writeUInt32LE(n, 0);
  h.writeUInt32LE(type, 4);
  return h;
};
writeFileSync(
  output,
  Buffer.concat([
    header,
    chunkHeader(text.length, 0x4e4f534a),
    text,
    chunkHeader(newBin.length, 0x004e4942),
    newBin,
  ]),
);
console.log(
  `${input}: ${glb.length} bytes -> ${output}: ${12 + 16 + text.length + newBin.length} bytes`,
);
