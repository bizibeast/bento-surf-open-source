const text = new TextDecoder();

function box(bytes: Uint8Array, offset: number, end: number) {
  if (offset + 8 > bytes.length || offset + 8 > end) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, bytes.length - offset);
  const shortSize = view.getUint32(0);
  const header = shortSize === 1 ? 16 : 8;
  if (view.byteLength < header) return null;
  const size = shortSize === 1 ? Number(view.getBigUint64(8)) : shortSize || end - offset;
  if (!Number.isSafeInteger(size) || size < header || size > end - offset) return null;
  return {
    type: text.decode(bytes.subarray(offset + 4, offset + 8)),
    content: offset + header,
    end: offset + size,
  };
}

function durationFromMovie(bytes: Uint8Array, start: number, end: number) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  for (let offset = start; offset + 8 <= bytes.length && offset < end;) {
    const atom = box(bytes, offset, end);
    if (!atom) break;
    if (atom.type === "mvhd") {
      if (atom.content >= Math.min(atom.end, bytes.length)) break;
      const version = view.getUint8(atom.content);
      if (version !== 0 && version !== 1) break;
      const timescaleOffset = atom.content + (version === 1 ? 20 : 12);
      const durationOffset = timescaleOffset + 4;
      if (durationOffset + (version === 1 ? 8 : 4) > Math.min(bytes.length, atom.end)) break;
      const timescale = view.getUint32(timescaleOffset);
      const duration =
        version === 1 ? view.getBigUint64(durationOffset) : BigInt(view.getUint32(durationOffset));
      const unknownDuration = version === 1 ? 0xffffffffffffffffn : 0xffffffffn;
      if (timescale && duration && duration !== unknownDuration) {
        return Number(duration) / timescale;
      }
      break;
    }
    offset = atom.end;
  }
  return null;
}

/** Scan top-level box boundaries. A skipped payload can place the next box outside this range. */
export function inspectMp4Duration(
  bytes: Uint8Array,
  start: number,
  fileLength: number,
): { seconds: number } | { next: number } | null {
  const end = fileLength - start;
  for (let offset = 0; offset < end;) {
    if (offset + 16 > bytes.length && offset !== 0 && start + offset < fileLength) {
      return { next: start + offset };
    }
    const atom = box(bytes, offset, end);
    if (!atom) return null;
    if (atom.type === "moov") {
      const seconds = durationFromMovie(bytes, atom.content, atom.end);
      return seconds === null ? null : { seconds };
    }
    offset = atom.end;
  }
  return null;
}
