import React, { useEffect, useRef, useState } from 'react';
import './NewModalAddProductModal.css';

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
  productToEdit = null
}) {
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [cost, setCost] = useState('');
  const [minQuantity, setMinQuantity] = useState('');
  const [brandId, setBrandId] = useState('');
  const [selectedInventory, setSelectedInventory] = useState('');
  const [inventoryQuantities, setInventoryQuantities] = useState([]);
  const [imagePreviews, setImagePreviews] = useState([]);
  const fileRef = useRef(null);
  const modalRef = useRef(null);

  // Initialize when opening / switching to edit
  useEffect(() => {
    if (!isOpen) return;
    if (productToEdit) {
      setName(productToEdit.name || '');
      setPrice(productToEdit.price || '');
      setCost(productToEdit.cost || '');
      setMinQuantity(productToEdit.minQuantity || '');
      setBrandId(productToEdit.brandId || '');
      setInventoryQuantities(Array.isArray(productToEdit.inventories) ? productToEdit.inventories.map(i => ({ inventoryId: i.inventoryId, quantity: i.quantity })) : []);
      setImagePreviews([]);
      if (fileRef.current) fileRef.current.value = '';
    } else {
      setName(''); setPrice(''); setCost(''); setMinQuantity(''); setBrandId('');
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

  const handleFiles = (e) => {
    const files = Array.from(e.target.files || []);
    const previews = files.map(f => ({ name: f.name, url: URL.createObjectURL(f), size: f.size }));
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

  const removeInventory = (inventoryId) => setInventoryQuantities(prev => prev.filter(i => i.inventoryId !== inventoryId));

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  // Create-inventory modal state (uses a small overlay modal to avoid losing product edits)
  const [isNewInventoryOpen, setIsNewInventoryOpen] = useState(false);
  const [newInventoryName, setNewInventoryName] = useState('');
  const [isCreatingInventory, setIsCreatingInventory] = useState(false);

  // Use an explicit handler to create inventory (avoids nested form submission issues)
  const createInventory = async (name) => {
    const normalize = (s) => String(s || '').trim().replace(/\s+/g, ' ');
    const wanted = normalize(name);
    if (!wanted) return alert('El nombre no puede estar vacío');
    if (!onCreateInventory) return alert('Función de creación no disponible');
    try {
      setIsCreatingInventory(true);
      const created = await onCreateInventory(wanted);

      // created expected shape: { id, name, ... }
      let createdId = null;

      if (!created) {
        alert('No se creó el inventario.');
        return;
      }

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
        alert('Inventario creado, pero no se pudo resolver su id. Revisa la consola.');
        setIsCreatingInventory(false);
        return;
      }

      if (!inventoryQuantities.some(iq => iq.inventoryId === createdId)) {
        setInventoryQuantities(prev => [...prev, { inventoryId: createdId, quantity: 0 }]);
      }
      setSelectedInventory(createdId);
      setNewInventoryName('');
      setIsNewInventoryOpen(false);
    } catch (err) {
      console.error('createInventory error', err);
      alert('No se pudo crear el inventario');
    } finally {
      setIsCreatingInventory(false);
    }
  };

  const handleSubmit = async (e) => {
    e?.preventDefault?.();
    await onAddProduct({
      docId: productToEdit?.docId || null,
      name, price, cost, minQuantity,
      brandId,
      inventories: inventoryQuantities.map(i => ({ inventoryId: i.inventoryId, quantity: Number(i.quantity) }))
    });
  };

  if (!isOpen) return null;

  return (
    <div className="nmapm-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose && onClose()}>
      <div className="nmapm-modal" role="dialog" aria-modal="true" ref={modalRef} onMouseDown={(e) => e.stopPropagation()}>
        <header className="nmapm-header">
          <h3 className="nmapm-title">{productToEdit ? 'Editar Producto' : 'Añadir Producto'}</h3>
          <button aria-label="Cerrar" className="nmapm-close" onClick={onClose}>×</button>
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
                <button type="button" className="nmapm-btn" onClick={() => onCreateBrand && onCreateBrand('')}>Crear</button>
              </div>
            </label>
          </div>

          <div className="nmapm-row">
            <label className="nmapm-field">
              <span className="nmapm-label">Imágenes</span>
              <div className="nmapm-upload">
                <input ref={fileRef} type="file" multiple accept="image/*" onChange={handleFiles} />
                <button type="button" className="nmapm-upload-btn" onClick={() => fileRef.current?.click()}>Seleccionar</button>
                <div className="nmapm-upload-hint">PNG/JPG • Máx 5MB</div>
                {imagePreviews.length > 0 && (
                  <div className="nmapm-previews">
                    {imagePreviews.map((p, i) => (
                      <div key={i} className="nmapm-thumb"><img src={p.url} alt={p.name} /></div>
                    ))}
                  </div>
                )}
              </div>
            </label>

            <label className="nmapm-field">
              <span className="nmapm-label">Costo</span>
              <input type="number" step="0.01" value={cost} onChange={e => setCost(e.target.value)} />
              <span className="nmapm-label">Precio</span>
              <input type="number" step="0.01" value={price} onChange={e => setPrice(e.target.value)} />
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
              <button type="button" className="nmapm-btn" onClick={onClose} disabled={loading}>Cancelar</button>
              {productToEdit && (
                <button type="button" className="nmapm-btn danger small" onClick={() => setShowDeleteConfirm(true)} disabled={loading}>Eliminar</button>
              )}
              <button type="submit" className="nmapm-btn primary big" disabled={loading}>{loading ? 'Guardando...' : (productToEdit ? 'Guardar' : 'Crear')}</button>
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
              <div className="nmapm-create-modal" role="dialog" aria-modal="true" onMouseDown={(e) => e.target === e.currentTarget && setIsNewInventoryOpen(false)}>
                <div className="nmapm-create-card" onMouseDown={(e) => e.stopPropagation()}>
                  <header style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:12 }}>
                    <h4 style={{ margin:0 }}>Crear Nuevo Inventario</h4>
                    <button type="button" className="nmapm-close" aria-label="Cerrar" onClick={() => setIsNewInventoryOpen(false)}>×</button>
                  </header>
                  <div>
                    <label style={{ display:'block', marginBottom:8 }}>
                      Nombre del Inventario
                      <input
                        value={newInventoryName}
                        onChange={e => setNewInventoryName(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); createInventory(newInventoryName); } }}
                        placeholder="Ej: Bodega Principal"
                        style={{ display:'block', width:'100%', marginTop:6, padding:'8px 10px', borderRadius:8, border:'1px solid var(--nmapm-input-border)', background:'var(--nmapm-input-bg)', color:'var(--nmapm-text)' }}
                      />
                    </label>
                    <div className="nmapm-create-actions" style={{ display:'flex', gap:8, justifyContent:'flex-end', marginTop:12 }}>
                      <button type="button" className="nmapm-btn" onClick={() => setIsNewInventoryOpen(false)} disabled={isCreatingInventory}>Cancelar</button>
                      <button type="button" className="nmapm-btn primary" onClick={() => createInventory(newInventoryName)} disabled={isCreatingInventory}>{isCreatingInventory ? 'Creando...' : 'Crear'}</button>
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
