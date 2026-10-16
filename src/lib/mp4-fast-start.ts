// Moving only the MP4 index keeps encoded picture/audio bytes unchanged. Keep
// the large media body in Blob slices; only the small index enters JS memory.
type Mp4Box = { type: string; offset: number; size: number; header: number };
const MAX_INDEX_BYTES = 16 * 1024 ** 2;
const containers = new Set(["moov", "trak", "mdia", "minf", "stbl"]);

function boxHeader(view: DataView, offset: number, limit: number): Mp4Box {
  if (offset + 8 > limit) throw new Error("This MP4 has an incomplete index.");
  let size = view.getUint32(offset);
  let header = 8;
  if (size === 1) {
    if (offset + 16 > limit) throw new Error("This MP4 has an incomplete index.");
    const extended = view.getBigUint64(offset + 8);
    if (extended > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("This MP4 is too large.");
    size = Number(extended);
    header = 16;
  } else if (size === 0) size = limit - offset;
  const type = String.fromCharCode(...new Uint8Array(view.buffer, view.byteOffset + offset + 4, 4));
  if (size < header || offset + size > limit) throw new Error("This MP4 has an invalid index.");
  return { type, offset, size, header };
}

async function topBoxes(blob: Blob) {
  const boxes: Mp4Box[] = [];
  let offset = 0;
  while (offset < blob.size) {
    if (boxes.length >= 128) throw new Error("This MP4 needs a simpler export to optimize safely.");
    const data = await blob.slice(offset, Math.min(blob.size, offset + 16)).arrayBuffer();
    const view = new DataView(data);
    // Read a bounded header while validating its length against the whole file.
    let size = data.byteLength >= 8 ? view.getUint32(0) : -1;
    let header = 8;
    if (size === 1 && data.byteLength >= 16) {
      size = Number(view.getBigUint64(8));
      header = 16;
    } else if (size === 0) size = blob.size - offset;
    if (!Number.isSafeInteger(size) || size < header || offset + size > blob.size)
      throw new Error("This MP4 is incomplete. Choose another export.");
    const type = String.fromCharCode(...new Uint8Array(data, 4, 4));
    boxes.push({ type, offset, size, header });
    offset += size;
  }
  return boxes;
}

export async function hasMp4FastStart(blob: Blob) {
  const boxes = await topBoxes(blob);
  const movie = boxes.find((box) => box.type === "moov");
  const media = boxes.find((box) => box.type === "mdat");
  return Boolean(movie && media && movie.offset < media.offset);
}

/** Our muxer emits one mdat followed by moov. Relocate moov to the front and
 * update both 32-bit and 64-bit chunk offsets, without buffering the video. */
export async function prepareMp4FastStart(blob: Blob) {
  const boxes = await topBoxes(blob);
  const movie = boxes.find((box) => box.type === "moov");
  const media = boxes.find((box) => box.type === "mdat");
  if (!movie || !media || boxes.filter((box) => box.type === "mdat").length !== 1)
    throw new Error("Video preparation produced an invalid MP4 layout.");
  if (movie.offset < media.offset) return blob;
  if (movie.size > MAX_INDEX_BYTES)
    throw new Error("This video's index is too large to optimize safely.");
  const index = await blob.slice(movie.offset, movie.offset + movie.size).arrayBuffer();
  const view = new DataView(index);
  let tables = 0;
  const visit = (start: number, end: number) => {
    for (let offset = start; offset < end;) {
      const box = boxHeader(view, offset, end);
      if (containers.has(box.type)) visit(offset + box.header, offset + box.size);
      if (box.type === "stco" || box.type === "co64") {
        const stride = box.type === "stco" ? 4 : 8;
        const countAt = offset + box.header + 4;
        if (countAt + 4 > offset + box.size)
          throw new Error("This MP4 has an invalid chunk index.");
        const count = view.getUint32(countAt);
        const entries = countAt + 4;
        if (entries + count * stride > offset + box.size)
          throw new Error("This MP4 has an invalid chunk index.");
        for (let position = entries; position < entries + count * stride; position += stride) {
          const current =
            stride === 4 ? view.getUint32(position) : Number(view.getBigUint64(position));
          if (
            !Number.isSafeInteger(current) ||
            current < media.offset + media.header ||
            current >= media.offset + media.size
          )
            throw new Error("This MP4 has an invalid media offset.");
          const next = current + movie.size;
          if (stride === 4) {
            if (next > 0xffffffff) throw new Error("This MP4 is too large to optimize safely.");
            view.setUint32(position, next);
          } else view.setBigUint64(position, BigInt(next));
        }
        tables += 1;
      }
      offset += box.size;
    }
  };
  visit(0, index.byteLength);
  if (!tables) throw new Error("This MP4 has no readable media index.");
  return new Blob(
    [
      blob.slice(0, media.offset),
      index,
      blob.slice(media.offset, movie.offset),
      blob.slice(movie.offset + movie.size),
    ],
    { type: "video/mp4" },
  );
}
