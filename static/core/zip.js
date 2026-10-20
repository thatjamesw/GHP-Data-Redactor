// Reads one text entry from a .zip (DOCX, XLSX) with the built-in DecompressionStream.
// ponytail: no zip64, so entries over 4 GB fail; Office documents never get that large in practice
const decoder = new TextDecoder();

export async function readZipText(arrayBuffer, entryName) {
  const bytes = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);
  let end = bytes.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end -= 1;
  if (end < 0) throw new Error("This file is not a valid zip archive.");

  let offset = view.getUint32(end + 16, true);
  for (let index = view.getUint16(end + 10, true); index > 0; index -= 1) {
    const nameLength = view.getUint16(offset + 28, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    if (name === entryName) {
      const method = view.getUint16(offset + 10, true);
      const size = view.getUint32(offset + 20, true);
      const local = view.getUint32(offset + 42, true);
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      const data = bytes.subarray(start, start + size);
      if (method === 0) return decoder.decode(data);
      if (method !== 8) throw new Error(`Unsupported zip compression method ${method}.`);
      return new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).text();
    }
    offset += 46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
  return null;
}
