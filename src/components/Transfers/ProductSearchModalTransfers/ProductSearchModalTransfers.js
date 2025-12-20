import React, { useState, useEffect, useMemo, useCallback, useRef, useLayoutEffect } from 'react';
import '../../Cashier/ProductSearchModal/ProductSearchModal.css';
import { createSearcher } from '../../../utils/smartSearch';
import QtyButton from '../../UI/QtyButton';

function ProductSearchModalTransfers({
  isOpen,
  onClose,
  onAddProduct,
  allProducts,
  inventories,
  activeInventoryId,
  destInventoryId,
  onInventoryChange,
  appSettings,
  cart = []
}) {
  // Reuse almost all logic from the cashier modal but prefer cost field when present
  const [rawSearch, setRawSearch] = useState('');
  const [search, setSearch] = useState('');
  const [focusIndex, setFocusIndex] = useState(-1);
  const [modalNotice, setModalNotice] = useState(null);
  const [qtyDialog, setQtyDialog] = useState(null);
  const [qtyInputValue, setQtyInputValue] = useState('');

  const listRef = useRef(null);
  const backdropRef = useRef(null);
  const inputRef = useRef(null);
  const qtyInputRef = useRef(null);

  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [rowHeight, setRowHeight] = useState(74);

  useEffect(() => { const h = setTimeout(() => setSearch(rawSearch), 120); return () => clearTimeout(h); }, [rawSearch]);
  useEffect(() => { if (!isOpen) { setRawSearch(''); setSearch(''); setFocusIndex(-1); setScrollTop(0); } }, [isOpen]);
  useEffect(() => { if (isOpen) { const t = setTimeout(() => inputRef.current?.focus(), 40); return () => clearTimeout(t); } }, [isOpen]);
  useEffect(() => { if (!isOpen) return; const handler = (e) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler); }, [isOpen, onClose]);

  const activeInventory = useMemo(() => inventories.find(i => i.id === activeInventoryId), [inventories, activeInventoryId]);
  const inventoryProductMap = activeInventory?.products || null;
  const destInventory = useMemo(() => inventories.find(i => i.id === destInventoryId), [inventories, destInventoryId]);
  const destInventoryProductMap = destInventory?.products || null;

  const cartQtyMap = useMemo(() => {
    const m = Object.create(null);
    for (const item of cart) if (item?.docId) m[item.docId] = (m[item.docId] || 0) + (item.quantity || 0);
    return m;
  }, [cart]);

  // For transfers we also show stock info but behavior is identical for selecting quantity
  const productsWithStock = useMemo(() => {
    if (!allProducts?.length) return [];
    return allProducts.map(p => {
      const key = p.docId || p.id;
      const invStock = Number(inventoryProductMap?.[key]?.quantity) || 0;
      return { ...p, stock: invStock, originalStock: invStock };
    });
  }, [allProducts, inventoryProductMap]);

  const adjustUSD = useCallback((originalPriceUSD) => {
    const { dolarBCV, dolarParalelo } = appSettings || {};
    const price = Number(originalPriceUSD);
    const bcv = Number(dolarBCV);
    const paralelo = Number(dolarParalelo);
    if (!(price > 0) || !(bcv > 0) || !(paralelo > 0)) return price || 0;
    const bs = price * paralelo;
    return +(bs / bcv);
  }, [appSettings]);

  const searcher = useMemo(() => createSearcher(productsWithStock || [], { keys: ['name', 'id', 'docId'], nameKey: 'name', maxResults: 800, minScore: 8 }), [productsWithStock]);

  const filtered = useMemo(() => {
    if (!activeInventoryId) return [];
    if (!search.trim()) return productsWithStock;
    try {
      const results = searcher.search(search, { maxResults: 800, minScore: 6 });
      return results.map(r => r.item);
    } catch (e) {
      const q = search.toLowerCase();
      return productsWithStock.filter(p => p.name?.toLowerCase().includes(q) || String(p.id).includes(q));
    }
  }, [search, productsWithStock, activeInventoryId, searcher]);

  useEffect(() => { if (focusIndex >= filtered.length) setFocusIndex(filtered.length - 1); }, [filtered, focusIndex]);

  useLayoutEffect(() => {
    if (!isOpen) return;
    const el = listRef.current; if (!el) return;
    const compute = () => { setViewportHeight(el.clientHeight); const styles = window.getComputedStyle(document.documentElement); const cssVar = styles.getPropertyValue('--lps-row-height').trim(); const parsed = parseInt(cssVar, 10); if (parsed > 20 && parsed < 300) setRowHeight(parsed); };
    compute(); const ro = new ResizeObserver(compute); ro.observe(el); window.addEventListener('orientationchange', compute); window.addEventListener('resize', compute); return () => { ro.disconnect(); window.removeEventListener('orientationchange', compute); window.removeEventListener('resize', compute); };
  }, [isOpen]);

  useEffect(() => { if (!isOpen) return; const el = listRef.current; if (!el) return; let ticking = false; const onScroll = () => { if (!ticking) { requestAnimationFrame(() => { setScrollTop(el.scrollTop); ticking = false; }); ticking = true; } }; el.addEventListener('scroll', onScroll, { passive: true }); return () => el.removeEventListener('scroll', onScroll); }, [isOpen]);

  const total = filtered.length;
  const startIndex = Math.max(0, Math.floor(scrollTop / rowHeight) - 6);
  const endIndex = Math.min(total, Math.ceil((scrollTop + viewportHeight) / rowHeight) + 6);
  const visibleSlice = useMemo(() => { if (total === 0) return []; const slice = filtered.slice(startIndex, endIndex); return slice.map((product, i) => ({ product, index: startIndex + i })); }, [filtered, startIndex, endIndex, total]);
  const startOffset = startIndex * rowHeight;
  const endOffset = (total - endIndex) * rowHeight;

  const showModalNotice = useCallback((message, type = 'error', ms = 2600) => { setModalNotice({ message, type }); if (showModalNotice._t) clearTimeout(showModalNotice._t); showModalNotice._t = setTimeout(() => setModalNotice(null), ms); }, []);

  const confirmingRef = useRef(false);

  const confirmAddQuantity = useCallback(() => {
    if (confirmingRef.current) return; if (!qtyDialog) return; confirmingRef.current = true;
    const { product, quantity, max } = qtyDialog; const chosen = quantity; if (chosen <= 0) { showModalNotice('Cantidad inválida.', 'error', 1800); confirmingRef.current = false; return; }
    if (Number.isFinite(max) && chosen > max) { showModalNotice('La cantidad excede el stock disponible en el inventario de origen.', 'error', 2000); confirmingRef.current = false; return; }
    // For transfers we will accept the chosen amount but remote validation happens at confirm time
    const key = product.docId || product.id;
    onAddProduct({ ...product, docId: key, totalStock: product.originalStock }, chosen);
    if (chosen === 1) {
      showModalNotice(`Se añadió 1 unidad de "${product.name}".`, 'success', 2200);
    } else {
      showModalNotice(`Se añadieron ${chosen} unidades de "${product.name}".`, 'success', 2200);
    }
    setQtyDialog(null); setQtyInputValue(''); setRawSearch(''); setSearch(''); setFocusIndex(-1);
    requestAnimationFrame(() => { inputRef.current?.focus(); confirmingRef.current = false; });
  }, [qtyDialog, onAddProduct, showModalNotice]);

  const openQtyDialog = useCallback((p, destStock = 0) => { setQtyDialog({ product: p, quantity: 1, max: Number.isFinite(p.stock) ? p.stock : undefined, destStock: Number(destStock || 0) }); setQtyInputValue(''); }, [showModalNotice]);
  const closeQtyDialog = useCallback(() => { setQtyDialog(null); setQtyInputValue(''); requestAnimationFrame(() => inputRef.current?.focus()); }, []);
  const changeQuantity = useCallback((delta) => { setQtyDialog(d => { if (!d) return d; let base = Number(d.quantity || 0); let q = base + delta; if (q < 1) q = 1; // enforce max when provided
    if (Number.isFinite(d.max) && q > d.max) q = d.max; setQtyInputValue(String(q)); return { ...d, quantity: q }; }); }, []);
  const setQuantityFromInput = useCallback((raw) => { const cleaned = raw.replace(/[^\d]/g, ''); setQtyInputValue(cleaned); setQtyDialog(d => { if (!d) return d; if (cleaned === '') return { ...d, quantity: 1 }; let q = parseInt(cleaned, 10); if (isNaN(q)) q = 1; if (q < 1) q = 1; if (Number.isFinite(d.max) && q > d.max) q = d.max; return { ...d, quantity: q }; }); }, []);
  useEffect(() => { if (qtyDialog) { const t = setTimeout(() => { qtyInputRef.current?.focus(); }, 40); return () => clearTimeout(t); } }, [qtyDialog]);

  const attemptSelect = useCallback((p, destStock) => {
    const originStock = Number(p?.stock || 0);
    if (!p || originStock <= 0) {
      showModalNotice('No hay stock disponible en el inventario de origen.', 'error', 1800);
      return;
    }
    openQtyDialog(p, destStock);
  }, [openQtyDialog, showModalNotice]);
  const handleBackdrop = (e) => { if (e.target === backdropRef.current) onClose(); };

  if (!isOpen) return null;

  return (
    <div ref={backdropRef} className="lps-backdrop" role="dialog" aria-modal="true" aria-label="Buscar y añadir producto (Transferencias)" onMouseDown={handleBackdrop}>
  <div className="lps-modal lps-modal-buys">
        {modalNotice && (
          <div
            className={`app-toast ${modalNotice.type}`}
            data-icon={modalNotice.type === 'success' ? '✓' : modalNotice.type === 'error' ? '✕' : 'ℹ'}
            role="status"
            aria-live="polite"
          >{modalNotice.message}</div>
        )}
        {qtyDialog && (
          <div className="lps-qty-overlay" role="dialog" aria-modal="true" aria-label="Seleccionar cantidad">
            <div className="lps-qty-panel">
              <h3 className="lps-qty-title">{qtyDialog.product.name}</h3>
              <p className="lps-qty-stock">Stock disponible: <strong>{qtyDialog.max}</strong></p>
              <div className="lps-qty-control">
                <QtyButton variant="minus" onClick={() => changeQuantity(-1)} ariaLabel="Restar" disabled={qtyDialog.quantity <= 1} />
                <input ref={qtyInputRef} className="lps-qty-input" type="text" inputMode="numeric" placeholder="1" min="1" value={qtyInputValue} onChange={(e) => setQuantityFromInput(e.target.value)} />
                <QtyButton variant="plus" onClick={() => changeQuantity(1)} ariaLabel="Sumar" disabled={Number.isFinite(qtyDialog?.max) ? qtyDialog.quantity >= qtyDialog.max : false} />
              </div>

              {/* Estimated totals for transfers: cuánto sumas y cuánto costará */}
              <div className="lps-qty-estimate" style={{ marginTop: '0.6rem', color: 'var(--c-text-dim)', fontSize: '0.95rem' }}>
                {(() => {
                  const qty = Number(qtyDialog.quantity || 0);
                  const destBefore = Number(qtyDialog.destStock || 0);
                  const destAfter = destBefore + qty;
                  return (
                    <div>
                      <div>Se añadirán: <strong>{qty}</strong> unidad{qty === 1 ? '' : 'es'}</div>
                      <div>
                        Total en destino tras la transferencia: <strong style={{ marginLeft: '0.4rem' }}>{destAfter}</strong> unidad{destAfter === 1 ? '' : 'es'}
                      </div>
                      <div style={{ color: 'var(--c-text-dim)', fontSize: '0.9rem', marginTop: '0.25rem' }}>
                        ({destBefore} actuales + {qty} por transferir)
                      </div>
                    </div>
                  );
                })()}
              </div>

              <div className="lps-qty-actions">
                <button type="button" className="lps-btn secondary" onClick={closeQtyDialog}>Cancelar</button>
                <button type="button" className="lps-btn primary" onClick={confirmAddQuantity} disabled={qtyDialog.quantity < 1 || confirmingRef.current}>Añadir {qtyDialog.quantity === 1 && qtyInputValue === '' ? 1 : qtyDialog.quantity}</button>
              </div>
            </div>
          </div>
        )}

        <header className="lps-header">
          <h2 className="lps-title">Añadir Producto (Transferencias)</h2>
          <button type="button" className="lps-close" aria-label="Cerrar" onClick={onClose}>×</button>
        </header>

        <div className="lps-filters">
          <div className="lps-field">
            <label htmlFor="inv" className="lps-label">Inventario</label>
            <select id="inv" className="lps-select" value={activeInventoryId || ''} onChange={(e) => { onInventoryChange(e.target.value); setFocusIndex(-1); }}>
              {inventories.map(inv => (<option key={inv.id} value={inv.id}>{inv.name}</option>))}
            </select>
          </div>
          <div className="lps-field grow">
            <label htmlFor="search" className="lps-label">Buscar</label>
            <input id="search" ref={inputRef} className="lps-input" type="search" placeholder="Nombre o ID..." value={rawSearch} onChange={(e) => { setRawSearch(e.target.value); setFocusIndex(-1); }} autoComplete="off" />
          </div>
        </div>

        <div className="lps-list-wrapper">
          {!activeInventoryId && <p className="lps-hint">Selecciona un inventario.</p>}
          {activeInventoryId && filtered.length === 0 && <p className="lps-hint">No se encontraron productos.</p>}

          <div ref={listRef} className="lps-list lps-virt-scroll" role="listbox" aria-label="Resultados de productos">
            {startOffset > 0 && (<div style={{ height: startOffset }} aria-hidden="true" />)}
              {visibleSlice.map(({ product, index }) => {
              // for transfers show cost if present else price
              const baseVal = Number(product.cost ?? product.price ?? 0);
              const adjusted = adjustUSD(baseVal);
              const bcvRate = Number(appSettings?.dolarBCV) || 1;
              const adjustedBsValue = adjusted * bcvRate;
              const adjustedBsRaw = Math.max(0, Math.round(adjustedBsValue));
              const adjustedBsRounded10 = Math.ceil(adjustedBsRaw / 10) * 10;
              const adjustedBsLabel = `${adjustedBsRounded10.toLocaleString('es-VE')} Bs.`;
              const focused = index === focusIndex;
              const destStock = Number(destInventoryProductMap?.[product.docId || product.id]?.quantity) || 0;
              return (
                <ProductRow key={product.id} index={index} focused={focused} product={product} adjusted={adjusted} adjustedBsLabel={adjustedBsLabel} destStock={destStock} onSelect={() => attemptSelect(product, destStock)} />
              );
            })}
            {endOffset > 0 && (<div style={{ height: endOffset }} aria-hidden="true" />)}
          </div>
        </div>

        <footer className="lps-footer"><button className="lps-btn" type="button" onClick={onClose}>Cerrar</button></footer>
      </div>
    </div>
  );
}

