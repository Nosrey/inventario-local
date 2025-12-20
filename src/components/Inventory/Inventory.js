import React, { useState, useEffect } from 'react';
import { doc, setDoc, writeBatch, runTransaction, deleteDoc, deleteField, serverTimestamp, getDoc, getDocFromServer, collection, addDoc, query, where, getDocs } from 'firebase/firestore';
import { getStorage, ref as storageRef, uploadBytesResumable, uploadBytes, getDownloadURL, deleteObject, ref as refFromPath, listAll } from 'firebase/storage';
import { db } from '../../firebase.js';
import { useData } from '../../context/DataProvider.jsx';
import AddProductButton from '../AddProductButton/AddProductButton.js';
import NewModalAddProductModal from '../NewModalAddProductModal/NewModalAddProductModal.js';
import ProductSearchBar from '../ProductSearchBar/ProductSearchBar.js';
import { createSearcher } from '../../utils/smartSearch';
import { FixedSizeList as List } from 'react-window';
import './Inventory.css';
// --- NUEVO: reutilizamos estilos y layout de ProductSearchModal para mejor legibilidad ---
import '../Cashier/ProductSearchModal/ProductSearchModal.css';
import ImageViewerModal from '../ImageViewerModal/ImageViewerModal.js';
import _ from 'lodash';

