import React, { useState, useMemo, useRef, useEffect } from 'react';
import './Transfers.css';
import AddProductButton from '../AddProductButton/AddProductButton.js';
import QtyButton from '../UI/QtyButton';
import ProductSearchModalTransfers from './ProductSearchModalTransfers/ProductSearchModalTransfers.js';
import ImageViewerModal from '../ImageViewerModal/ImageViewerModal';
import { useData } from '../../context/DataProvider.jsx';
import { writeBatch, doc, setDoc, increment, serverTimestamp, runTransaction } from 'firebase/firestore';
import { db } from '../../firebase.js';

function Transfers({ user }) {
  const { products, inventories, settings } = useData();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [items, setItems] = useState([]); // reserved items for transfer
  const [fromInventoryId, setFromInventoryId] = useState(inventories?.[0]?.id || '');
  const [toInventoryId, setToInventoryId] = useState(inventories?.[1]?.id || (inventories?.[0]?.id || ''));
  const [showFromMenu, setShowFromMenu] = useState(false);
  const [showToMenu, setShowToMenu] = useState(false);

  const fromRef = useRef(null);
  const toRef = useRef(null);

  // --- local cache & interaction guards (pattern similar to Buys) ---
  const userInteractedRef = useRef(false);
  const quickLoadedRef = useRef(false);
  const loadedFromCacheRef = useRef(false);
  const [transferNotice, setTransferNotice] = useState(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [viewerSrc, setViewerSrc] = useState(null);

  const makeCacheKeys = () => {
    const keys = [];
    if (user?.uid) keys.push(`transfers:state:${user.uid}`);
    keys.push('transfers:state:anon');
    return keys;
  };

  // Quick load on mount to restore UI state fast (doesn't depend on inventories)
  useEffect(() => {
    if (quickLoadedRef.current) return;
    try {
      const keys = makeCacheKeys();
      let raw = null;
      let usedKey = null;
      for (const k of keys) {
        const r = localStorage.getItem(k);
        if (r) { raw = r; usedKey = k; break; }
      }
      if (!raw) { quickLoadedRef.current = true; return; }
      const parsed = JSON.parse(raw);
      if (!parsed) { quickLoadedRef.current = true; return; }
      if (Array.isArray(parsed.items)) setItems(parsed.items.map(it => ({ ...it, quantity: Number(it.quantity) || 0 })));
      if (parsed.fromInventoryId) setFromInventoryId(parsed.fromInventoryId);
      if (parsed.toInventoryId) setToInventoryId(parsed.toInventoryId);
    } catch (e) {
      console.warn('Error quick-loading transfers cache:', e);
    } finally { quickLoadedRef.current = true; }
  }, []);

  // Ensure defaults when inventories load (handles F5/load ordering)
  useEffect(() => {
    if (!inventories || !inventories.length) return;
    setFromInventoryId(prev => prev || inventories[0]?.id || '');
    setToInventoryId(prev => prev || (inventories[1]?.id || inventories[0]?.id || ''));

    // final reconciliation: ensure cached items and selected inventories are valid against loaded inventories
    if (!loadedFromCacheRef.current) {
      try {
        // if cached from/to are invalid, fallback to sensible defaults
        setFromInventoryId(prev => inventories.some(i => i.id === prev) ? prev : (inventories[0]?.id || ''));
        setToInventoryId(prev => inventories.some(i => i.id === prev) ? prev : (inventories[1]?.id || inventories[0]?.id || ''));
        // optionally we could reconcile item quantities against stock here
      } catch (e) {
        // ignore
      } finally {
        loadedFromCacheRef.current = true;
      }
    }
  }, [inventories]);

  const addItem = (product, quantity = 1) => {
    userInteractedRef.current = true;
    // clamp to origin stock if possible
    const originQty = Number((inventories.find(i => i.id === fromInventoryId)?.products || {})[product.docId]?.quantity) || 0;
    const desired = Number(quantity) || 1;
    const allowed = Math.min(desired, originQty);
    if (allowed !== desired) setTransferNotice({ message: 'Cantidad ajustada al stock disponible del inventario de origen.', type: 'info' });
    setItems(prev => {
      const found = prev.find(p => p.docId === product.docId);
      if (found) return prev.map(p => p.docId === product.docId ? { ...p, quantity: (Number(p.quantity) || 0) + allowed } : p);
      return [...prev, { ...product, quantity: allowed }];
    });
  };

  // When the modal changes the selected source inventory, validate so we don't
  // allow source === destination. If user selects the current destination as
  // source, swap source and destination (keeps intent but prevents local->local).
  const handleFromInventoryChange = (newFromId) => {
    userInteractedRef.current = true;
    setFromInventoryId((prevFrom) => {
      // If selecting the same as current destination, swap
      if (newFromId && newFromId === toInventoryId) {
        setToInventoryId(prevFrom || newFromId);
      }
      return newFromId;
    });
  };

  // Symmetric handler for changing the destination from a selector: if the
  // user selects the current source as destination, swap them to preserve intent.
  const handleToInventoryChange = (newToId) => {
    userInteractedRef.current = true;
    setToInventoryId((prevTo) => {
      if (newToId && newToId === fromInventoryId) {
        setFromInventoryId(prevTo || newToId);
      }
      return newToId;
    });
  };

  // Close menus on outside click
  useEffect(() => {
    function onDocClick(e) {
      if (fromRef.current && !fromRef.current.contains(e.target)) setShowFromMenu(false);
      if (toRef.current && !toRef.current.contains(e.target)) setShowToMenu(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const removeItem = (docId) => setItems(prev => prev.filter(p => p.docId !== docId));
  const incrementQty = (docId) => setItems(prev => prev.map(p => {
    if (p.docId !== docId) return p;
    const originQty = Number((inventories.find(i => i.id === fromInventoryId)?.products || {})[p.docId]?.quantity) || 0;
    const cur = Number(p.quantity) || 0;
    const next = Math.min(cur + 1, originQty);
    if (next === cur) return p;
    userInteractedRef.current = true;
    return { ...p, quantity: next };
  }));

  // allow decrement down to 0 so items can reflect 0 stock
  const decrement = (docId) => setItems(prev => prev.map(p => p.docId === docId ? { ...p, quantity: Math.max(0, (Number(p.quantity) || 0) - 1) } : p));

  // mark interactions on quantity changes & removals
  useEffect(() => {
    // whenever items change due to user actions, consider it an interaction
    // note: this is a light heuristic — addItem/increment/decrement/removeItem already set the ref when applicable
  }, [items]);

  // Persist transfers state conservatively (avoid clobbering existing non-empty cache)
  useEffect(() => {
    try {
      if (!quickLoadedRef.current && !userInteractedRef.current) return;
      const payload = { items, fromInventoryId, toInventoryId, savedAt: Date.now() };
      const s = JSON.stringify(payload);
      const keys = makeCacheKeys();

      // Avoid overwriting a non-empty stored payload with an empty local state
      const currentCount = Array.isArray(items) ? items.reduce((s, it) => s + (Number(it.quantity) || 0), 0) : 0;
      if (currentCount === 0 && !userInteractedRef.current) {
        try {
          for (const k of keys) {
            const rawStored = localStorage.getItem(k);
            if (!rawStored) continue;
            try {
              const parsedStored = JSON.parse(rawStored);
              const storedCount = Array.isArray(parsedStored.items) ? parsedStored.items.reduce((s, it) => s + (Number(it.quantity) || 0), 0) : 0;
              if (storedCount > 0) return; // skip saving
            } catch (e) { /* ignore parse errors */ }
          }
        } catch (e) { /* ignore */ }
      }

      if (user?.uid) localStorage.setItem(`transfers:state:${user.uid}`, s);
      localStorage.setItem('transfers:state:anon', s);
    } catch (e) {
      console.warn('Could not persist transfers cache:', e);
    }
  }, [items, fromInventoryId, toInventoryId, user?.uid]);

  const totals = useMemo(() => {
    return items.reduce((acc, it) => {
      const cost = Number(it.cost || it.baseCost || 0);
      acc.bs += Math.round(cost * (Number(settings?.dolarParalelo || 1) || 1));
      return acc;
    }, { bs: 0 });
  }, [items, settings]);

  // Destination inventory product map for showing resulting totals
  const destInventory = inventories.find(i => i.id === toInventoryId) || null;
  const destInventoryProductMap = destInventory?.products || {};

  // Reconcile existing item quantities when the origin inventory changes or
  // when inventories are (re)loaded. This ensures quantities never exceed
  // the available stock in the selected origin without requiring manual edit.
  useEffect(() => {
    if (!inventories || !inventories.length) return;
    const originMap = (inventories.find(i => i.id === fromInventoryId)?.products) || {};
    setItems(prev => {
      let changed = false;
      const next = prev.map(it => {
        const originQty = Number(originMap?.[it.docId]?.quantity) || 0;
        const cur = Number(it.quantity) || 0;
        const clamped = Math.min(cur, originQty);
        if (clamped !== cur) { changed = true; return { ...it, quantity: clamped }; }
        return it;
      });
      if (changed) {
        // small timeout so state update happens before the toast (better UX)
        setTimeout(() => setTransferNotice({ message: 'Se ajustaron las cantidades según el stock del inventario de origen.', type: 'info' }), 30);
      }
      return next;
    });
  }, [fromInventoryId, inventories]);

  const handleConfirm = () => {
    // guard: nothing to confirm
    const totalQty = items.reduce((s,i)=>s+Number(i.quantity||0),0);
    if (totalQty === 0) return;
    setShowConfirm(true);
  };

  const confirmTransfer = async () => {
    setShowConfirm(false);
    // basic guards
    if (!fromInventoryId || !toInventoryId || fromInventoryId === toInventoryId) {
      setTransferNotice({ message: 'Selecciona inventarios de origen y destino válidos.', type: 'error' });
      return;
    }
    const totalQty = items.reduce((s,i) => s + Number(i.quantity || 0), 0);
    if (totalQty === 0) {
      setTransferNotice({ message: 'No hay cantidades a transferir.', type: 'error' });
      return;
    }

    // validate against local inventory snapshot
    const originInv = inventories.find(i => i.id === fromInventoryId);
    if (!originInv) { setTransferNotice({ message: 'Inventario de origen no encontrado.', type: 'error' }); return; }

    for (const it of items) {
      const avail = Number(originInv.products?.[it.docId]?.quantity) || 0;
      if ((Number(it.quantity) || 0) > avail) {
        setTransferNotice({ message: `Stock insuficiente para ${it.name || it.docId}. Disponible: ${avail}.`, type: 'error' });
        return;
      }
    }

    try {
      const originRef = doc(db, 'inventories', fromInventoryId);
      const destRef = doc(db, 'inventories', toInventoryId);

      // Consolidate quantities by product key (docId || id) to avoid duplicate field writes
      const sums = {};
      for (const it of items) {
        const key = it?.docId || it?.id;
        if (!key) continue;
        const qty = Number(it.quantity) || 0;
        if (qty === 0) continue;
        sums[key] = (sums[key] || 0) + qty;
      }

      const originFields = {};
      const destFields = {};
      for (const [key, qty] of Object.entries(sums)) {
        if (!key) continue;
        const q = Number(qty) || 0;
        if (q === 0) continue;
        try {
          const incNeg = increment(-q);
          const incPos = increment(q);
          originFields[`products.${key}.quantity`] = incNeg;
          destFields[`products.${key}.quantity`] = incPos;
        } catch (e) {
          console.error('[Transfers] error building increment for', key, q, e);
        }
      }

      // If no effective updates, bail out
      if (Object.keys(originFields).length === 0 && Object.keys(destFields).length === 0) {
        setTransferNotice({ message: 'No hay cambios a aplicar.', type: 'info' });
        return;
      }

      const clean = (fields) => {
        const out = {};
        for (const [k,v] of Object.entries(fields)) {
          if (v === undefined) continue;
          out[k] = v;
        }
        return out;
      };

      const safeOrigin = clean(originFields);
      const safeDest = clean(destFields);

      // prepare history items snapshot before we clear UI state
      const originMap = (inventories.find(i => i.id === fromInventoryId)?.products) || {};
      const destMap = (inventories.find(i => i.id === toInventoryId)?.products) || {};
      const historyItems = Object.entries(sums).map(([key, qty]) => {
        const found = items.find(it => ((it.docId || it.id) == key));
        const name = found?.name || key;
        const originBefore = Number(originMap?.[key]?.quantity) || 0;
        const destBefore = Number(destMap?.[key]?.quantity) || 0;
        return {
          productDocId: key,
          productId: found?.id ?? null,
          name,
          quantity: qty,
          originBefore,
          originAfter: Math.max(0, originBefore - qty),
          destBefore,
          destAfter: destBefore + qty
        };
      });

      const itemCount = historyItems.reduce((s,i) => s + (Number(i.quantity) || 0), 0);
      const transferTotals = { bs: 0, usdAdjusted: 0, usdInt: 0, bsDecimals: 0 };
      const fromName = inventories.find(i => i.id === fromInventoryId)?.name || '';
      const toName = inventories.find(i => i.id === toInventoryId)?.name || '';

      // Prepare a stable transfer id for idempotency via localStorage
      const transferId = `transfer_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
      const pendingKey = user?.uid ? `transfers:pending:${user.uid}` : 'transfers:pending:anon';
      let stored = null;
      try { stored = JSON.parse(localStorage.getItem(pendingKey) || 'null'); } catch (e) { stored = null; }
      const stableTransferId = stored?.transferId || transferId;
      try { localStorage.setItem(pendingKey, JSON.stringify({ transferId: stableTransferId, createdAt: Date.now() })); } catch (e) {}

      // run transaction that is idempotent: skip if history doc exists
      await runTransaction(db, async (tx) => {
        const transferRef = doc(db, 'history', 'main', 'transfers', stableTransferId);
        const existing = await tx.get(transferRef);
        if (existing.exists()) {
          return; // already applied
        }

        if (Object.keys(safeOrigin).length) tx.update(originRef, { ...safeOrigin, updatedAt: serverTimestamp() });
        if (Object.keys(safeDest).length) tx.update(destRef, { ...safeDest, updatedAt: serverTimestamp() });

        tx.set(transferRef, {
          id: stableTransferId,
          transferredAt: serverTimestamp(),
          transferredAtISO: new Date().toISOString(),
          userId: user?.uid || null,
          fromInventoryId,
          fromInventoryName: fromName,
          toInventoryId,
          toInventoryName: toName,
          items: historyItems,
          totals: transferTotals,
          ratesUsed: { bcv: Number(settings?.dolarBCV) || 0, paralelo: Number(settings?.dolarParalelo) || 0 },
          summary: { itemCount, productLines: historyItems.length, totalUnits: itemCount }
        });
      });

      // success: clear pending marker and update UI
      try { localStorage.removeItem(pendingKey); } catch (e) {}
      setItems([]);
      setIsModalOpen(false);
      setTransferNotice({ message: 'Transferencia confirmada.', type: 'success' });
    } catch (err) {
      console.error('confirmTransfer error', err);
      setTransferNotice({ message: 'No se pudo confirmar la transferencia.', type: 'error' });
    }
  };

  // Auto-dismiss transfer notices after a delay (mobile/desktop consistent)
  useEffect(() => {
    if (!transferNotice) return;
    const timeout = setTimeout(() => setTransferNotice(null), 6000);
    return () => clearTimeout(timeout);
  }, [transferNotice]);

  return (
    <div className="cashier-container">
      <div className="cashier-header">
        <h2>Transferencias</h2>
        {transferNotice && (
          <div
            className={`app-toast app-toast-fixed ${transferNotice.type}`}
            data-icon={transferNotice.type === 'success' ? '✓' : transferNotice.type === 'error' ? '✕' : 'ℹ'}
            role="status"
            aria-live="polite"
            style={{ marginLeft: 16 }}
          >{transferNotice.message}</div>
        )}
      </div>

      <section className="transfers-body">
        <article className="cart-area transfers-card">
      <div style={{ marginBottom: 12 }} className="transfer-selectors">
        <div className="selector from">
                <label className="label">Enviar desde</label>
                {inventories.length === 0 ? (
                  <div className="pill-select"><button disabled>No hay inventarios</button></div>
                ) : (
                  <div className="pill-select" ref={fromRef}>
                    <button type="button" className={"active"} onClick={() => { setShowFromMenu(v => !v); setShowToMenu(false); }}>{inventories.find(i=>i.id===fromInventoryId)?.name || 'Seleccionar'}</button>
                    {showFromMenu && (
                      <div className="pill-menu">
                        {inventories.map(inv => (
                          <button key={inv.id} type="button" className={inv.id === fromInventoryId ? 'menu-item active' : 'menu-item'} onClick={() => { handleFromInventoryChange(inv.id); setShowFromMenu(false); }}>
                            {inv.name}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="transfer-arrow" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                  <path d="M3 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>

              <div className="selector to">
                <label className="label">Enviar hacia</label>
                {inventories.length < 2 ? (
                  <div className="pill-select"><button disabled>No disponible</button></div>
                ) : (
                  <div className="pill-select" ref={toRef}>
                    <button type="button" className={"active"} onClick={() => { setShowToMenu(v => !v); setShowFromMenu(false); }}>{inventories.find(i=>i.id===toInventoryId)?.name || 'Seleccionar'}</button>
                    {showToMenu && (
                      <div className="pill-menu">
                        {inventories.map(inv => (
                          <button key={inv.id} type="button" className={inv.id === toInventoryId ? 'menu-item active' : 'menu-item'} onClick={() => { handleToInventoryChange(inv.id); setShowToMenu(false); }}>
                            {inv.name}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="transfer-note muted small">Añade productos y confirma la transferencia entre inventarios.</div>
            </div>

          <div className="transfers-list" aria-label="Productos para transferir">
            <div className="cart-header-row" style={{ display: items.length ? 'grid' : 'none' }}>
              <div>Producto</div>
              <div>En destino (antes)</div>
              <div>Cant.</div>
              <div>Total en destino</div>
              <div></div>
            </div>

            <div className="cart-body">
              {items.length === 0 ? (
                <div className="cart-empty">No hay productos añadidos. Usa el botón + para buscar productos.</div>
              ) : (
                items.map(item => {
                  const destBefore = Number(destInventoryProductMap?.[item.docId]?.quantity) || 0;
                  const qty = Number(item.quantity) || 0;
                  const destAfter = destBefore + qty;
                  return (
                  <div className="cart-row" key={item.docId}>
                    <div className="cart-cell">
                      {(item.thumbnailWebp || item.thumbnail || item.image) && (
                        <button
                          className="cart-thumb-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            const src = item.thumbnailWebp || item.thumbnail || item.image;
                            setViewerSrc(src);
                            setViewerOpen(true);
                          }}
                          aria-label={`Previsualizar ${item.name || 'imagen'}`}
                        >
                          <img className="cart-thumb" src={item.thumbnailWebp || item.thumbnail || item.image} alt={item.name || 'Imagen'} />
                        </button>
                      )}
                      <div className="cart-name">{item.name}</div>
                    </div>
                    <div className="cart-cell price"><div style={{ fontSize: '0.95rem', color: 'var(--c-text-dim)' }}>Antes: <strong style={{ color: 'var(--c-text)' }}>{destBefore}</strong></div></div>
                    <div className="cart-cell quantity">
                      <div className="qty-control">
                        <QtyButton variant="minus" onClick={() => { decrement(item.docId); }} ariaLabel={`Restar 1 a ${item.name}`} disabled={item.quantity <= 1} />
                        <div className="qty-number">{item.quantity}</div>
                        <QtyButton variant="plus" onClick={() => { incrementQty(item.docId); }} ariaLabel={`Sumar 1 a ${item.name}`} />
                      </div>
                    </div>
                    <div className="cart-cell subtotal"><span style={{ fontWeight: 600 }}>Total: {destAfter}</span></div>
                    <div className="cart-cell remove"><button className="remove-btn" onClick={() => removeItem(item.docId)} aria-label={`Eliminar ${item.name}`}>&times;</button></div>
                  </div>
                  );
                })
              )}
            </div>

            <div className="cart-footer">
              <div className="totals-block">
                <div className="totals-line">Total items: <strong>{items.reduce((s,i)=>s+Number(i.quantity||0),0)}</strong></div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center' }}>
                <button className="confirm-btn" onClick={handleConfirm} disabled={items.reduce((s,i)=>s+Number(i.quantity||0),0) === 0}>{items.reduce((s,i)=>s+Number(i.quantity||0),0) === 0 ? 'Nada que confirmar' : 'Confirmar Transferencia'}</button>
              </div>
            </div>
          </div>
        </article>
      </section>

  <AddProductButton onClick={() => setIsModalOpen(true)} />
  <ProductSearchModalTransfers isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} onAddProduct={(p,q)=>addItem(p,q)} allProducts={products} inventories={inventories} activeInventoryId={fromInventoryId} destInventoryId={toInventoryId} onInventoryChange={handleFromInventoryChange} appSettings={settings} cart={items} reservedMap={{}} />

  <ImageViewerModal isOpen={viewerOpen} onClose={() => { setViewerOpen(false); setViewerSrc(null); }} src={viewerSrc} alt="Imagen" />

      {showConfirm && (
        <div className="nmapm-confirm" role="dialog" aria-modal="true">
          <div className="nmapm-confirm-card">
            <div className="nmapm-confirm-text">¿Confirmar transferencia de <strong>{items.length}</strong> producto(s)?</div>
            <div className="nmapm-confirm-actions">
              <button className="nmapm-btn" onClick={() => setShowConfirm(false)}>No</button>
              <button className="nmapm-btn primary" onClick={confirmTransfer}>Sí, confirmar</button>
            </div>
          </div>
        </div>
      )}

        </div>
  );
}

export default Transfers;
