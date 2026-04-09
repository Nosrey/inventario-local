// imageCompressor.worker.js
// Receives message: { files: [{name, arrayBuffer, type}], variants: [{name:'full', maxDim:1080, quality:0.8, mime:'image/jpeg'}, {name:'thumb', maxDim:300, quality:0.75, mime:'image/webp'}] }
// Replies: { results: [{ fileName, variants: [{ name, blob }], error? }] }

self.addEventListener('message', async (ev) => {
  const data = ev.data || {};
  const files = data.files || [];
  const variants = data.variants || [];
  const results = [];

  for (const f of files) {
    try {
      const arr = f.arrayBuffer;
      // decode image into bitmap
      const bitmap = await createImageBitmap(new Blob([arr], { type: f.type }));
      const variantsOut = [];
      for (const v of variants) {
        try {
          const maxDim = v.maxDim || 1080;
          const quality = typeof v.quality === 'number' ? v.quality : 0.8;
          const mime = v.mime || 'image/jpeg';
          let w = bitmap.width;
          let h = bitmap.height;
          if (Math.max(w, h) > maxDim) {
            if (w >= h) {
              const scale = maxDim / w;
              w = Math.max(1, Math.round(w * scale));
              h = Math.max(1, Math.round(h * scale));
            } else {
              const scale = maxDim / h;
              h = Math.max(1, Math.round(h * scale));
              w = Math.max(1, Math.round(w * scale));
            }
          }
          // OffscreenCanvas
          const oc = new OffscreenCanvas(w, h);
          const ctx = oc.getContext('2d');
          ctx.drawImage(bitmap, 0, 0, w, h);
          // convert to blob
          let blob = null;
          if (oc.convertToBlob) {
            blob = await oc.convertToBlob({ type: mime, quality });
          } else {
            // fallback: transfer to canvas in main thread not available; error
            throw new Error('convertToBlob not supported in worker');
          }
          variantsOut.push({ name: v.name, blob, mime });
        } catch (e) {
          // variant-level error
          variantsOut.push({ name: v.name, error: String(e) });
        }
      }
      // close bitmap
      try { bitmap.close(); } catch (e) {}
      results.push({ fileName: f.name, variants: variantsOut });
    } catch (err) {
      results.push({ fileName: f.name, error: String(err) });
    }
  }

  self.postMessage({ results });
});