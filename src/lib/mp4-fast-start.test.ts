// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BlobSource,
  BufferTarget,
  Conversion,
  EncodedPacketSink,
  Input,
  MP4,
  Mp4OutputFormat,
  Output,
} from "mediabunny";
import { hasMp4FastStart, prepareMp4FastStart } from "./mp4-fast-start";
const fixture = new Blob([
  readFileSync(new URL("../test/fixtures/social-video.mp4", import.meta.url)),
]);

async function endIndexedMp4() {
  const input = new Input({ source: new BlobSource(fixture), formats: [MP4] });
  try {
    const target = new BufferTarget();
    const output = new Output({ target, format: new Mp4OutputFormat({ fastStart: false }) });
    const conversion = await Conversion.init({ input, output, copy: { mode: "forced" } });
    await conversion.execute();
    return new Blob([target.buffer!], { type: "video/mp4" });
  } finally {
    input.dispose();
  }
}

async function mediaPackets(blob: Blob) {
  const input = new Input({ source: new BlobSource(blob), formats: [MP4] });
  try {
    const result: Uint8Array[][] = [];
    for (const track of await input.getTracks()) {
      const packets: Uint8Array[] = [];
      for await (const packet of new EncodedPacketSink(track).packets()) packets.push(packet.data);
      result.push(packets);
    }
    return result;
  } finally {
    input.dispose();
  }
}

describe("social MP4 progressive playback", () => {
  it("moves the index ahead of media without changing bytes in any video or audio packet", async () => {
    const original = await endIndexedMp4();
    expect(await hasMp4FastStart(original)).toBe(false);
    const prepared = await prepareMp4FastStart(original);
    expect(prepared.size).toBe(original.size);
    expect(await hasMp4FastStart(prepared)).toBe(true);
    expect(await mediaPackets(prepared)).toEqual(await mediaPackets(original));
  });
  it("keeps an already compatible MP4 unchanged", async () => {
    expect(await hasMp4FastStart(fixture)).toBe(true);
    await expect(prepareMp4FastStart(fixture)).resolves.toBe(fixture);
  });
  it("rejects malformed or truncated MP4s before a destination can fetch them", async () => {
    await expect(
      prepareMp4FastStart(new Blob([new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])])),
    ).rejects.toThrow(/incomplete/);
  });
});
