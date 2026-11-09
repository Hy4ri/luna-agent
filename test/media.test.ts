// Contract: media_analyze picks the video route only for video data URLs and known video extensions.
import assert from "node:assert/strict";
import { test } from "bun:test";
import { isVideoSource } from "../src/media.js";

test("video sources are detected by data URL type or extension; everything else is an image", () => {
  for (const s of ["clip.mp4", "/tmp/a.MOV", "https://x.test/v/clip.webm?sig=1", "data:video/mp4;base64,AAAA", "a.mkv", "b.mpg"])
    assert.equal(isVideoSource(s), true, s);
  for (const s of ["shot.png", "https://x.test/clip.mp4.png", "data:image/png;base64,AAAA", "https://x.test/watch?v=clip.mp4", "noext", "data:text/plain,mp4"])
    assert.equal(isVideoSource(s), false, s);
});
