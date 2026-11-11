/**
 * تخزين الناتج في Turso — كل Blob يُقسَّم إلى صفوف 2MB (حد HTTP في Turso)
 */
"use strict";

const { LIMITS } = require("./util");
const store = require("./db");

/** تقسيم ملف الناتج إلى صفوف 2MB وخزنها في output_chunks */
async function saveOutputBlob(jobId, filePath, onProgress) {
  const fs = require("fs");
  const stat = fs.statSync(filePath);
  if (stat.size > LIMITS.outputMaxBytes) {
    throw new Error(`حجم الناتج يتجاوز الحد المسموح`);
  }
  const fd = fs.openSync(filePath, "r");
  const buf = Buffer.alloc(Math.min(LIMITS.chunkRowBytes, LIMITS.outputMaxBytes));
  try {
    let idx = 0;
    let written = 0;
    while (written < stat.size) {
      const chunkLen = Math.min(buf.length, stat.size - written);
      const slice = chunkLen === buf.length ? buf : Buffer.alloc(chunkLen);
      fs.readSync(fd, slice, 0, chunkLen, written);
      await store.insertOutputChunk(jobId, idx, slice);
      written += chunkLen;
      idx++;
      if (onProgress && idx % 8 === 0) onProgress(written / stat.size);
    }
    if (onProgress) onProgress(1);
    return { size: stat.size, chunks: idx };
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { saveOutputBlob };