// Eliminamos listeners locales: usamos el contexto global
function Inventory({ user }) {
  const { loading, productsMap, inventories, brands, settings } = useData();
  // Utility: list queued archive jobs (stored in localStorage per product)
  const listArchiveJobsFor = (productId) => {
    try { return JSON.parse(localStorage.getItem(`inventory:archiveJobs:${productId}`) || '[]'); } catch (e) { return []; }
  };

  // Delete all files under products/{productId} except items in archive/ (best-effort)
  const deleteFilesInProductFolder = async (productId) => {
    if (!productId) return;
    const storage = getStorage();
    const rootRef = storageRef(storage, `products/${productId}`);

    const deleteRecursive = async (ref) => {
      try {
        const res = await listAll(ref);
        // delete items (files)
        for (const itemRef of res.items) {
          try {
            // skip archive folder files
            if ((itemRef.fullPath || '').includes('/archive/')) continue;
            await deleteObject(itemRef);
          } catch (e) {
            // continue on individual failures
            console.warn('deleteFilesInProductFolder: could not delete', itemRef.fullPath, e?.message || e);
          }
        }
        // recurse into prefixes (subfolders)
        for (const prefixRef of res.prefixes) {
          // if prefix is archive, skip
          if ((prefixRef.fullPath || '').includes('/archive/')) continue;
          await deleteRecursive(prefixRef);
        }
      } catch (e) {
        console.warn('deleteFilesInProductFolder listAll failed for', ref.fullPath, e?.message || e);
      }
    };

    await deleteRecursive(rootRef);
  };

  // NOTE: The client queues archive jobs (download URLs) to localStorage because
  // fetching and re-uploading public download URLs from the browser commonly
  // triggers CORS errors or 404s. Run a backend job / Cloud Function to process
  // these queues and move files server-side into products/{productId}/archive/.
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [notification, setNotification] = useState({ message: '', type: '' });

  const showNotification = (message, type = 'error', duration = 4000) => {
    setNotification({ message, type });
    try { window.clearTimeout(showNotification._t); } catch (e) { }
    showNotification._t = window.setTimeout(() => setNotification({ message: '', type: '' }), duration);
  };
  const [selectedInventoryId, setSelectedInventoryId] = useState('total');
  const [productToEdit, setProductToEdit] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [viewMode, setViewMode] = useState('grid'); // ← defecto ahora: cuadrícula
  const [viewerOpen, setViewerOpen] = useState(false);
  const [viewerSrc, setViewerSrc] = useState(null);

  // Responsive row height for react-window list (desktop: compact 45px, mobile: taller ~140px)
  const [listRowHeight, setListRowHeight] = useState(45);
  useEffect(() => {
    const update = () => {
      const w = typeof window !== 'undefined' ? window.innerWidth : 1024;
      setListRowHeight(w <= 720 ? 140 : 45); // mobile = 140px for stacked card layout
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  // Ensure page background matches the inventory list while this component is mounted
  React.useEffect(() => {
    try {
      document?.body?.classList?.add('inventory-bg');
      document?.documentElement?.classList?.add('inventory-bg');
    } catch (e) { }
    return () => {
      try {
        document?.body?.classList?.remove('inventory-bg');
        document?.documentElement?.classList?.remove('inventory-bg');
      } catch (e) { }
    };
  }, []);

  const handleSetViewMode = async (mode) => {
    setViewMode(mode);
    if (user?.uid) {
      try { await setDoc(doc(db, 'users', user.uid), { inventoryView: mode }, { merge: true }); } catch { }
    }
  };

  useEffect(() => {
    // Si el inventario seleccionado ya no existe, volver a 'total'
    const allIds = new Set(['total', ...inventories.map(i => i.id)]);
    if (!allIds.has(selectedInventoryId)) setSelectedInventoryId('total');
  }, [inventories, selectedInventoryId]);

  // Persist selected inventory per-user (localStorage + Firestore)
  const userInteractedRef = React.useRef(false); // evita sobrescribir tras interacción manual

  useEffect(() => {
    if (!inventories.length) return;
    if (userInteractedRef.current) return;

    const lsKey = user?.uid ? `inventoryPickedInventory:${user.uid}` : null;

    (async () => {
      let candidate = null;

      // 1) Try server-stored pick
      if (user?.uid) {
        try {
          let userSnap;
          try {
            userSnap = await getDocFromServer(doc(db, 'users', user.uid));
          } catch (_) {
            userSnap = await getDoc(doc(db, 'users', user.uid));
          }
          if (userSnap && userSnap.exists()) {
            const data = userSnap.data() || {};
            const picked = data.inventoryPickedInventory;
            if (picked && (picked === 'total' || inventories.some(i => i.id === picked))) {
              candidate = picked;
            }
          }
        } catch (e) {
          // ignore and fallback
        }
      }

      // 2) fallback: localStorage
      if (!candidate && lsKey) {
        const lsVal = localStorage.getItem(lsKey);
        if (lsVal && (lsVal === 'total' || inventories.some(i => i.id === lsVal))) candidate = lsVal;
      }

      // 3) fallback: current state
      if (!candidate && selectedInventoryId && (selectedInventoryId === 'total' || inventories.some(i => i.id === selectedInventoryId))) {
        candidate = selectedInventoryId;
      }

      // 4) final fallback: first available inventory or 'total'
      if (!candidate) candidate = inventories[0]?.id || 'total';

      if (candidate !== selectedInventoryId) setSelectedInventoryId(candidate);
    })();
  }, [inventories, selectedInventoryId, user]);

  const handleInventoryChange = async (newInventoryId) => {
    if (newInventoryId === selectedInventoryId) return;
    userInteractedRef.current = true;
    setSelectedInventoryId(newInventoryId);
    const lsKey = user?.uid ? `inventoryPickedInventory:${user.uid}` : null;
    if (lsKey) localStorage.setItem(lsKey, newInventoryId);
    if (user?.uid) {
      try {
        await setDoc(doc(db, 'users', user.uid), { inventoryPickedInventory: newInventoryId }, { merge: true });
      } catch (err) {
        console.error('Could not persist inventory pick for user:', err);
      }
    }
  };

  const handleEditClick = (productDocId) => {
    const productData = _.cloneDeep(productsMap[productDocId] || {});

    // Incluir TODOS los inventarios, incluso los que tienen 0
    const inventoryQuantities = inventories.map(inv => ({
      inventoryId: inv.id,
      quantity: Number(inv.products?.[productDocId]?.quantity) || 0
    }));

    setProductToEdit({ ...productData, docId: productDocId, inventories: inventoryQuantities });
    setIsModalOpen(true);
  };

  const handleCloseModal = () => { setIsModalOpen(false); setProductToEdit(null); };

  // Normaliza un nombre: trim, colapsa espacios y convierte a Title Case (Max Glow)
  const normalizeName = (s) => {
    if (!s && s !== '') return '';
    return String(s || '').trim().replace(/\s+/g, ' ').split(' ').map(w => w ? (w[0].toUpperCase() + w.slice(1).toLowerCase()) : '').join(' ');
  };
  // Reemplaza COMPLETO handleAddProduct por seteo EXACTO (sin incrementos, sin deltas)
  // NOTE: We accept (productData, progressCb) when called by the modal.
  const handleAddProduct = async (productData, progressCb = () => { }) => {
    setIsUpdating(true);
    try {
      const { docId, name, price, cost, minQuantity, brandId, inventories: targetInvs = [] } = productData;
      const imageFiles = productData.imageFiles || []; // array of File

      const toInt = (v) => {
        const n = Number(v);
        return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
      };

      const payload = {
        name: String(name || '').trim(),
        price: Number(price) || 0,
        cost: Number(cost) || 0,
        minQuantity: toInt(minQuantity),
        brandId: brandId || null,
      };

      if (docId) {
        // EDITAR PRODUCTO (incluye updatedAt)
        // Use a per-product pending key and transaction to make the edit idempotent
        const pendingKey = user?.uid ? `inventory:pending:product:${docId}:${user.uid}` : `inventory:pending:product:${docId}:anon`;
        let stored = null;
        try { stored = JSON.parse(localStorage.getItem(pendingKey) || 'null'); } catch (e) { stored = null; }
        const opId = stored?.opId || `inv_edit_${docId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        try { localStorage.setItem(pendingKey, JSON.stringify({ opId, createdAt: Date.now() })); } catch (e) { }

        try {
          await runTransaction(db, async (tx) => {
            const histRef = doc(db, 'history', 'main', 'inventoryEdits', opId);
            const existing = await tx.get(histRef);
            if (existing.exists()) return; // already applied

            const prodRef = doc(db, 'products', docId);
            tx.set(prodRef, { ...payload, updatedAt: serverTimestamp() }, { merge: true });

            // apply inventory assignments
            for (const iq of targetInvs) {
              const q = toInt(iq.quantity);
              const invRef = doc(db, 'inventories', iq.inventoryId);
              tx.set(invRef, { products: { [docId]: { quantity: q } }, updatedAt: serverTimestamp() }, { merge: true });
            }

            // write a history entry so future retries are no-ops
            tx.set(histRef, {
              id: opId,
              type: 'product_edit',
              productId: docId,
              payload: { ...payload, inventories: targetInvs },
              userId: user?.uid || null,
              createdAt: serverTimestamp()
            });
          });
        } finally {
          try { localStorage.removeItem(pendingKey); } catch (e) { }
        }

        // If there are images selected, compress & upload both thumbnail and full versions,
        // then update product doc with image URLs (thumbnail + full) and cache-control metadata
        if (imageFiles && imageFiles.length > 0) {
          try {
            const storage = getStorage();
            const prevFull = productToEdit?.images || [];
            const prevThumbs = productToEdit?.thumbnailsWebp || [];

            // helper: compress using a Web Worker (with fallback) and upload with resumable tasks
            const compressAndUpload = async (files, destProductId, progressCb = () => { }) => {
              // prepare variants: full jpeg, thumb jpeg, thumb webp
              const variants = [
                { name: 'full_jpeg', maxDim: 1080, quality: 0.8, mime: 'image/jpeg' },
                { name: 'thumb_webp', maxDim: 300, quality: 0.8, mime: 'image/webp' }
              ];

              // create worker from inline code (safer for bundlers)
              const workerCode = `self.addEventListener('message', async (ev) => { const data = ev.data || {}; const files = data.files || []; const variants = data.variants || []; const results = []; for (const f of files) { try { const arr = f.arrayBuffer; const bitmap = await createImageBitmap(new Blob([arr], { type: f.type })); const variantsOut = []; for (const v of variants) { try { const maxDim = v.maxDim || 1080; const quality = typeof v.quality === 'number' ? v.quality : 0.8; const mime = v.mime || 'image/jpeg'; let w = bitmap.width; let h = bitmap.height; if (Math.max(w, h) > maxDim) { if (w >= h) { const scale = maxDim / w; w = Math.max(1, Math.round(w * scale)); h = Math.max(1, Math.round(h * scale)); } else { const scale = maxDim / h; h = Math.max(1, Math.round(h * scale)); w = Math.max(1, Math.round(w * scale)); } } const oc = new OffscreenCanvas(w, h); const ctx = oc.getContext('2d'); ctx.drawImage(bitmap, 0, 0, w, h); let blob = null; if (oc.convertToBlob) { blob = await oc.convertToBlob({ type: mime, quality }); } else { // fallback error
              // worker fallback string continues
              blob = await (async () => { throw new Error('convertToBlob not supported in worker'); })(); }
              variantsOut.push({ name: v.name, blob, mime }); } catch (e) { variantsOut.push({ name: v.name, error: String(e) }); } } try { bitmap.close(); } catch(e){} results.push({ fileName: f.name, variants: variantsOut }); } catch (err) { results.push({ fileName: f.name, error: String(err) }); } } self.postMessage({ results }); });`;

              let worker = null;
              try {
                const blob = new Blob([workerCode], { type: 'application/javascript' });
                const url = URL.createObjectURL(blob);
                worker = new Worker(url);
              } catch (e) {
                worker = null;
              }

              // prepare files as arrayBuffers
              const filesData = await Promise.all(files.map(async (f) => ({ name: f.name, type: f.type || 'application/octet-stream', arrayBuffer: await f.arrayBuffer() })));

              let workerResults = null;
              if (worker) {
                worker.postMessage({ files: filesData, variants }, filesData.map(f => f.arrayBuffer));
                workerResults = await new Promise((res) => {
                  worker.addEventListener('message', (ev) => { res(ev.data.results); });
                  // fallback timeout: if worker doesn't respond within 10s, terminate and fallback
                  setTimeout(() => { try { worker.terminate(); } catch (e) { }; res(null); }, 10000);
                });
                try { worker.terminate(); } catch (e) { }
              }

              // If worker failed, fallback to main-thread canvas-based compression
              if (!workerResults) {
                const fallbackResults = [];
                for (const f of files) {
                  try {
                    const imgUrl = URL.createObjectURL(f);
                    const img = await new Promise((res, rej) => {
                      const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = imgUrl;
                    });
                    const variantsOut = [];
                    for (const v of variants) {
                      const maxDim = v.maxDim || 1080;
                      const quality = typeof v.quality === 'number' ? v.quality : 0.8;
                      const mime = v.mime || 'image/jpeg';
                      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
                      const w = Math.max(1, Math.round(img.width * scale));
                      const h = Math.max(1, Math.round(img.height * scale));
                      const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h; const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0, w, h);
                      const blob = await new Promise((res2) => canvas.toBlob(res2, mime, quality));
                      variantsOut.push({ name: v.name, blob, mime });
                    }
                    URL.revokeObjectURL(imgUrl);
                    fallbackResults.push({ fileName: f.name, variants: variantsOut });
                  } catch (err) {
                    fallbackResults.push({ fileName: f.name, error: String(err) });
                  }
                }
                workerResults = fallbackResults;
              }

              // upload each variant
              const uploaded = { full: [], thumbsWebp: [] };
              for (let fi = 0; fi < workerResults.length; fi++) {
                const r = workerResults[fi];
                if (r.error) continue;
                const baseName = `${Date.now()}_${r.fileName.replace(/[^a-zA-Z0-9.\-]/g, '_')}`;
                // find corresponding blobs
                const fullObj = r.variants.find(v => v.name === 'full_jpeg');
                const thumbWebpObj = r.variants.find(v => v.name === 'thumb_webp');

                // upload full jpeg
                if (fullObj && fullObj.blob) {
                  const fullName = `${baseName}_full.jpg`;
                  const fullRef = storageRef(getStorage(), `products/${destProductId}/${fullName}`);
                  const metadata = { contentType: fullObj.mime || 'image/jpeg', cacheControl: 'public, max-age=31536000' };
                  const task = uploadBytesResumable(fullRef, fullObj.blob, metadata);
                  await new Promise((res, rej) => {
                    task.on('state_changed', (snap) => {
                      const pct = snap.totalBytes ? (snap.bytesTransferred / snap.totalBytes) * 100 : 0;
                      progressCb({ fileIndex: fi, variant: 'full', percent: pct });
                    }, (err) => rej(err), async () => { try { const url = await getDownloadURL(fullRef); uploaded.full.push(url); res(); } catch (e) { rej(e); } });
                  });
                }

                // upload thumb webp
                if (thumbWebpObj && thumbWebpObj.blob) {
                  const tname = `${baseName}_thumb.webp`;
                  const tref = storageRef(getStorage(), `products/${destProductId}/${tname}`);
                  const metadata = { contentType: thumbWebpObj.mime || 'image/webp', cacheControl: 'public, max-age=31536000' };
                  const task = uploadBytesResumable(tref, thumbWebpObj.blob, metadata);
                  await new Promise((res, rej) => {
                    task.on('state_changed', (snap) => {
                      const pct = snap.totalBytes ? (snap.bytesTransferred / snap.totalBytes) * 100 : 0;
                      progressCb({ fileIndex: fi, variant: 'thumb_webp', percent: pct });
                    }, (err) => rej(err), async () => { try { const url = await getDownloadURL(tref); uploaded.thumbsWebp.push(url); res(); } catch (e) { rej(e); } });
                  });
                }
              }

              return uploaded;
            };

            // Remove existing files under this product folder (except archive/) to avoid stale names
            try { await deleteFilesInProductFolder(docId); } catch (e) { /* ignore */ }
            // run compression+upload
            const uploaded = await compressAndUpload(imageFiles, docId, progressCb);

            // Persist image urls: full images and WebP thumbnails. Use webp thumbnail as primary thumbnail.
            await setDoc(doc(db, 'products', docId), { images: uploaded.full, thumbnailsWebp: uploaded.thumbsWebp, image: uploaded.full[0] || null, thumbnail: uploaded.thumbsWebp[0] || null, thumbnailWebp: uploaded.thumbsWebp[0] || null, updatedAt: serverTimestamp() }, { merge: true });

            // Attempt to archive previous files from Storage (best-effort): copy them to products/{docId}/archive/{filename} and then delete original
            try {
              const storage = getStorage();
              const archiveAndDelete = async (url) => {
                try {
                  // Client-side archiving via fetch can trigger CORS issues and 404s
                  // (and also is fragile). Instead, queue this URL for server-side
                  // archival. Persist a simple job list in localStorage so an admin
                  // process or Cloud Function can process it later.
                  const key = `inventory:archiveJobs:${docId}`;
                  const cur = JSON.parse(localStorage.getItem(key) || '[]');
                  cur.push({ url, createdAt: Date.now() });
                  localStorage.setItem(key, JSON.stringify(cur));
                  // Do NOT attempt fetch or delete from the browser to avoid CORS/404.
                  return;
                } catch (e) {
                  // best-effort: ignore
                }
              };

              // Persist archive jobs to Firestore so a server-side worker (Cloud Function)
              // can safely copy objects into products/{docId}/archive/ and then delete originals.
              // This avoids fragile client-side fetch/delete due to CORS and 404s.
              try {
                const jobs = [];
                for (const u of prevFull || []) jobs.push({ url: u });
                for (const u of prevThumbs || []) jobs.push({ url: u });
                for (const j of jobs) {
                  try {
                    await addDoc(collection(db, 'archiveJobs'), { productId: docId, url: j.url, status: 'pending', createdAt: serverTimestamp() });
                  } catch (e) {
                    // fallback: if Firestore write fails, attempt to queue in localStorage as a last resort
                    try {
                      const key = `inventory:archiveJobs:${docId}`;
                      const cur = JSON.parse(localStorage.getItem(key) || '[]');
                      cur.push({ url: j.url, createdAt: Date.now() });
                      localStorage.setItem(key, JSON.stringify(cur));
                    } catch (er) { }
                  }
                }
              } catch (e) {
                // ignore
              }
            } catch (e) { /* ignore */ }
          } catch (e) {
            console.error('Error uploading product images:', e);
          }
        }
      } else {
        // CREAR PRODUCTO (nueva lógica con contador)
        const statsRef = doc(db, 'stats', 'productCounter');

        // 1. Transacción para obtener y actualizar el contador atómicamente
        const newProductId = await runTransaction(db, async (transaction) => {
          const statsDoc = await transaction.get(statsRef);
          if (!statsDoc.exists()) {
            throw new Error("El contador de productos ('stats/productCounter') no existe.");
          }
          const currentNumber = Number(statsDoc.data().productNumber) || 0;
          const newNumber = currentNumber + 1;

          // Actualiza el contador
          transaction.update(statsRef, { productNumber: newNumber });

          return newNumber;
        });

        // 2. Crear el nuevo producto con el ID del contador
        const newProductRef = doc(db, 'products', String(newProductId));
        await setDoc(newProductRef, { ...payload, id: newProductId, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });

        // 3. Asignar cantidades a inventarios
        const batch = writeBatch(db);
        for (const iq of targetInvs) {
          const q = toInt(iq.quantity);
          if (q > 0) {
            const invRef = doc(db, 'inventories', iq.inventoryId);
            batch.set(invRef, { products: { [newProductRef.id]: { quantity: q } }, updatedAt: serverTimestamp() }, { merge: true });
          }
        }
        await batch.commit();
        // If there are images selected, compress & upload them, then update product doc with image URLs
        if (imageFiles && imageFiles.length > 0) {
          try {
            // remove any existing files under the new product folder (if any)
            try { await deleteFilesInProductFolder(newProductRef.id); } catch (e) { /* ignore */ }
            // reuse compression+upload helper used in edit path
            const uploaded = await (async () => {
              const progressNoop = () => { };
              // inline compressAndUpload same as above
              const variants = [
                { name: 'full_jpeg', maxDim: 1080, quality: 0.8, mime: 'image/jpeg' },
                { name: 'thumb_webp', maxDim: 300, quality: 0.8, mime: 'image/webp' }
              ];
              // For brevity reuse the same inline worker approach as edit branch
              const workerCode = `self.addEventListener('message', async (ev) => { const data = ev.data || {}; const files = data.files || []; const variants = data.variants || []; const results = []; for (const f of files) { try { const arr = f.arrayBuffer; const bitmap = await createImageBitmap(new Blob([arr], { type: f.type })); const variantsOut = []; for (const v of variants) { try { const maxDim = v.maxDim || 1080; const quality = typeof v.quality === 'number' ? v.quality : 0.8; const mime = v.mime || 'image/jpeg'; let w = bitmap.width; let h = bitmap.height; if (Math.max(w, h) > maxDim) { if (w >= h) { const scale = maxDim / w; w = Math.max(1, Math.round(w * scale)); h = Math.max(1, Math.round(h * scale)); } else { const scale = maxDim / h; h = Math.max(1, Math.round(h * scale)); w = Math.max(1, Math.round(w * scale)); } } const oc = new OffscreenCanvas(w, h); const ctx = oc.getContext('2d'); ctx.drawImage(bitmap, 0, 0, w, h); let blob = null; if (oc.convertToBlob) { blob = await oc.convertToBlob({ type: mime, quality }); } else { blob = await (async () => { throw new Error('convertToBlob not supported in worker'); })(); } variantsOut.push({ name: v.name, blob, mime }); } catch (e) { variantsOut.push({ name: v.name, error: String(e) }); } } try { bitmap.close(); } catch(e){} results.push({ fileName: f.name, variants: variantsOut }); } catch (err) { results.push({ fileName: f.name, error: String(err) }); } } self.postMessage({ results }); });`;
              let worker = null;
              try { const blob = new Blob([workerCode], { type: 'application/javascript' }); const url = URL.createObjectURL(blob); worker = new Worker(url); } catch (e) { worker = null; }
              const filesData = await Promise.all(imageFiles.map(async (f) => ({ name: f.name, type: f.type || 'application/octet-stream', arrayBuffer: await f.arrayBuffer() })));
              let workerResults = null;
              if (worker) {
                worker.postMessage({ files: filesData, variants }, filesData.map(f => f.arrayBuffer));
                workerResults = await new Promise((res) => { worker.addEventListener('message', (ev) => { res(ev.data.results); }); setTimeout(() => { try { worker.terminate(); } catch (e) { }; res(null); }, 10000); });
                try { worker.terminate(); } catch (e) { }
              }
              if (!workerResults) {
                const fallbackResults = [];
                for (const f of imageFiles) {
                  try {
                    const imgUrl = URL.createObjectURL(f);
                    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = imgUrl; });
                    const variantsOut = [];
                    for (const v of variants) {
                      const maxDim = v.maxDim || 1080; const quality = typeof v.quality === 'number' ? v.quality : 0.8; const mime = v.mime || 'image/jpeg'; const scale = Math.min(1, maxDim / Math.max(img.width, img.height)); const w = Math.max(1, Math.round(img.width * scale)); const h = Math.max(1, Math.round(img.height * scale)); const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h; const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0, w, h); const blob = await new Promise((res2) => canvas.toBlob(res2, mime, quality)); variantsOut.push({ name: v.name, blob, mime });
                    }
                    URL.revokeObjectURL(imgUrl);
                    fallbackResults.push({ fileName: f.name, variants: variantsOut });
                  } catch (err) { fallbackResults.push({ fileName: f.name, error: String(err) }); }
                }
                workerResults = fallbackResults;
              }
              // upload
              const uploaded = { full: [], thumbsWebp: [] };
              for (let fi = 0; fi < workerResults.length; fi++) {
                const r = workerResults[fi]; if (r.error) continue; const baseName = `${Date.now()}_${r.fileName.replace(/[^a-zA-Z0-9.\-]/g, '_')}`; const fullObj = r.variants.find(v => v.name === 'full_jpeg'); const thumbWebpObj = r.variants.find(v => v.name === 'thumb_webp');
                if (fullObj && fullObj.blob) { const fullName = `${baseName}_full.jpg`; const fullRef = storageRef(getStorage(), `products/${newProductRef.id}/${fullName}`); const metadata = { contentType: fullObj.mime || 'image/jpeg', cacheControl: 'public, max-age=31536000' }; const task = uploadBytesResumable(fullRef, fullObj.blob, metadata); await new Promise((res, rej) => { task.on('state_changed', (snap) => { const pct = snap.totalBytes ? (snap.bytesTransferred / snap.totalBytes) * 100 : 0; progressNoop({ fileIndex: fi, variant: 'full', percent: pct }); }, (err) => rej(err), async () => { try { const url = await getDownloadURL(fullRef); uploaded.full.push(url); res(); } catch (e) { rej(e); } }); }); }
                if (thumbWebpObj && thumbWebpObj.blob) { const tname = `${baseName}_thumb.webp`; const tref = storageRef(getStorage(), `products/${newProductRef.id}/${tname}`); const metadata = { contentType: thumbWebpObj.mime || 'image/webp', cacheControl: 'public, max-age=31536000' }; const task = uploadBytesResumable(tref, thumbWebpObj.blob, metadata); await new Promise((res, rej) => { task.on('state_changed', (snap) => { const pct = snap.totalBytes ? (snap.bytesTransferred / snap.totalBytes) * 100 : 0; progressNoop({ fileIndex: fi, variant: 'thumb_webp', percent: pct }); }, (err) => rej(err), async () => { try { const url = await getDownloadURL(tref); uploaded.thumbsWebp.push(url); res(); } catch (e) { rej(e); } }); }); }
              }
              return uploaded;
            })();
            await setDoc(doc(db, 'products', newProductRef.id), { images: uploaded.full, thumbnailsWebp: uploaded.thumbsWebp, image: uploaded.full[0] || null, thumbnail: uploaded.thumbsWebp[0] || null, thumbnailWebp: uploaded.thumbsWebp[0] || null, updatedAt: serverTimestamp() }, { merge: true });
          } catch (e) {
            console.error('Error uploading product images:', e);
          }
        }
      }

      // Listeners globales actualizarán la UI
      // success notification
      try { showNotification('Producto guardado con éxito.', 'success', 5000); } catch (e) { }
    } catch (err) {
      console.error('Error guardando producto:', err);
      showNotification(err?.message || 'No se pudo guardar el producto.', 'error');
    } finally {
      setIsUpdating(false);
      setIsModalOpen(false);
      setProductToEdit(null);
    }
  };

  // NUEVO: eliminar producto (producto + referencia en todos los inventarios)
  const handleDeleteProduct = async (productDocId) => {
    if (!productDocId) return;
    setIsUpdating(true);
    try {
      // Use a per-product pending key + transaction to make delete idempotent
      const pendingKey = user?.uid ? `inventory:pending:product_delete:${productDocId}:${user.uid}` : `inventory:pending:product_delete:${productDocId}:anon`;
      let stored = null;
      try { stored = JSON.parse(localStorage.getItem(pendingKey) || 'null'); } catch (e) { stored = null; }
      const opId = stored?.opId || `inv_del_${productDocId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      try { localStorage.setItem(pendingKey, JSON.stringify({ opId, createdAt: Date.now() })); } catch (e) { }

      try {
        await runTransaction(db, async (tx) => {
          const histRef = doc(db, 'history', 'main', 'inventoryEdits', opId);
          const existing = await tx.get(histRef);
          if (existing.exists()) return; // already applied

          const prodRef = doc(db, 'products', productDocId);
          tx.delete(prodRef);

          for (const inv of inventories) {
            const invRef = doc(db, 'inventories', inv.id);
            tx.update(invRef, { [`products.${productDocId}`]: deleteField(), updatedAt: serverTimestamp() });
          }

          tx.set(histRef, {
            id: opId,
            type: 'product_delete',
            productId: productDocId,
            userId: user?.uid || null,
            createdAt: serverTimestamp()
          });
        });
      } finally {
        try { localStorage.removeItem(pendingKey); } catch (e) { }
      }
    } catch (err) {
      console.error('Error eliminando producto:', err);
      showNotification(err?.message || 'No se pudo eliminar el producto.', 'error');
    } finally {
      setIsUpdating(false);
      setIsModalOpen(false);
      setProductToEdit(null);
    }
  };

  // Crear nuevo inventario desde el modal (devuelve el objeto creado o null)
  const handleCreateInventory = async (inventoryName) => {
    if (!inventoryName || !String(inventoryName).trim()) return null;
    try {
      const normalized = normalizeName(inventoryName);
      // Verifica duplicados en Firestore buscando todos y comparando normalizados
      const snapAll = await getDocs(collection(db, 'inventories'));
      const existing = snapAll.docs.map(d => ({ id: d.id, ...d.data() })).find(d => normalizeName(d.name) === normalized);
      if (existing) return existing;

      const payload = { name: normalized, products: {}, updatedAt: serverTimestamp() };
      const ref = await addDoc(collection(db, 'inventories'), payload);
      return { id: ref.id, ...payload };
    } catch (err) {
      console.error('Error creando inventario:', err);
      showNotification(err?.message || 'No se pudo crear el inventario', 'error');
      return null;
    }
  };

  // Crear nueva marca desde el modal (devuelve el objeto creado o null)
  const handleCreateBrand = async (brandName) => {
    if (!brandName || !String(brandName).trim()) return null;
    try {
      const normalized = normalizeName(brandName);
      const snapAll = await getDocs(collection(db, 'brands'));
      const existing = snapAll.docs.map(d => ({ id: d.id, ...d.data() })).find(d => normalizeName(d.name) === normalized);
      if (existing) return existing;

      const payload = { name: normalized };
      const ref = await addDoc(collection(db, 'brands'), payload);
      return { id: ref.id, ...payload };
    } catch (err) {
      console.error('Error creando marca:', err);
      showNotification(err?.message || 'No se pudo crear la marca', 'error');
      return null;
    }
  };

  const totalInventory = {
    id: 'total',
    name: 'Total',
    products: inventories.reduce((acc, inv) => {
      for (const productDocId in (inv.products || {})) {
        const q = Number(inv.products[productDocId]?.quantity) || 0;
        acc[productDocId] = { quantity: (acc[productDocId]?.quantity || 0) + q };
      }
      return acc;
    }, {})
  };

  const displayInventories = [totalInventory, ...[...inventories].sort((a, b) => a.id.localeCompare(b.id))];
  const selectedInventory = displayInventories.find(inv => inv.id === selectedInventoryId);

  // Prepare products array for searcher (include docId)
  const productsArray = React.useMemo(() => {
    return Object.keys(productsMap || {}).map(docId => ({ ...(productsMap[docId] || {}), docId }));
  }, [productsMap]);

  // createSearcher pre-processes items for fuzzy search; rebuild when productsArray changes
  const productSearcher = React.useMemo(() => createSearcher(productsArray || [], { keys: ['name', 'id', 'docId'], nameKey: 'name', maxResults: 2000, minScore: 8 }), [productsArray]);

  const filteredAndSortedKeys = React.useMemo(() => {
    // No search: return all keys sorted by numeric product id (existing behavior)
    if (!searchTerm || !String(searchTerm).trim()) {
      return Object.keys(productsMap).sort((a, b) => (productsMap[a].id ?? 0) - (productsMap[b].id ?? 0));
    }

    try {
      const results = productSearcher.search(searchTerm, { maxResults: 2000, minScore: 6 });
      // results are ordered by relevance; map back to docId
      const keys = results.map(r => (r.item?.docId || String(r.item?.id || ''))).filter(Boolean);
      // ensure uniqueness preserving order
      const seen = new Set();
      const unique = [];
      for (const k of keys) {
        if (!seen.has(k)) { seen.add(k); unique.push(k); }
      }
      return unique;
    } catch (e) {
      // fallback to simple substring filter
      return Object.keys(productsMap)
        .filter(productDocId => (productsMap[productDocId]?.name || '').toLowerCase().includes(searchTerm.toLowerCase()))
        .sort((a, b) => (productsMap[a].id ?? 0) - (productsMap[b].id ?? 0));
    }
  }, [searchTerm, productsMap, productSearcher]);

  const Row = ({ index, style }) => {
    const productDocId = filteredAndSortedKeys[index];
    const productInfo = productsMap[productDocId];
    const inventoryProductData = selectedInventory?.products?.[productDocId];
    const quantity = Number(inventoryProductData?.quantity) || 0;
    const brand = brands.find(b => b.id === productInfo?.brandId);
    // Compact list rendering (no thumbs) — used when viewMode === 'list'
    if (viewMode === 'list') {
      const priceLabel = productInfo?.price != null ? `$${Number(productInfo.price).toFixed(2)}` : 'N/A';
      return (
        <div style={style} className={`compact-row${quantity === 0 ? ' out' : ''}`}>
          <div className="compact-row-inner" onClick={() => handleEditClick(productDocId)} style={{ cursor: 'pointer' }}>
            <div className="compact-main">
              <div className="compact-top">
                <span className="compact-name" title={productInfo?.name}>{productInfo?.name || 'N/A'}</span>
                <span className="compact-price">{priceLabel}</span>
              </div>
              <div className="compact-meta">
                <span className="compact-id">ID: {productInfo?.id ?? 'N/A'}</span>
                <span className="compact-brand">{brand?.name || '-'}</span>
                <span className="compact-qty">{quantity}</span>
              </div>
            </div>
            <div className="compact-actions">
              <button onClick={(e) => { e.stopPropagation(); handleEditClick(productDocId); }} className="outline secondary row-edit-btn" aria-label={`Editar ${productInfo?.name || ''}`}>
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>
              </button>
            </div>
          </div>
        </div>
      );
    }

    // Default: table/desktop row (original behavior)
    return (
      <div style={style} className="table-row">
        {/* NEW: wrapper to control internal layout even when react-window sets inline position/height */}
        <div className="table-row-inner">
          <div className="table-cell" style={{ flex: '0 0 50px', justifyContent: 'center' }}>
            <button onClick={(e) => { e.stopPropagation(); handleEditClick(productDocId); }} className="outline secondary row-edit-btn">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>
            </button>
          </div>
          <div className="table-cell id-cell" style={{ flex: '0 0 80px' }}>{productInfo?.id || 'N/A'}</div>
          <div className="table-cell" style={{ flex: '2 1 0' }}>{productInfo?.name || 'N/A'}</div>
          <div className="table-cell" style={{ flex: '1 1 0' }}>{brand?.name || <span className="muted">-</span>}</div>
          <div className="table-cell numeric" style={{ flex: '1 1 0' }}>{productInfo?.price != null ? `$${Number(productInfo.price).toFixed(2)}` : 'N/A'}</div>
          <div className="table-cell numeric" style={{ flex: '1 1 0' }}>{productInfo?.cost != null ? `$${Number(productInfo.cost).toFixed(2)}` : 'N/A'}</div>
          <div className="table-cell numeric" style={{ flex: '0 0 100px', justifyContent: 'flex-start' }}>{quantity}</div>
        </div>
      </div>
    );
  };

  return (
    <>
      {notification.message && (
        <div
          className={`app-toast app-toast-fixed ${notification.type}`}
          data-icon={notification.type === 'success' ? '✓' : notification.type === 'error' ? '✕' : 'ℹ'}
          role="status"
          aria-live="polite"
        >
          {notification.message}
        </div>
      )}
      <section className="inventory-page" style={{ width: "100%", margin: '0 auto', padding: '2rem 1rem' }}>
        <header>
          <h1>Inventario de Productos</h1>
          <p className="muted">Consulta y gestiona los productos disponibles.</p>
        </header>

        {loading && <article aria-busy="true">Cargando...</article>}

        {!loading && (
          <div>
            <div className="inventory-controls">
              <ProductSearchBar searchTerm={searchTerm} onSearchChange={setSearchTerm} />
              <div className="view-switcher" role="tablist" aria-label="Selector de vista">
                <button
                  /* Temporarily disable list mode because it has known bugs — no-op until fixed */
                  onClick={() => {/* no-op */ }}
                  title="Modo lista"
                  className={`outline secondary ${viewMode === 'list' ? 'active' : ''}`}
                  aria-pressed={viewMode === 'list'}
                >
                  Lista
                </button>
                <button onClick={() => handleSetViewMode('grid')} className={`outline secondary ${viewMode === 'grid' ? 'active' : ''}`} aria-pressed={viewMode === 'grid'}>Cuadrícula</button>
              </div>
            </div>

            <nav className="inventory-nav-wrap">
              <ul className="inventory-nav">
                {displayInventories.map(inventory => (
                  <li key={inventory.id}>
                    <a
                      href="#!"
                      onClick={(e) => { e.preventDefault(); handleInventoryChange(inventory.id); }}
                      className={`inventory-tab ${selectedInventoryId === inventory.id ? 'active' : ''}`}
                      aria-current={selectedInventoryId === inventory.id ? 'page' : undefined}
                    >
                      {inventory.name || inventory.id}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>

            {selectedInventory && (
              <article key={selectedInventory.id}>
                <h2 style={{ textTransform: 'capitalize' }}>{selectedInventory.name || selectedInventory.id}</h2>
                {filteredAndSortedKeys.length === 0 ? (
                  <p>{searchTerm ? `No se encontraron productos que coincidan con "${searchTerm}".` : "No hay productos en el sistema."}</p>
                ) : viewMode === 'list' ? (
                  // Simple semantic table list for readability and stability
                  <div className="simple-list-wrap">
                    <div className="simple-list-scroll">
                      <table className="simple-list" role="table">
                        <thead>
                          <tr>
                            <th scope="col">Nombre</th>
                            <th scope="col" className="hide-on-mobile">Marca</th>
                            <th scope="col" className="numeric">Precio</th>
                            <th scope="col" className="numeric">Cantidad</th>
                            <th scope="col" className="hide-on-mobile">ID</th>
                            <th scope="col">Acciones</th>
                          </tr>
                        </thead>
                        <tbody>
                          {filteredAndSortedKeys.map((productDocId) => {
                            const productInfo = productsMap[productDocId];
                            const inventoryProductData = selectedInventory?.products?.[productDocId];
                            const quantity = Number(inventoryProductData?.quantity) || 0;
                            const brand = brands.find(b => b.id === productInfo?.brandId);
                            const priceLabel = productInfo?.price != null ? `$${Number(productInfo.price).toFixed(2)}` : 'N/A';

                            return (
                              <tr key={productDocId} className={`${quantity === 0 ? 'out' : ''}`}>
                                <td className="name-cell" title={productInfo?.name}>{productInfo?.name || 'N/A'}</td>
                                <td className="hide-on-mobile">{brand?.name || '-'}</td>
                                <td className="numeric">{priceLabel}</td>
                                <td className="numeric">{quantity}</td>
                                <td className="hide-on-mobile mono">{productInfo?.id ?? 'N/A'}</td>
                                <td className="actions-cell">
                                  <button onClick={() => handleEditClick(productDocId)} className="outline secondary row-edit-btn" aria-label={`Editar ${productInfo?.name || ''}`}>
                                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>
                                  </button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : (
                  // GRID -> virtualized single-column rows usando el layout de ProductSearchModal (lps-row)
                  <div className="inventory-lps" style={{ width: '100%' }}>
                    <List
                      className="rw-outer"
                      height={600}
                      itemCount={filteredAndSortedKeys.length}
                      itemSize={74} /* altura en ProductSearchModal: --lps-row-height (74). Ajusta si quieres más espacio */
                      width={'100%'}
                    >
                      {({ index, style }) => {
                        const productDocId = filteredAndSortedKeys[index];
                        const productInfo = productsMap[productDocId];
                        const inventoryProductData = selectedInventory?.products?.[productDocId];
                        const quantity = Number(inventoryProductData?.quantity) || 0;
                        const brand = brands.find(b => b.id === productInfo?.brandId);
                        const hasImage = !!productInfo?.image;
                        const priceLabel = productInfo?.price != null ? `$${Number(productInfo.price).toFixed(2)}` : 'N/A';

                        return (
                          <div key={productDocId} style={style}>
                            <div
                              className={`lps-row${quantity === 0 ? ' out' : ''}`}
                              role="article"
                              aria-label={productInfo?.name || 'Producto'}
                              onClick={() => handleEditClick(productDocId)}
                              style={{ cursor: 'pointer' }}
                            >
                              <div className="lps-thumb" style={{ flex: '0 0 54px' }}>
                                {hasImage ? (
                                  <img
                                    src={productInfo.thumbnail || productInfo.image}
                                    srcSet={(productInfo.thumbnail ? productInfo.thumbnail + ' 300w, ' : '') + (productInfo.image ? productInfo.image + ' 1080w' : '')}
                                    sizes="(max-width:600px) 120px, 54px"
                                    width={54}
                                    height={54}
                                    alt={productInfo?.name || ''}
                                    loading="lazy"
                                    style={{ cursor: 'zoom-in' }}
                                    onClick={(e) => { e.stopPropagation(); setViewerSrc(productInfo.image || productInfo.thumbnail); setViewerOpen(true); }}
                                    onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }}
                                  />
                                ) : (
                                  <span className="lps-thumb-ph" aria-hidden="true">?</span>
                                )}
                              </div>

                              <div className="lps-main">
                                <div className="lps-line1">
                                  <span className="lps-name">{productInfo?.name || 'N/A'}</span>
                                  <span className="lps-price">{priceLabel}</span>
                                </div>
                                <div className="lps-line2">
                                  <span className="lps-id">ID: {productInfo?.id ?? 'N/A'}</span>
                                  <span className="lps-stock">Stock: {quantity}</span>
                                  <span className="lps-price-bs" aria-hidden="true" style={{ marginLeft: '0.6rem', color: 'var(--lps-text-dim)', fontSize: '0.86rem' }}>
                                    {brand?.name || '-'}
                                  </span>
                                </div>
                              </div>

                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', marginLeft: '0.6rem' }}>
                                <button onClick={(e) => { e.stopPropagation(); handleEditClick(productDocId); }} className="outline secondary row-edit-btn" aria-label={`Editar ${productInfo?.name || ''}`}>
                                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>
                                </button>
                              </div>
                            </div>
                          </div>
                        );
                      }}
                    </List>
                  </div>
                )}
              </article>
            )}
          </div>
        )}
      </section>

      <AddProductButton onClick={() => setIsModalOpen(true)} />
      <NewModalAddProductModal
        isOpen={isModalOpen}
        onClose={handleCloseModal}
        onAddProduct={handleAddProduct}
        onDeleteProduct={handleDeleteProduct}
        inventories={[...inventories].sort((a, b) => a.id.localeCompare(b.id))}
        brands={brands}
        loading={isUpdating}
        onCreateInventory={handleCreateInventory}
        onCreateBrand={handleCreateBrand}
        productToEdit={productToEdit}
        appSettings={settings}
      />
      <ImageViewerModal isOpen={viewerOpen} src={viewerSrc} onClose={() => { setViewerOpen(false); setViewerSrc(null); }} />
    </>
  );
}

export default Inventory;