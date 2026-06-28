(function () {
  "use strict";

  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder("utf-8");
  const CRC_TABLE = makeCrcTable();

  function makeCrcTable() {
    const table = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      table[index] = value >>> 0;
    }
    return table;
  }

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let index = 0; index < bytes.length; index += 1) {
      crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  async function readZip(blob) {
    const buffer = await blob.arrayBuffer();
    const view = new DataView(buffer);
    const eocdOffset = findEndOfCentralDirectory(view);
    const entryCount = view.getUint16(eocdOffset + 10, true);
    const centralOffset = view.getUint32(eocdOffset + 16, true);
    const entries = [];
    let offset = centralOffset;

    for (let index = 0; index < entryCount; index += 1) {
      if (view.getUint32(offset, true) !== 0x02014b50) {
        throw new Error("ZIP central directory is invalid.");
      }

      const flags = view.getUint16(offset + 8, true);
      const compressionMethod = view.getUint16(offset + 10, true);
      const compressedSize = view.getUint32(offset + 20, true);
      const size = view.getUint32(offset + 24, true);
      const nameLength = view.getUint16(offset + 28, true);
      const extraLength = view.getUint16(offset + 30, true);
      const commentLength = view.getUint16(offset + 32, true);
      const localOffset = view.getUint32(offset + 42, true);
      const nameBytes = new Uint8Array(buffer, offset + 46, nameLength);
      const name = decodeName(nameBytes, flags);

      entries.push({
        name,
        size,
        compressedSize,
        compressionMethod,
        isDirectory: name.endsWith("/"),
        arrayBuffer: () => readEntryBuffer(buffer, localOffset, compressionMethod, compressedSize),
        blob: async (type = "") => new Blob([await readEntryBuffer(buffer, localOffset, compressionMethod, compressedSize)], { type }),
        text: async () => textDecoder.decode(await readEntryBuffer(buffer, localOffset, compressionMethod, compressedSize))
      });

      offset += 46 + nameLength + extraLength + commentLength;
    }

    return entries;
  }

  function findEndOfCentralDirectory(view) {
    const minOffset = Math.max(0, view.byteLength - 66000);
    for (let offset = view.byteLength - 22; offset >= minOffset; offset -= 1) {
      if (view.getUint32(offset, true) === 0x06054b50) {
        return offset;
      }
    }
    throw new Error("ZIP file is missing an end-of-central-directory record.");
  }

  function decodeName(bytes) {
    return textDecoder.decode(bytes).replace(/\\/g, "/");
  }

  async function readEntryBuffer(buffer, localOffset, compressionMethod, compressedSize) {
    const view = new DataView(buffer);
    if (view.getUint32(localOffset, true) !== 0x04034b50) {
      throw new Error("ZIP local file header is invalid.");
    }

    const nameLength = view.getUint16(localOffset + 26, true);
    const extraLength = view.getUint16(localOffset + 28, true);
    const dataOffset = localOffset + 30 + nameLength + extraLength;
    const compressed = buffer.slice(dataOffset, dataOffset + compressedSize);

    if (compressionMethod === 0) {
      return compressed;
    }

    if (compressionMethod === 8) {
      if (typeof DecompressionStream !== "function") {
        throw new Error("This browser cannot decompress deflated ZIP files.");
      }

      const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      return new Response(stream).arrayBuffer();
    }

    throw new Error(`Unsupported ZIP compression method: ${compressionMethod}.`);
  }

  async function createZip(files) {
    const localParts = [];
    const centralParts = [];
    let offset = 0;

    for (const file of files) {
      const name = String(file.name || "").replace(/\\/g, "/");
      const nameBytes = textEncoder.encode(name);
      const data = await toBytes(file.data);
      const crc = crc32(data);
      const mod = dateToDos(file.lastModified ? new Date(file.lastModified) : new Date());
      const localHeader = new Uint8Array(30 + nameBytes.length);
      const localView = new DataView(localHeader.buffer);

      localView.setUint32(0, 0x04034b50, true);
      localView.setUint16(4, 20, true);
      localView.setUint16(6, 0x0800, true);
      localView.setUint16(8, 0, true);
      localView.setUint16(10, mod.time, true);
      localView.setUint16(12, mod.date, true);
      localView.setUint32(14, crc, true);
      localView.setUint32(18, data.length, true);
      localView.setUint32(22, data.length, true);
      localView.setUint16(26, nameBytes.length, true);
      localHeader.set(nameBytes, 30);
      localParts.push(localHeader, data);

      const centralHeader = new Uint8Array(46 + nameBytes.length);
      const centralView = new DataView(centralHeader.buffer);
      centralView.setUint32(0, 0x02014b50, true);
      centralView.setUint16(4, 20, true);
      centralView.setUint16(6, 20, true);
      centralView.setUint16(8, 0x0800, true);
      centralView.setUint16(10, 0, true);
      centralView.setUint16(12, mod.time, true);
      centralView.setUint16(14, mod.date, true);
      centralView.setUint32(16, crc, true);
      centralView.setUint32(20, data.length, true);
      centralView.setUint32(24, data.length, true);
      centralView.setUint16(28, nameBytes.length, true);
      centralView.setUint32(42, offset, true);
      centralHeader.set(nameBytes, 46);
      centralParts.push(centralHeader);

      offset += localHeader.length + data.length;
    }

    const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
    const end = new Uint8Array(22);
    const endView = new DataView(end.buffer);
    endView.setUint32(0, 0x06054b50, true);
    endView.setUint16(8, files.length, true);
    endView.setUint16(10, files.length, true);
    endView.setUint32(12, centralSize, true);
    endView.setUint32(16, offset, true);

    return new Blob([...localParts, ...centralParts, end], { type: "application/zip" });
  }

  async function toBytes(data) {
    if (data instanceof Uint8Array) {
      return data;
    }
    if (data instanceof ArrayBuffer) {
      return new Uint8Array(data);
    }
    if (data instanceof Blob) {
      return new Uint8Array(await data.arrayBuffer());
    }
    return textEncoder.encode(String(data));
  }

  function dateToDos(date) {
    const year = Math.max(1980, date.getFullYear());
    return {
      time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
      date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
    };
  }

  window.DoorablesZip = {
    readZip,
    createZip
  };
})();