const ProductRow = React.memo(function ProductRow({ product, adjusted, focused, adjustedBsLabel, onSelect, index, destStock }) {
  const handleKey = (e) => { if ((e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onSelect(); } };
  const origPrice = product.price !== undefined ? Number(product.price) : null;
  const baseVal = product.cost !== undefined ? Number(product.cost) : origPrice;
  const hasStock = Number(product.stock || 0) > 0;
  return (
    <div data-row-index={index} className={'lps-row' + (focused ? ' focused' : '') + (hasStock ? '' : ' no-stock')} role="option" aria-selected={focused} tabIndex={hasStock && focused ? 0 : -1} onClick={hasStock ? onSelect : undefined} onKeyDown={hasStock ? handleKey : undefined}>
      <div className="lps-thumb" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {(product.thumbnailWebp || product.thumbnail || product.image) ? (
          <img
            src={product.thumbnailWebp || product.thumbnail || product.image}
            alt={product.name}
            loading="lazy"
            style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 6 }}
            onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }}
          />
        ) : (
          <span className="lps-thumb-ph" aria-hidden="true" style={{ width: 56, height: 56, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6 }}>?</span>
        )}
      </div>
      <div className="lps-main">
        <div className="lps-line1">
          <span className="lps-name">{product.name}</span>
          <div style={{ textAlign: 'right' }}>
            <span className="lps-id" style={{ fontSize: '0.85rem', color: 'var(--c-text-dim)' }}>ID: {product.id}</span>
          </div>
        </div>
        <div className="lps-line2">
          <span style={{ color: hasStock ? 'var(--c-text-dim)' : 'var(--c-danger)', fontSize: '0.9rem' }}>Stock (origen): <strong style={{ color: 'var(--c-text)' }}>{product.stock}</strong></span>
          <span style={{ color: 'var(--c-text-dim)', fontSize: '0.9rem' }}>Stock (destino): <strong style={{ color: 'var(--c-text)' }}>{Number(destStock || 0)}</strong></span>
        </div>
      </div>
    </div>
  );
});

export default ProductSearchModalTransfers;
