// Deterministic test suite for vision image loading, parsing, SSRF guarding, cropping, and fitting.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import {
  loadVisionImage,
  fitVisionImage,
  isPublicVisionAddress,
  assertVisionUrl,
  type VisionRegion,
} from "./vision-images.js";

const dir = mkdtempSync(join(tmpdir(), "luna-vision-tests-"));

try {
  // 1. SSRF and IP policy verification
  assert.equal(isPublicVisionAddress("8.8.8.8"), true);
  assert.equal(isPublicVisionAddress("1.1.1.1"), true);
  assert.equal(isPublicVisionAddress("127.0.0.1"), false);
  assert.equal(isPublicVisionAddress("::1"), false);
  assert.equal(isPublicVisionAddress("10.0.0.1"), false);
  assert.equal(isPublicVisionAddress("192.168.1.1"), false);
  assert.equal(isPublicVisionAddress("169.254.169.254"), false);
  assert.equal(isPublicVisionAddress("fe80::1"), false);
  assert.equal(isPublicVisionAddress("fc00::1"), false);
  assert.equal(isPublicVisionAddress("ff00::1"), false);

  // Async URL policy tests
  await assert.rejects(async () => await assertVisionUrl("ftp://example.com/image.png"), /protocol|unsupported/i);
  await assert.rejects(async () => await assertVisionUrl("https://user:pass@example.com/image.png"), /credentials|user/i);
  await assert.rejects(async () => await assertVisionUrl("https://127.0.0.1/image.png"), /private|ip|ssrf/i);

  // 2. Local image loading, format detection, cropping, and hashing
  const testPngBuffer = await sharp({
    create: { width: 100, height: 100, channels: 3, background: { r: 255, g: 0, b: 0 } },
  })
    .png()
    .toBuffer();

  const localImgPath = join(dir, "test.png");
  writeFileSync(localImgPath, testPngBuffer);

  const region: VisionRegion = { x: 10, y: 10, width: 50, height: 50 };
  const loaded = await loadVisionImage(localImgPath, region, {
    signal: new AbortController().signal,
    cwd: dir,
    tempRoot: dir,
  });

  assert.equal(loaded.width, 50);
  assert.equal(loaded.height, 50);
  assert.equal(loaded.mimeType, "image/png");
  assert.ok(loaded.sourceKey.length === 64); // SHA256 hex
  assert.ok(loaded.path.startsWith(dir));

  await loaded.cleanup();

  // 3. Data URL loading and parsing
  const dataUrl = `data:image/png;base64,${testPngBuffer.toString("base64")}`;
  const loadedData = await loadVisionImage(dataUrl, undefined, {
    signal: new AbortController().signal,
    tempRoot: dir,
  });
  assert.equal(loadedData.width, 100);
  assert.equal(loadedData.height, 100);
  assert.equal(loadedData.mimeType, "image/png");
  await loadedData.cleanup();

  // 4. Out of bounds and rejection tests
  const badRegion: VisionRegion = { x: 80, y: 80, width: 50, height: 50 }; // exceeds 100x100
  await assert.rejects(
    async () =>
      await loadVisionImage(localImgPath, badRegion, {
        signal: new AbortController().signal,
        cwd: dir,
        tempRoot: dir,
      }),
    /bounds|out of bounds|invalid/i
  );

  // 5. Fit vision image budget & edge capping
  const fitted = await fitVisionImage(loadedData, {
    maxBytes: 1024 * 1024,
    longEdge: 50,
    hardBytes: 2 * 1024 * 1024,
    signal: new AbortController().signal,
  });
  assert.ok(fitted.width <= 50);
  assert.ok(fitted.height <= 50);
  assert.ok(["image/png", "image/jpeg", "image/webp", "image/gif"].includes(fitted.mimeType));
  assert.equal((await sharp(Buffer.from(fitted.data, "base64")).metadata()).width, fitted.width);
  assert.ok(typeof fitted.data === "string");

  assert.equal(loaded.sourceKey, loadedData.sourceKey, "crops and source aliases share accounting");
  assert.equal(existsSync(loaded.path), false); assert.equal(existsSync(localImgPath), true);
  const privateImage = await loadVisionImage(localImgPath, undefined, { signal: new AbortController().signal, tempRoot: dir });
  assert.equal(statSync(privateImage.path).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(privateImage.path)).mode & 0o777, 0o700);
  const before = readdirSync(dir).sort();
  await assert.rejects(loadVisionImage("data:image/png;base64,bm90IGFuIGltYWdl", undefined, { signal: new AbortController().signal, tempRoot: dir }));
  assert.deepEqual(readdirSync(dir).sort(), before, "failed decode cleans private directory");
  const interrupted = new AbortController(); interrupted.abort();
  await assert.rejects(loadVisionImage(localImgPath, undefined, { signal: interrupted.signal, tempRoot: dir }), /Interrupted/);
  await assert.rejects(fitVisionImage(privateImage, { maxBytes: 1, hardBytes: 1, longEdge: 2048, signal: new AbortController().signal }), /budget|limit/i);
  await assert.rejects(fitVisionImage(privateImage, { maxBytes: 1024, hardBytes: 1024, longEdge: 50, signal: interrupted.signal }), /Interrupted/);
  const hard = await fitVisionImage(privateImage, { maxBytes: 10000, hardBytes: 1000, longEdge: 2048, signal: new AbortController().signal });
  assert.ok(hard.data.length <= 1000);
  await privateImage.cleanup();
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="red"/></svg>');
  const converted = await loadVisionImage(`data:image/svg+xml;base64,${svg.toString("base64")}`, undefined, { signal: new AbortController().signal, tempRoot: dir });
  assert.equal(converted.mimeType, "image/png"); assert.equal(converted.width, 200); await converted.cleanup();
  const external = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><image href="file:///etc/passwd"/></svg>');
  await assert.rejects(loadVisionImage(`data:image/svg+xml;base64,${external.toString("base64")}`, undefined, { signal: new AbortController().signal, tempRoot: dir }), /external/);
  // 24-bit BMP: one red pixel plus row padding. Conversion must work without a host executable.
  const bmp = Buffer.alloc(58); bmp.write("BM"); bmp.writeUInt32LE(58, 2); bmp.writeUInt32LE(54, 10);
  bmp.writeUInt32LE(40, 14); bmp.writeInt32LE(1, 18); bmp.writeInt32LE(1, 22); bmp.writeUInt16LE(1, 26); bmp.writeUInt16LE(24, 28); bmp[56] = 255;
  const bitmap = await loadVisionImage(`data:image/bmp;base64,${bmp.toString("base64")}`, undefined, { signal: new AbortController().signal, tempRoot: dir });
  assert.equal(bitmap.mimeType, "image/png"); assert.equal(bitmap.width, 1); await bitmap.cleanup();
  for (const address of ["::ffff:127.0.0.1", "::ffff:7f00:1", "2001:db8::1", "2002:7f00:1::", "64:ff9b::7f00:1", "198.18.1.1", "224.0.0.1", "100.64.0.1"])
    assert.equal(isPublicVisionAddress(address), false, address);
  assert.equal(isPublicVisionAddress("2606:4700:4700::1111"), true);
  await assert.rejects(assertVisionUrl("http://[::ffff:127.0.0.1]/"), /SSRF/);
  assert.deepEqual(readdirSync(dir).sort(), ["test.png"], "all private files removed");
  console.log("VISION_IMAGES_OK");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
