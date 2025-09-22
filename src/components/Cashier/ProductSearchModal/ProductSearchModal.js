import React, { useState, useEffect, useMemo, useCallback, useRef, useLayoutEffect } from 'react';
import './ProductSearchModal.css';

/*
  Mejoras:
  - Input ya se limpia al añadir (estaba implementado).
  - Virtualización manual (windowing) para ~1800 productos.
    Renderiza solo los visibles + buffer => gran reducción de nodos y re-render.
  - Debounce ligero de búsqueda (120ms) para evitar recalcular mientras se escribe rápido.
*/

const DEBOUNCE_MS = 120;
const BUFFER_ROWS = 6; // filas extra arriba/abajo

function ProductSearchModal({ 
   isOpen,
   onClose,
   onAddProduct,
   allProducts,
   inventories,
   activeInventoryId,
   onInventoryChange,
   appSettings,
   cart, /* carrito de la pestaña activa */
   reservedMap = {} /* mapa de reservas por otras pestañas: { docId: qty } */
 }) {
  const [rawSearch, setRawSearch] = useState('');
  const [search, setSearch] = useState('');
  const [focusIndex, setFocusIndex] = useState(-1);
  const [modalNotice, setModalNotice] = useState(null); // {message,type}
  const [qtyDialog, setQtyDialog] = useState(null); // { product, quantity, max }
  const [qtyInputValue, setQtyInputValue] = useState(''); // NUEVO: valor crudo del input ('' = mostrar vacío, significa 1)

  // Virtualization state
  const listRef = useRef(null);
  const backdropRef = useRef(null);
  const inputRef = useRef(null);
  const qtyInputRef = useRef(null);

  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [rowHeight, setRowHeight] = useState(74); // fallback; se ajusta tras montar

  // Debounce búsqueda
  useEffect(() => {
    const h = setTimeout(() => setSearch(rawSearch), DEBOUNCE_MS);
    return () => clearTimeout(h);
  }, [rawSearch]);

  // Reset al cerrar
  useEffect(() => {
    if (!isOpen) {
      setRawSearch('');
      setSearch('');
      setFocusIndex(-1);
      setScrollTop(0);
    }
  }, [isOpen]);

  // Auto focus
  useEffect(() => {
    if (isOpen) {
      const t = setTimeout(() => inputRef.current?.focus(), 40);
      return () => clearTimeout(t);
    }
  }, [isOpen]);

  // Escape cierra
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  // Inventario activo
  const activeInventory = useMemo(
    () => inventories.find(i => i.id === activeInventoryId),
    [inventories, activeInventoryId]
  );
  const inventoryProductMap = activeInventory?.products || null;

  // Mapa rápido docId -> cantidad en carrito (para restar stock disponible)
  const cartQtyMap = useMemo(() => {
    const m = Object.create(null);
    if (Array.isArray(cart)) {
      for (const item of cart) {
        if (item?.docId) m[item.docId] = (m[item.docId] || 0) + (item.quantity || 0);
      }
    }
    return m;
  }, [cart]);

  // Productos + stock (restando lo ya en carrito y lo reservado en otras pestañas)
  const productsWithStock = useMemo(() => {
    if (!allProducts?.length) return [];
    return allProducts.map(p => {
      const key = p.docId || p.id;
      const invStock = Number(inventoryProductMap?.[key]?.quantity) || 0;
      const inCart = Number(cartQtyMap[key]) || 0;
      const reservedInOthers = Number(reservedMap[key]) || 0;
      const remaining = Math.max(0, invStock - inCart - reservedInOthers);
      return { 
        ...p, 
        stock: remaining,          // stock restante disponible para añadir
        originalStock: invStock    // stock original del inventario (constante para validaciones en Cashier)
      };
    });
  }, [allProducts, inventoryProductMap, cartQtyMap, reservedMap]);

  // Ajuste precio
  const adjustUSD = useCallback((originalPriceUSD) => {
    const { dolarBCV, dolarParalelo } = appSettings || {};
    const price = Number(originalPriceUSD);
    const bcv = Number(dolarBCV);
    const paralelo = Number(dolarParalelo);
    if (!(price > 0) || !(bcv > 0) || !(paralelo > 0)) return price || 0;
    const bs = price * paralelo;
    return +(bs / bcv);
  }, [appSettings]);

  // Filtro
  const filtered = useMemo(() => {
    if (!search.trim()) return productsWithStock;
    const q = search.toLowerCase();
    return productsWithStock.filter(p =>
      p.name?.toLowerCase().includes(q) || String(p.id).includes(q)
    );
  }, [search, productsWithStock]);

  // Ajuste focus si cambia longitud
  useEffect(() => {
    if (focusIndex >= filtered.length) setFocusIndex(filtered.length - 1);
  }, [filtered, focusIndex]);

  // Medición viewport y rowHeight (lee la variable CSS efectiva)
  useLayoutEffect(() => {
    if (!isOpen) return;
    const el = listRef.current;
    if (!el) return;

    const compute = () => {
      setViewportHeight(el.clientHeight);
      // Lee CSS var (--lps-row-height) si existe; fallback a 74
      const styles = window.getComputedStyle(document.documentElement);
      const cssVar = styles.getPropertyValue('--lps-row-height').trim();
      const parsed = parseInt(cssVar, 10);
      if (parsed > 20 && parsed < 300) setRowHeight(parsed);
    };
    compute();

    const ro = new ResizeObserver(compute);
    ro.observe(el);
    window.addEventListener('orientationchange', compute);
    window.addEventListener('resize', compute);

    return () => {
      ro.disconnect();
      window.removeEventListener('orientationchange', compute);
      window.removeEventListener('resize', compute);
    };
  }, [isOpen]);

  // Scroll handler (throttle simple via rAF)
  useEffect(() => {
    if (!isOpen) return;
    const el = listRef.current;
    if (!el) return;
    let ticking = false;
    const onScroll = () => {
      if (!ticking) {
        requestAnimationFrame(() => {
          setScrollTop(el.scrollTop);
          ticking = false;
        });
        ticking = true;
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [isOpen]);

  // Cálculo indices visibles
  const total = filtered.length;
  const startIndex = useMemo(
    () => Math.max(0, Math.floor(scrollTop / rowHeight) - BUFFER_ROWS),
    [scrollTop, rowHeight]
  );
  const endIndex = useMemo(
    () => Math.min(
      total,
      Math.ceil((scrollTop + viewportHeight) / rowHeight) + BUFFER_ROWS
    ),
    [scrollTop, viewportHeight, rowHeight, total]
  );

  // NUEVO: slice sin posiciones absolutas (spacers arriba/abajo)
  const visibleSlice = useMemo(() => {
    if (total === 0) return [];
    const slice = filtered.slice(startIndex, endIndex);
    return slice.map((product, i) => ({ product, index: startIndex + i }));
  }, [filtered, startIndex, endIndex, total]);

  const startOffset = startIndex * rowHeight;
  const endOffset = (total - endIndex) * rowHeight;

  // // Navegación teclado
  // const moveFocus = (dir) => {
  //   if (!filtered.length) return;
  //   setFocusIndex(prev => {
  //     let next = prev + dir;
  //     if (next < 0) next = filtered.length - 1;
  //     if (next >= filtered.length) next = 0;
  //     return next;
  //   });
  // };

  const showModalNotice = useCallback((message, type = 'error', ms = 2600) => {
    setModalNotice({ message, type });
    if (showModalNotice._t) clearTimeout(showModalNotice._t);
    showModalNotice._t = setTimeout(() => setModalNotice(null), ms);
  }, []);

  // Guard reentrante para confirmar
  const confirmingRef = useRef(false);

  // ==== CONFIRM (sin cambios de lógica principal, solo respeta qtyDialog.quantity que puede ser 1 cuando input '') ====
  const confirmAddQuantity = useCallback(() => {
    if (confirmingRef.current) return;
    if (!qtyDialog) return;
    confirmingRef.current = true;

    const { product, quantity } = qtyDialog;
    const chosen = quantity; // si input vacío -> 1; si 0 -> bloquea
    if (chosen <= 0) {
      showModalNotice('Cantidad inválida.', 'error', 1800);
      confirmingRef.current = false;
      return;
    }
    const toAdd = Math.min(chosen, product.stock);
    if (toAdd <= 0) {
      showModalNotice('Sin stock disponible.', 'error', 1800);
      confirmingRef.current = false;
      return;
    }

    const key = product.docId || product.id;
    onAddProduct(
      { ...product, docId: key, totalStock: product.originalStock },
      toAdd
    );

    showModalNotice(
      `Añadida${toAdd === 1 ? '' : 's'} ${toAdd} unidad${toAdd === 1 ? '' : 'es'} de "${product.name}".`,
      'success',
      2200
    );

    setQtyDialog(null);
    setQtyInputValue('');
    setRawSearch('');
    setSearch('');
    setFocusIndex(-1);

    requestAnimationFrame(() => {
      inputRef.current?.focus();
      confirmingRef.current = false;
    });
  }, [qtyDialog, onAddProduct, showModalNotice]);

  // === Funciones faltantes (añadidas) ===
  const openQtyDialog = useCallback((p) => {
    if (p.stock <= 0) {
      showModalNotice('No se puede añadir: sin stock disponible.', 'error');
      return;
    }
    setQtyDialog({ product: p, quantity: 1, max: p.stock });
    setQtyInputValue(''); // vacío -> representa 1 por defecto
  }, [showModalNotice]);

  const closeQtyDialog = useCallback(() => {
    setQtyDialog(null);
    setQtyInputValue('');
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const changeQuantity = useCallback((delta) => {
    setQtyDialog(d => {
      if (!d) return d;
      let base = d.quantity;            // d.quantity siempre mantiene el valor efectivo (1 si input vacío)
      let q = base + delta;
      if (q < 1) q = 1;
      if (q > d.max) q = d.max;
      setQtyInputValue(String(q));      // refleja el nuevo valor explícito
      return { ...d, quantity: q };
    });
  }, []);

  const setQuantityFromInput = useCallback((raw) => {
    // Permitimos solo dígitos
    const cleaned = raw.replace(/[^\d]/g, '');
    setQtyInputValue(cleaned);

    setQtyDialog(d => {
      if (!d) return d;
      if (cleaned === '') {
        // Input vacío -> mostrar vacío pero internamente mantenemos quantity = 1 (valor por defecto)
        return { ...d, quantity: 1 };
      }
      let q = parseInt(cleaned, 10);
      if (isNaN(q)) q = 1;
      if (q < 0) q = 0; // si escribe 0 -> queda 0 (botón añadir se deshabilita)
      if (q > d.max) q = d.max;
      // Si usuario escribió 0 mantenemos qty=0 (para bloquear añadir)
      return { ...d, quantity: q };
    });
  }, []);

  // Enfocar y seleccionar el "1" inicial para que el primer dígito lo reemplace
  useEffect(() => {
    if (qtyDialog) {
      const t = setTimeout(() => {
        qtyInputRef.current?.focus(); // sin .select()
      }, 40);
      return () => clearTimeout(t);
    }
  }, [qtyDialog]);

  // Reemplazar attemptSelect para abrir diálogo
  const attemptSelect = useCallback((p) => {
    openQtyDialog(p);
  }, [openQtyDialog]);

  const handleBackdrop = (e) => {
    if (e.target === backdropRef.current) onClose();
  };

  if (!isOpen) return null;

  return (
    <div
      ref={backdropRef}
      className="lps-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Buscar y añadir producto"
      onMouseDown={handleBackdrop}
    >
      <div className="lps-modal">
        {modalNotice && (
          <div
            className={`app-toast ${modalNotice.type}`}
            data-icon={modalNotice.type === 'success' ? '✓' : '✕'}
            role="status"
            aria-live="polite"
          >
            {modalNotice.message}
          </div>
        )}

        {/* Diálogo de cantidad */}
        {qtyDialog && (
          <div className="lps-qty-overlay" role="dialog" aria-modal="true" aria-label="Seleccionar cantidad">
            <div className="lps-qty-panel">
              <h3 className="lps-qty-title">{qtyDialog.product.name}</h3>
              <p className="lps-qty-stock">
                Stock disponible: <strong>{qtyDialog.max}</strong>
              </p>
              <div className="lps-qty-control">
                <button
                  type="button"
                  className="lps-qty-btn"
                  onClick={() => changeQuantity(-1)}
                  disabled={qtyDialog.quantity <= 1} /* si input vacío => quantity=1 */
                  aria-label="Disminuir cantidad"
                >−</button>
                <input
                  ref={qtyInputRef}
                  className="lps-qty-input"
                  type="text"
                  inputMode="numeric"
                  placeholder="1"              /* muestra 1 como placeholder */
                  min="1"
                  max={qtyDialog.max}
                  value={qtyInputValue}
                  onChange={(e) => setQuantityFromInput(e.target.value)}
                />
                <button
                  type="button"
                  className="lps-qty-btn"
                  onClick={() => changeQuantity(1)}
                  disabled={qtyDialog.quantity >= qtyDialog.max}
                  aria-label="Aumentar cantidad"
                >+</button>
              </div>
              <div className="lps-qty-actions">
                <button
                  type="button"
                  className="lps-btn secondary"
                  onClick={closeQtyDialog}
                >Cancelar</button>
                <button
                  type="button"
                  className="lps-btn primary"
                  onClick={confirmAddQuantity}
                  disabled={qtyDialog.quantity < 1 || confirmingRef.current}
                >
                  Añadir {qtyDialog.quantity === 1 && qtyInputValue === '' ? 1 : qtyDialog.quantity}
                </button>
              </div>
            </div>
          </div>
        )}

        <header className="lps-header">
          <h2 className="lps-title">Añadir Producto</h2>
          <button type="button" className="lps-close" aria-label="Cerrar" onClick={onClose}>×</button>
        </header>

        <div className="lps-filters">
          <div className="lps-field">
            <label htmlFor="inv" className="lps-label">Inventario</label>
            <select
              id="inv"
              className="lps-select"
              value={activeInventoryId || ''}
              onChange={(e) => {
                onInventoryChange(e.target.value);
                setFocusIndex(-1);
              }}
            >
              {inventories.map(inv => (
                <option key={inv.id} value={inv.id}>{inv.name}</option>
              ))}
            </select>
          </div>
          <div className="lps-field grow">
            <label htmlFor="search" className="lps-label">Buscar</label>
            <input
              id="search"
              ref={inputRef}
              className="lps-input"
              type="search"
              placeholder="Nombre o ID..."
              value={rawSearch}
              onChange={(e) => {
                setRawSearch(e.target.value);
                setFocusIndex(-1);
              }}
              autoComplete="off"
            />
          </div>
        </div>

        <div className="lps-list-wrapper">
          {!activeInventoryId && <p className="lps-hint">Selecciona un inventario.</p>}
          {activeInventoryId && filtered.length === 0 && <p className="lps-hint">No se encontraron productos.</p>}

          <div
            ref={listRef}
            className="lps-list lps-virt-scroll"
            role="listbox"
            aria-label="Resultados de productos"
          >
            {/* Spacer superior */}
            {startOffset > 0 && (
              <div style={{ height: startOffset }} aria-hidden="true" />
            )}

            {visibleSlice.map(({ product, index }) => {
              const adjusted = adjustUSD(product.price);
             const bcvRate = Number(appSettings?.dolarBCV) || 1;
             const adjustedBsValue = adjusted * bcvRate;
             // redondear hacia arriba al siguiente múltiplo de 10 para mostrar en Bs
             const adjustedBsRaw = Math.max(0, Math.round(adjustedBsValue));
             const adjustedBsRounded10 = Math.ceil(adjustedBsRaw / 10) * 10;
             const adjustedBsLabel = `${adjustedBsRounded10.toLocaleString('es-VE')} Bs.`;
              const focused = index === focusIndex;
              return (
                <ProductRow
                  key={product.id}
                  index={index}
                  focused={focused}
                  product={product}
                  adjusted={adjusted}
                  adjustedBsLabel={adjustedBsLabel}
                  onSelect={() => attemptSelect(product)}
                />
              );
            })}

            {/* Spacer inferior */}
            {endOffset > 0 && (
              <div style={{ height: endOffset }} aria-hidden="true" />
            )}
          </div>
        </div>

        <footer className="lps-footer">
          <button className="lps-btn" type="button" onClick={onClose}>Cerrar</button>
        </footer>
      </div>
    </div>
  );
}

const ProductRow = React.memo(function ProductRow({
  product,
  adjusted,
  focused,
  adjustedBsLabel,
  onSelect,
  index
}) {
  const out = product.stock === 0;
  const handleKey = (e) => {
    if ((e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      onSelect(); // ahora onSelect decide si permite o muestra aviso
    }
  };
  return (
    <div
      data-row-index={index}
      className={
        'lps-row' +
        (out ? ' out' : '') +
        (focused ? ' focused' : '')
      }
      role="option"
      aria-selected={focused}
      tabIndex={focused ? 0 : -1}
      aria-disabled={out || undefined}
      onClick={onSelect}           // permite click incluso sin stock (para mostrar aviso)
      onKeyDown={handleKey}
    >
      <div className="lps-thumb">
        {product.image ? (
          <img
            src={product.image}
            alt={product.name}
            loading="lazy"
            onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }}
          />
        ) : (
          <span className="lps-thumb-ph" aria-hidden="true">?</span>
        )}
      </div>
      <div className="lps-main">
        <div className="lps-line1">
          <span className="lps-name">{product.name}</span>
          <span className="lps-price">
            ${adjusted.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
        </div>
        <div className="lps-line2">
          <span className="lps-id">ID: {product.id}</span>
          <span className="lps-stock">Stock: {product.stock}</span>
          {/* equivalencia en Bs del precio ajustado */}
          <span className="lps-price-bs" aria-hidden="true" style={{ marginLeft: '0.6rem', color: 'var(--c-text-dim)', fontSize: '0.86rem' }}>
            {adjustedBsLabel}
          </span>
        </div>
      </div>
    </div>
  );
});

export default ProductSearchModal;