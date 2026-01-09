import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import './NewModalAddProductModal.css';
import ImageViewerModal from '../ImageViewerModal/ImageViewerModal';

function NewModalAddProductModal({
  isOpen,
  onClose,
  onAddProduct,
  onDeleteProduct,
  inventories = [],
  brands = [],
  loading = false,
  onCreateInventory,
  onCreateBrand,
  productToEdit = null,
  appSettings = {}
}) {
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [cost, setCost] = useState('');
  const [minQuantity, setMinQuantity] = useState('');
  const [marginPercent, setMarginPercent] = useState(100);
  const [brandId, setBrandId] = useState('');
  const [selectedInventory, setSelectedInventory] = useState('');
  const [inventoryQuantities, setInventoryQuantities] = useState([]);
  const [imagePreviews, setImagePreviews] = useState([]);
  const [uploadProgress, setUploadProgress] = useState({}); // { fileIndex: { variant: percent } }
  const [isUploading, setIsUploading] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [viewerSrc, setViewerSrc] = useState('');
  const fileRef = useRef(null);
  const modalRef = useRef(null);
  const [notification, setNotification] = useState({ message: '', type: '' });

  const showNotification = (message, type = 'error', duration = 4000) => {
    setNotification({ message, type });
    try { window.clearTimeout(showNotification._t); } catch (e) { }
    showNotification._t = window.setTimeout(() => setNotification({ message: '', type: '' }), duration);
  };

  const clearFileInputAndPreviews = () => {
    try {
      if (fileRef.current) {
        fileRef.current.value = '';
      }
    } catch (e) { }
    setImagePreviews(prev => {
      prev.forEach(p => p.url && URL.revokeObjectURL(p.url));
      return [];
    });
  };

  const initializedRef = useRef(false);
  const lastProductIdRef = useRef(null); // Track which product we last initialized

  // Initialize when opening / switching to edit
  useEffect(() => {
    if (!isOpen) {
      initializedRef.current = false;
      lastProductIdRef.current = null;
      return;
    }

    const currentProductId = productToEdit?.docId || null;
    const shouldInitialize = productToEdit && (
      !initializedRef.current ||
      lastProductIdRef.current !== currentProductId
    );

    if (shouldInitialize) {
      lastProductIdRef.current = currentProductId;
      initializedRef.current = true;
    }

    if (shouldInitialize) {
      // Inicializa solo una vez para edición, con datos de productToEdit
      setName(productToEdit.name || '');
      setPrice(productToEdit.price || '');
      setCost(productToEdit.cost || '');

      // calcular porcentaje a partir de price y cost si es posible
      try {
        const p = Number(productToEdit.price || 0);
        const c = Number(productToEdit.cost || 0);
        if (c > 0) setMarginPercent(+(((p / c) - 1) * 100).toFixed(2));
        else setMarginPercent(100);
      } catch (e) { setMarginPercent(100); }

      setMinQuantity(productToEdit.minQuantity || '');
      setBrandId(productToEdit.brandId || '');
      setInventoryQuantities(
        Array.isArray(productToEdit.inventories)
          ? productToEdit.inventories.map(i => ({ inventoryId: i.inventoryId, quantity: i.quantity }))
          : []
      );
      // Manejo de previews (igual que antes)
      const previews = [];
      try {
        const fullImage = productToEdit.image || null;
        if (productToEdit.thumbnails && Array.isArray(productToEdit.thumbnails) && productToEdit.thumbnails.length) {
          for (const t of productToEdit.thumbnails) previews.push({ name: 'existing-thumb', url: t, viewerUrl: fullImage || t, size: 0, existing: true });
        } else if (productToEdit.thumbnail) {
          previews.push({ name: 'existing-thumb', url: productToEdit.thumbnail, viewerUrl: fullImage || productToEdit.thumbnail, size: 0, existing: true });
        } else if (productToEdit.image) {
          previews.push({ name: 'existing-image', url: productToEdit.image, viewerUrl: productToEdit.image, size: 0, existing: true });
        }
      } catch (e) { /* ignore */ }
      setImagePreviews(previews);
      if (fileRef.current) fileRef.current.value = '';
      initializedRef.current = true; // Marca como inicializado
    } else if (!productToEdit) {
      setName('');
      setPrice('');
      setCost('');
      setMinQuantity('');
      setBrandId('');
      setInventoryQuantities([]);
      setImagePreviews([]);
      if (fileRef.current) fileRef.current.value = '';
      if (inventories.length > 0) setSelectedInventory(inventories[0].id);
    }
  }, [isOpen, productToEdit, inventories]);

  // basic cleanup for object URLs
  useEffect(() => () => {
    imagePreviews.forEach(p => p.url && URL.revokeObjectURL(p.url));
  }, [imagePreviews]);

  useEffect(() => {
    if (!isOpen) return;
    // focus first input
    const t = setTimeout(() => {
      modalRef.current?.querySelector('input,select,button')?.focus();
    }, 10);
    return () => clearTimeout(t);
  }, [isOpen]);

  const adjustUSD = useCallback((originalPriceUSD) => {
    const { dolarBCV, dolarParalelo } = appSettings || {};
    const price = Number(originalPriceUSD);
    const bcv = Number(dolarBCV);
    const paralelo = Number(dolarParalelo);
    if (!(price > 0) || !(bcv > 0) || !(paralelo > 0)) return 0;
    const bs = price * paralelo;
    return +(bs / bcv);
  }, [appSettings]);

  const adjustedPrices = useMemo(() => {
    if (!price) return null;
    const adjustedUSD = adjustUSD(Number(price)).toFixed(2);
    const adjustedUSDLabel = `${adjustedUSD.toLocaleString('es-VE')} $`;
    const bcvRate = Number(appSettings?.dolarBCV) || 1;
    const adjustedBsValue = adjustedUSD * bcvRate;
    const adjustedBsRaw = Math.max(0, adjustedBsValue || 0);
    const adjustedBsRounded10 = Math.ceil(adjustedBsRaw / 10) * 10;
    const adjustedBsLabel = `${adjustedBsRounded10.toLocaleString('es-VE')} Bs.`;
    return { adjustedUSDLabel, adjustedBsLabel };
  })

  const handleFiles = (e) => {
    const files = Array.from(e.target.files || []);
    const previews = files.map(f => ({ name: f.name, url: URL.createObjectURL(f), viewerUrl: URL.createObjectURL(f), size: f.size }));
    // revoke previous
    setImagePreviews(prev => {
      prev.forEach(p => p.url && URL.revokeObjectURL(p.url));
      return previews;
    });
  };

  const addInventoryRow = () => {
    const id = selectedInventory || inventories[0]?.id;
    if (!id) return;
    if (inventoryQuantities.some(i => i.inventoryId === id)) return;
    setInventoryQuantities(prev => [...prev, { inventoryId: id, quantity: 0 }]);
  };

  const handleQtyChange = (inventoryId, value) => {
    setInventoryQuantities(prev => prev.map(i => i.inventoryId === inventoryId ? { ...i, quantity: Number(value) } : i));
  };

  // Helpers para sincronizar costo / precio / porcentaje
  const recalcPercentFromPriceCost = (p, c) => {
    const priceN = Number(p || 0);
    const constN = Number(c || 0);
    if (constN > 0) return +(((priceN / constN) - 1) * 100).toFixed(2);
    return 100;
  };

  const handleCostChange = (value) => {
    setCost(value);
    try {
      const pct = recalcPercentFromPriceCost(price, value);
      setMarginPercent(pct);
    } catch (e) { }
  }

  const handlePriceChange = (value) => {
    setPrice(value);
    try {
      const pct = recalcPercentFromPriceCost(value, cost);
      setMarginPercent(pct);
    } catch (e) { }
  }

  const handleMarginChange = (value) => {
    const pct = Number(value || 0);
    setMarginPercent(pct);

    const costN = Number(cost || 0);
    if  (!Number.isFinite(costN) || costN <= 0) {
      return;
    }
    const newPrice = +(costN * (1 + pct / 100)).toFixed(2);
    setPrice(String(newPrice));
  }

  const handleClose = () => {
    initializedRef.current = false;
    onClose && onClose();
  };

  const removeInventory = (inventoryId) => setInventoryQuantities(prev => prev.filter(i => i.inventoryId !== inventoryId));

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  // Create-inventory modal state (uses a small overlay modal to avoid losing product edits)
  const [isNewInventoryOpen, setIsNewInventoryOpen] = useState(false);
  const [newInventoryName, setNewInventoryName] = useState('');
  const [isCreatingInventory, setIsCreatingInventory] = useState(false);
  // Create-brand modal state (small overlay similar to inventory)
  const [isNewBrandOpen, setIsNewBrandOpen] = useState(false);
  const [newBrandName, setNewBrandName] = useState('');
  const [isCreatingBrand, setIsCreatingBrand] = useState(false);

  const createBrand = async (name) => {
    const normalize = (s) => String(s || '').trim().replace(/\s+/g, ' ');
    const wanted = normalize(name);
    if (!wanted) { showNotification('El nombre no puede estar vacío', 'error'); return; }
    if (!onCreateBrand) { showNotification('Función de creación no disponible', 'error'); return; }
    try {
      setIsCreatingBrand(true);
      const created = await onCreateBrand(wanted);
      if (!created) { showNotification('No se creó la marca.', 'error'); setIsCreatingBrand(false); return; }
      let createdId = null;
      if (typeof created === 'string') createdId = created;
      else if (typeof created === 'object') createdId = created.id || null;
      // fallback: match by name
      if (!createdId) {
        const found = brands.find(b => (String(b.name || '').trim()) === wanted);
        if (found) createdId = found.id;
      }
      if (!createdId) { showNotification('Marca creada, pero no se pudo resolver su id. Revisa la consola.', 'error'); console.error('createBrand: no id', { created, brands }); setIsCreatingBrand(false); return; }
      setBrandId(createdId);
      setNewBrandName('');
      clearFileInputAndPreviews();
      setIsNewBrandOpen(false);
    } catch (err) {
      console.error('createBrand error', err);
      showNotification('No se pudo crear la marca', 'error');
    } finally {
      setIsCreatingBrand(false);
    }
  };

  // Use an explicit handler to create inventory (avoids nested form submission issues)
  const createInventory = async (name) => {
    const normalize = (s) => String(s || '').trim().replace(/\s+/g, ' ');
    const wanted = normalize(name);
    if (!wanted) { showNotification('El nombre no puede estar vacío', 'error'); return; }
    if (!onCreateInventory) { showNotification('Función de creación no disponible', 'error'); return; }
    try {
      setIsCreatingInventory(true);
      const created = await onCreateInventory(wanted);

      // created expected shape: { id, name, ... }
      let createdId = null;

      if (!created) { showNotification('No se creó el inventario.', 'error'); return; }

      if (typeof created === 'string') {
        // If the helper returned a string, try to resolve it as an id existing in inventories
        // but do NOT treat the string as the id if it equals the provided name (avoid using name as id)
        const normalizedCreated = normalize(created);
        if (normalizedCreated !== wanted) {
          // assume it's an id
          createdId = created;
        } else {
          // returned same name: attempt to find real doc by name in inventories
          const found = inventories.find(inv => normalize(inv.name) === wanted);
          if (found) createdId = found.id;
        }
      } else if (typeof created === 'object') {
        if (created.id) createdId = created.id;
        else if (created.name) {
          const found = inventories.find(inv => normalize(inv.name) === normalize(created.name));
          if (found) createdId = found.id;
        }
      }

      // As a last resort, try to find by the wanted name in current inventories
      if (!createdId) {
        const found2 = inventories.find(inv => normalize(inv.name) === wanted);
        if (found2) createdId = found2.id;
      }

      if (!createdId) {
        // If still no id, show error and log returned value for debugging
        console.error('createInventory: could not resolve created id', { created, inventories });
        showNotification('Inventario creado, pero no se pudo resolver su id. Revisa la consola.', 'error');
        setIsCreatingInventory(false);
        return;
      }

      if (!inventoryQuantities.some(iq => iq.inventoryId === createdId)) {
        setInventoryQuantities(prev => [...prev, { inventoryId: createdId, quantity: 0 }]);
      }
      setSelectedInventory(createdId);
      setNewInventoryName('');
      clearFileInputAndPreviews();
      setIsNewInventoryOpen(false);
    } catch (err) {
      console.error('createInventory error', err);
      showNotification('No se pudo crear el inventario', 'error');
    } finally {
      setIsCreatingInventory(false);
    }
  };

  const handleSubmit = async (e) => {
    e?.preventDefault?.();
    // collect selected files (if any)
    let files = [];
    try { files = Array.from(fileRef.current?.files || []); } catch (e) { files = []; }

    // progress callback to update local UI
    const progressCb = (p) => {
      // p: { fileIndex, variant, percent }
      setUploadProgress(prev => {
        const next = { ...prev };
        const idx = p.fileIndex || 0;
        next[idx] = { ...(next[idx] || {}), [p.variant]: Math.round(p.percent || 0) };
        return next;
      });
    };

    try {
      setIsUploading(true);
      await onAddProduct({
        docId: productToEdit?.docId || null,
        name, price, cost, minQuantity,
        brandId,
        inventories: inventoryQuantities.map(i => ({ inventoryId: i.inventoryId, quantity: Number(i.quantity) })),
        imageFiles: files
      }, progressCb);
      // show success toast local to the modal (visible above modal)
      try { showNotification('Producto guardado con éxito.', 'success', 5000); } catch (e) { }
    } catch (err) {
      console.error('onAddProduct failed in modal:', err);
      try { showNotification(err?.message || 'No se pudo guardar el producto.', 'error', 6000); } catch (e) { }
      // rethrow so parent (Inventory) can run its retry manager if applicable
      throw err;
    } finally {
      setIsUploading(false);
    }
  };

  if (!isOpen) return null;

  // render notification toast inside modal (keeps UI consistent with app toasts)
  const notifEl = notification.message ? (
    <div
      className={`app-toast app-toast-fixed ${notification.type}`}
      data-icon={notification.type === 'success' ? '✓' : notification.type === 'error' ? '✕' : 'ℹ'}
      role="status"
      aria-live="polite"
    >
      {notification.message}
    </div>
  ) : null;

  return (
    <div className="nmapm-backdrop" role="presentation" onClick={(e) => e.target === e.currentTarget && handleClose()}>
      {notifEl}
      <div className="nmapm-modal" role="dialog" aria-modal="true" ref={modalRef} onMouseDown={(e) => e.stopPropagation()}>
        <header className="nmapm-header">
          <h3 className="nmapm-title">{productToEdit ? 'Editar Producto' : 'Añadir Producto'}</h3>
          <button aria-label="Cerrar" className="nmapm-close" onClick={handleClose}>×</button>
        </header>

        <form className="nmapm-body" onSubmit={handleSubmit}>
          <div className="nmapm-row">
            <label className="nmapm-field">
              <span className="nmapm-label">Nombre</span>
              <input value={name} onChange={e => setName(e.target.value)} required />
            </label>

            <label className="nmapm-field">
              <span className="nmapm-label">Marca</span>
              <div className="nmapm-inline">
                <select value={brandId} onChange={e => setBrandId(e.target.value)}>
                  <option value="">Ninguna</option>
                  {brands.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
                <button type="button" className="nmapm-btn" onClick={() => setIsNewBrandOpen(true)}>Crear</button>
              </div>
            </label>
          </div>

          <div className="nmapm-row">
            <label className="nmapm-field">
              <span className="nmapm-label">Imagen</span>
              <div className="nmapm-upload">
                <input ref={fileRef} type="file" multiple accept="image/*" capture="environment" onChange={handleFiles} />
                <button type="button" className="nmapm-upload-btn" onClick={() => fileRef.current?.click()} aria-label={imagePreviews.length ? 'Editar imagen' : 'Subir imagen'}>{imagePreviews.length ? 'Editar' : 'Subir'}</button>
                <div className="nmapm-upload-hint">PNG/JPG • Máx 5MB</div>
                {/* {imagePreviews.length > 0 && (
                  <div className={`nmapm-previews ${imagePreviews.length === 1 ? 'center' : ''}`}>
                    {imagePreviews.map((p, i) => (
                      <div key={i} className="nmapm-thumb">
                        <img
                          src={p.url}
                          alt={p.name}
                          role="button"
                          tabIndex={0}
                          onClick={(e) => { e.preventDefault(); e.stopPropagation(); setViewerSrc(p.viewerUrl || p.url); setViewerOpen(true); }}
                          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); setViewerSrc(p.viewerUrl || p.url); setViewerOpen(true); } }}
                          style={{ cursor: 'zoom-in' }}
                        />
                        <div className="nmapm-progress">
                          {isUploading ? (
                            <div>
                              <div style={{ fontSize: '0.75rem' }}>{p.name}</div>
                              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                                <div style={{ width: 140, height: 8, background: '#eee', borderRadius: 6 }}>
                                  <div style={{ width: `${uploadProgress[i]?.full || 0}%`, height: '100%', background: '#2b8aef', borderRadius: 6 }} />
                                </div>
                                <div style={{ fontSize: '0.75rem', minWidth: 36 }}>{uploadProgress[i]?.full ?? 0}%</div>
                              </div>
                            </div>
                          ) : (
                            <div style={{ fontSize: '0.75rem', textAlign: 'center' }}>{p.name}</div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )} */}
                {/* Image viewer for previews */}
                <ImageViewerModal isOpen={viewerOpen} onClose={() => setViewerOpen(false)} src={viewerSrc} alt={name || 'Imagen'} />
                {/* Create Brand Modal (small overlay) */}
                {isNewBrandOpen && (
                  <div className="nmapm-create-modal" role="dialog" aria-modal="true" onClick={(e) => e.target === e.currentTarget && setIsNewBrandOpen(false)}>
                    <div className="nmapm-create-card" onMouseDown={(e) => e.stopPropagation()}>
                      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                        <h4 style={{ margin: 0 }}>Crear Nueva Marca</h4>
                        <button type="button" className="nmapm-close" aria-label="Cerrar" onClick={(e) => { e.stopPropagation(); e.preventDefault(); setIsNewBrandOpen(false); }}>×</button>
                      </header>
                      <div>
                        <label style={{ display: 'block', marginBottom: 8 }}>
                          Nombre de la Marca
                          <input
                            value={newBrandName}
                            onChange={e => setNewBrandName(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); createBrand(newBrandName); } }}
                            placeholder="Ej: Marca Nueva"
                            style={{ display: 'block', width: '100%', marginTop: 6, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--nmapm-input-border)', background: 'var(--nmapm-input-bg)', color: 'var(--nmapm-text)' }}
                          />
                        </label>
                        <div className="nmapm-create-actions" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
                          <button type="button" className="nmapm-btn" onClick={(e) => { e.stopPropagation(); e.preventDefault(); setIsNewBrandOpen(false); }} disabled={isCreatingBrand}>Cancelar</button>
                          <button type="button" className="nmapm-btn primary" onClick={(e) => { e.stopPropagation(); e.preventDefault(); createBrand(newBrandName); }} disabled={isCreatingBrand}>{isCreatingBrand ? 'Creando...' : 'Crear'}</button>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </label>

            <label className="nmapm-field">
              <span className="nmapm-label">Costo</span>
              <input type="number" step="0.01" value={cost} onChange={e => handleCostChange(e.target.value)} />

              <span className="nmapm-label">Precio</span>
              <input className='price-input' type="number" step="0.01" value={price} onChange={e => handlePriceChange(e.target.value)} />

                <br />
              <span className="nmapm-label">Porcentaje de ganancia (%)</span>
              <div className="nmapm-percent-wrapper" title="Porcentaje de ganancia">
               <input
                 className="price-input nmapm-input-percent"
                 type="number"
                 step="0.01"
                 value={marginPercent}
                 onChange={e => handleMarginChange(e.target.value)}
                 aria-label="Porcentaje de ganancia"
               />
               <span className="nmapm-percent-suffix"> %</span>
             </div>

              {/* aca ponemos el calculo del precio ajustado */}
              {(adjustedPrices && price > 0) && (
                <div className="nmapm-adjusted-price">
                  <i>Precio ajustado: <strong>{adjustedPrices.adjustedUSDLabel} / {adjustedPrices.adjustedBsLabel}</strong></i>
                </div>
              )}
            </label>
          </div>

          <div className="nmapm-row single">
            <label className="nmapm-field full">
              <span className="nmapm-label">Cantidad mínima (alertas)</span>
              <input type="number" value={minQuantity} onChange={e => setMinQuantity(e.target.value)} />
            </label>
          </div>

          <div className="nmapm-section">
            <span className="nmapm-label">Asignar a Inventarios</span>
            <div className="nmapm-row">
              <div className="nmapm-field">
                <div className="nmapm-inline">
                  <select value={selectedInventory || inventories[0]?.id || ''} onChange={e => setSelectedInventory(e.target.value)}>
                    {inventories.map(inv => <option key={inv.id} value={inv.id}>{inv.name}</option>)}
                  </select>
                  <button type="button" className="nmapm-btn" onClick={addInventoryRow}>Añadir</button>
                </div>
                <button type="button" className="nmapm-btn-ghost" onClick={() => setIsNewInventoryOpen(true)}>Crear Inventario</button>
              </div>
            </div>

            {inventoryQuantities.length > 0 && (
              <div className="nmapm-inventories">
                {inventoryQuantities.map(iq => {
                  const inv = inventories.find(x => x.id === iq.inventoryId) || {};
                  return (
                    <div key={iq.inventoryId} className="nmapm-inv-row">
                      <div className="nmapm-inv-name">{inv.name || iq.inventoryId}</div>
                      <div className="nmapm-inv-controls">
                        <input type="number" value={iq.quantity} onChange={e => handleQtyChange(iq.inventoryId, e.target.value)} />
                        <button type="button" className="nmapm-btn-ghost" onClick={() => removeInventory(iq.inventoryId)}>×</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <footer className="nmapm-footer">
            <div className="nmapm-actions">
              <button type="button" className="nmapm-btn" onClick={handleClose} disabled={loading}>Cancelar</button>
              {productToEdit && (
                <button type="button" className="nmapm-btn danger small" onClick={() => setShowDeleteConfirm(true)} disabled={loading}>Eliminar</button>
              )}
              <button type="submit" className="nmapm-btn primary big" disabled={loading || isUploading}>{loading || isUploading ? 'Guardando...' : (productToEdit ? 'Guardar' : 'Crear')}</button>
            </div>
          </footer>

          {showDeleteConfirm && (
            <div className="nmapm-confirm" role="dialog" aria-modal="true">
              <div className="nmapm-confirm-card">
                <div className="nmapm-confirm-text">¿Seguro que deseas eliminar este producto?</div>
                <div className="nmapm-confirm-actions">
                  <button className="nmapm-btn" onClick={() => setShowDeleteConfirm(false)} disabled={loading}>No</button>
                  <button className="nmapm-btn danger" onClick={async () => {
                    try {
                      setShowDeleteConfirm(false);
                      await onDeleteProduct && onDeleteProduct(productToEdit?.docId);
                    } catch (err) {
                      console.error(err);
                    }
                  }} disabled={loading}>Sí, eliminar</button>
                </div>
              </div>
            </div>
          )}

          {/* Create Inventory Modal (small overlay) */}
          {isNewInventoryOpen && (
            <div className="nmapm-create-modal" role="dialog" aria-modal="true" onClick={(e) => e.target === e.currentTarget && setIsNewInventoryOpen(false)}>
              <div className="nmapm-create-card" onMouseDown={(e) => e.stopPropagation()}>
                <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                  <h4 style={{ margin: 0 }}>Crear Nuevo Inventario</h4>
                  <button type="button" className="nmapm-close" aria-label="Cerrar" onClick={(e) => { e.stopPropagation(); e.preventDefault(); setIsNewInventoryOpen(false); }}>×</button>
                </header>
                <div>
                  <label style={{ display: 'block', marginBottom: 8 }}>
                    Nombre del Inventario
                    <input
                      value={newInventoryName}
                      onChange={e => setNewInventoryName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); createInventory(newInventoryName); } }}
                      placeholder="Ej: Bodega Principal"
                      style={{ display: 'block', width: '100%', marginTop: 6, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--nmapm-input-border)', background: 'var(--nmapm-input-bg)', color: 'var(--nmapm-text)' }}
                    />
                  </label>
                  <div className="nmapm-create-actions" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
                    <button type="button" className="nmapm-btn" onClick={(e) => { e.stopPropagation(); e.preventDefault(); setIsNewInventoryOpen(false); }} disabled={isCreatingInventory}>Cancelar</button>
                    <button type="button" className="nmapm-btn primary" onClick={(e) => { e.stopPropagation(); e.preventDefault(); createInventory(newInventoryName); }} disabled={isCreatingInventory}>{isCreatingInventory ? 'Creando...' : 'Crear'}</button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </form>
      </div>
    </div>
  );
}

export default NewModalAddProductModal;
