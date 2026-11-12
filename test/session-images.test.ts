import { test, expect } from "bun:test";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { getImageBlockAt, isValidBase64, projectEntryImages } from "../src/session-images.js";

test("base64: standard alphabet, at most two final '=', canonical trailing bits", () => {
  const cases: [string, boolean][] = [
    ["QUJD", true], ["QUI=", true], ["QQ==", true], ["QUI", true], ["QQ", true], ["+/+/", true],
    ["", false], ["====", false], ["Q", false], ["QQ===", false], ["QUJ=D", false], ["QR==", false], ["QUJ=", false],
    ["QU-D", false], ["QU_D", false], ["QU D", false], ["QUJD\n", false], ["QUé=", false], ["Q\u0000==", false],
  ];
  for (const [value, expected] of cases) expect(isValidBase64(value)).toBe(expected) /* JSON.stringify(value) */;
});

const image = (data: string) => ({ type: "image", mimeType: "IMAGE/PNG", data });
const entry = (id: number, blocks: unknown[]) =>
  ({ id, conversationId: 1, kind: "pi.user", model: [{ role: "user", content: blocks }] }) as unknown as EntryRecord;

test("projected image URLs index exactly the blocks the image route serves; invalid data stays inline", () => {
  const valid = Buffer.from("first").toString("base64"), other = Buffer.from("second").toString("base64");
  const source = entry(9001, [image(valid), image("QR=="), { type: "text", text: "x" }, image(other)]);
  for (let pass = 0; pass < 2; pass++) { // the second pass reads remembered verdicts
    const projected = projectEntryImages(source, 7) as unknown as { model: { content: Record<string, string>[] }[] };
    const blocks = projected.model[0]!.content;
    expect(blocks.map(b => b.url ?? null)).toEqual(["/v1/sessions/7/entries/9001/images/0", null, null, "/v1/sessions/7/entries/9001/images/1"]);
    expect(blocks[0]!.data).toBe(""); expect(blocks[0]!.mimeType).toBe("image/png"); expect(blocks[1]!.data).toBe("QR==");
    expect(getImageBlockAt(source, 0)?.data).toBe(valid);
    expect(getImageBlockAt(source, 1)?.data).toBe(other);
    expect(getImageBlockAt(source, 2)).toBe(undefined);
  }
  expect((source.model![0]!.content as { data: string }[])[0]!.data).toBe(valid) /* "the stored entry is not mutated" */;
});

test("a reused entry ID with different content is validated again", () => {
  expect(getImageBlockAt(entry(9002, [image("QUJD")]), 0)?.data).toBe("QUJD");
  expect(getImageBlockAt(entry(9002, [image("QU-D")]), 0)).toBe(undefined);
});
