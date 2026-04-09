import React, { useState, useEffect, useRef } from 'react';
import './AddProductModal.css';

function AddProductModal({ isOpen, onClose, onAddProduct, onDeleteProduct, inventories, brands, loading, onCreateInventory, onCreateBrand, productToEdit }) {
  // --- 1. TODOS LOS HOOKS VAN AQUÍ, AL INICIO ---
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [cost, setCost] = useState('');
  const [minQuantity, setMinQuantity] = useState('');
  const [brandId, setBrandId] = useState('');
  const [inventoryQuantities, setInventoryQuantities] = useState([]);
  const [selectedInventory, setSelectedInventory] = useState('');
  const [isNewInventoryModalOpen, setIsNewInventoryModalOpen] = useState(false);
  const [newInventoryName, setNewInventoryName] = useState('');

  // --- NUEVO: Estados para el modal de crear marca ---
  const [isNewBrandModalOpen, setIsNewBrandModalOpen] = useState(false);
  const [newBrandName, setNewBrandName] = useState('');
  // --- NUEVO: estados para feedback de creación ---
  const [isCreatingBrand, setIsCreatingBrand] = useState(false);
  const [isCreatingInventory, setIsCreatingInventory] = useState(false);
  // --- FIN NUEVO ---

  // Helper de normalización a Title Case (Max Glow)
  const normalizeName = (s) => {
    if (!s && s !== '') return '';
    return String(s || '').trim().replace(/\s+/g, ' ').split(' ').map(w => w ? (w[0].toUpperCase() + w.slice(1).toLowerCase()) : '').join(' ');
  };

  const [imagePreviews, setImagePreviews] = useState([]); // previews de imágenes
  const fileInputRef = useRef(null); // <-- NUEVO: ref al input file
  const [uploadProgress, setUploadProgress] = useState({});
  const [isUploading, setIsUploading] = useState(false);
  const [notification, setNotification] = useState({ message: '', type: '' });

  const showNotification = (message, type = 'error', duration = 4000) => {
    setNotification({ message, type });
    try { window.clearTimeout(showNotification._t); } catch (e) {}
    showNotification._t = window.setTimeout(() => setNotification({ message: '', type: '' }), duration);
  };

  const isEditMode = !!productToEdit;

  // Limpieza de object URLs al cambiar selección o desmontar
  useEffect(() => {
    const urls = imagePreviews.map(p => p.url);
    return () => {
      urls.forEach(url => URL.revokeObjectURL(url));
    };
  }, [imagePreviews]);

  // Inicializa/limpia al abrir/cerrar
  useEffect(() => {
    if (isOpen) {
      if (isEditMode) {
        setName(productToEdit.name);
        setPrice(productToEdit.price);
        setCost(productToEdit.cost);
        setMinQuantity(productToEdit.minQuantity);
        setBrandId(productToEdit.brandId || '');
        setInventoryQuantities(productToEdit.inventories || []);
        // Limpia imágenes al entrar a edición (UI-only)
        setImagePreviews([]);
        if (fileInputRef.current) fileInputRef.current.value = '';
      } else {
        // Creación
        setName('');
        setPrice('');
        setCost('');
        setMinQuantity('');
        setBrandId('');
        setInventoryQuantities([]);
        setSelectedInventory('');
        setImagePreviews([]);
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    } else {
      // Al cerrar: asegura limpieza del file input y previews
      setImagePreviews([]);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, [isOpen, isEditMode, productToEdit]);

  // Efecto para PRESELECCIONAR valores solo cuando las listas cargan por primera vez en modo creación
  useEffect(() => {
    // Solo se ejecuta en modo creación, cuando el modal está abierto
    if (isOpen && !isEditMode) {
      // Preseleccionar el primer inventario si hay inventarios y ninguno está seleccionado
      if (inventories.length > 0 && selectedInventory === '') {
        setSelectedInventory(inventories[0].id);
      }
    }
    // Este efecto depende de que las listas de 'brands' e 'inventories' cambien.
    // No depende de 'brandId' o 'selectedInventory' para evitar el bucle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, isEditMode, brands, inventories]);


  // --- 2. HANDLERS Y LÓGICA VAN DESPUÉS DE LOS HOOKS ---
  const handleCreateNewBrand = async (e) => {
    e.preventDefault();
    if (!newBrandName.trim()) { showNotification('El nombre de la marca no puede estar vacío.', 'error'); return; }
    // Evita crear duplicados: revisar lista local primero
    const nameTrim = normalizeName(newBrandName);
    const foundLocal = (brands || []).find(b => normalizeName(b.name || '') === nameTrim);
    if (foundLocal) {
      setBrandId(foundLocal.id);
      setIsNewBrandModalOpen(false);
      setNewBrandName('');
      showNotification(`La marca ya existe. Se ha seleccionado la marca existente: ${foundLocal.name || nameTrim}`, 'info');
      return;
    }

    try {
      setIsCreatingBrand(true);
      // request creation with normalized name
      const newBrand = await onCreateBrand(nameTrim);
      if (newBrand) {
        setBrandId(newBrand.id); // Seleccionar la nueva marca creada
        setIsNewBrandModalOpen(false);
        setNewBrandName('');
      }
    } finally {
      setIsCreatingBrand(false);
    }
  };

  const handleCreateNewInventory = async (e) => {
    e.preventDefault();
    if (!newInventoryName.trim()) { showNotification('El nombre del inventario no puede estar vacío.', 'error'); return; }
    // Evita duplicados locales por nombre
    const nameTrim = normalizeName(newInventoryName);
    const foundLocal = (inventories || []).find(i => normalizeName(i.name || '') === nameTrim);
    if (foundLocal) {
      // Añade el inventario encontrado si no está en la lista de cantidades
      if (!inventoryQuantities.some(iq => iq.inventoryId === foundLocal.id)) {
        setInventoryQuantities([...inventoryQuantities, { inventoryId: foundLocal.id, quantity: '' }]);
      }
      setSelectedInventory(foundLocal.id);
      setIsNewInventoryModalOpen(false);
      setNewInventoryName('');
      showNotification(`El inventario ya existe. Se ha seleccionado: ${foundLocal.name || nameTrim}`, 'info');
      return;
    }

    try {
      setIsCreatingInventory(true);
      const newInventory = await onCreateInventory(nameTrim);
      if (newInventory) {
        // Añade el nuevo inventario directamente a la lista para asignarle una cantidad
        if (!inventoryQuantities.some(iq => iq.inventoryId === newInventory.id)) {
          setInventoryQuantities([...inventoryQuantities, { inventoryId: newInventory.id, quantity: '' }]);
        }
        setSelectedInventory(newInventory.id); // Selecciónalo en el dropdown también
        setIsNewInventoryModalOpen(false);
        setNewInventoryName('');
      }
    } finally {
      setIsCreatingInventory(false);
    }
  };

  // Normalizador entero no negativo
  const toInt = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
  };

  // INICIALIZACIÓN: este hook debe ir ANTES de cualquier return condicional
  useEffect(() => {
    // Si el modal no está abierto, no hacer nada (pero el hook igual se invoca)
    if (!isOpen) return;

    // Base: todas las filas de inventario con 0
    const baseRows = (inventories || []).map(inv => ({ inventoryId: inv.id, quantity: 0 }));

    // Si hay edición, mezclar cantidades exactas
    const fromEdit = Array.isArray(productToEdit?.inventories) ? productToEdit.inventories : [];
    if (fromEdit.length) {
      const map = new Map(fromEdit.map(i => [i.inventoryId, toInt(i.quantity)]));
      setInventoryQuantities(baseRows.map(row => ({ ...row, quantity: map.get(row.inventoryId) ?? 0 })));
    } else {
      setInventoryQuantities(baseRows);
    }
  }, [isOpen, productToEdit, inventories]);

  // // Cambios de cantidad: guarda EXACTO lo que escribe el usuario
  // const handleInventoryQtyChange = (inventoryId, value) => {
  //   const q = toInt(value);
  //   setInventoryQuantities(prev =>
  //     prev.map(i => i.inventoryId === inventoryId ? { ...i, quantity: q } : i)
  //   );
  // };

  // Al confirmar: envía cantidades exactas (sin restar 1, sin diferenciales)
  const handleSubmit = async (e) => {
    e?.preventDefault?.();
    // collect files
    let files = [];
    try { files = Array.from(fileInputRef.current?.files || []); } catch (e) { files = []; }

    const progressCb = (p) => {
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
        name,
        price,
        cost,
        minQuantity,
        brandId,
        inventories: inventoryQuantities.map(i => ({ inventoryId: i.inventoryId, quantity: toInt(i.quantity) })),
        imageFiles: files
      }, progressCb);
    } finally {
      setIsUploading(false);
    }
  };

  const handleAddInventoryToList = () => {
    const invId = selectedInventory || inventories[0]?.id || '';
    if (!invId || inventoryQuantities.some(iq => iq.inventoryId === invId)) {
      return;
    }
    setInventoryQuantities([...inventoryQuantities, { inventoryId: invId, quantity: '' }]);
    // asegura que el select refleje el valor efectivo
    if (!selectedInventory) setSelectedInventory(invId);
  };

  const handleQuantityChange = (inventoryId, newQuantity) => {
    const updatedQuantities = inventoryQuantities.map(iq =>
      iq.inventoryId === inventoryId ? { ...iq, quantity: newQuantity } : iq
    );
    setInventoryQuantities(updatedQuantities);
  };

  // FIX: faltaba esta función usada en el botón &times;
  const handleRemoveInventory = (inventoryId) => {
    setInventoryQuantities(prev => prev.filter(iq => iq.inventoryId !== inventoryId));
    // Si el inventario eliminado era el seleccionado en el picker, reajusta selección
    setSelectedInventory(prev => prev === inventoryId ? (inventories[0]?.id || '') : prev);
  };

  const handleDeleteClick = async () => {
    if (!productToEdit?.docId) return;
    if (!window.confirm('¿Eliminar este producto? Esta acción no se puede deshacer.')) return;
    await onDeleteProduct(productToEdit.docId);
  };

  // --- NUEVO: Renderizado del modal para crear marca ---
  if (isNewBrandModalOpen) {
    return (
      <dialog open>
        <article>
          <header>
            <button type="button" aria-label="Close" className="close" onClick={() => setIsNewBrandModalOpen(false)}></button>
            <h3>Crear Nueva Marca</h3>
          </header>
          <form onSubmit={handleCreateNewBrand}>
            <label htmlFor="new-brand-name">
              Nombre de la Marca
              <input
                type="text"
                id="new-brand-name"
                value={newBrandName}
                onChange={(e) => setNewBrandName(e.target.value)}
                required
                placeholder="Ej: Max Glow"
              />
            </label>
            <footer>
              <button type="button" className="secondary" onClick={() => setIsNewBrandModalOpen(false)} disabled={isCreatingBrand}>Cancelar</button>
              <button type="submit" disabled={isCreatingBrand || loading}>{isCreatingBrand ? 'Creando...' : (loading ? 'Creando...' : 'Crear')}</button>
            </footer>
          </form>
        </article>
      </dialog>
    );
  }
  // --- FIN NUEVO ---

 // --- RENDERIZADO DEL SEGUNDO MODAL (corregido) ---
  if (isNewInventoryModalOpen) {
    return (
      <dialog open>
        <article>
          <header>
            <button type="button" aria-label="Close" className="close" onClick={() => setIsNewInventoryModalOpen(false)}></button>
            <h3>Crear Nuevo Inventario</h3>
          </header>
          <form onSubmit={handleCreateNewInventory}>
            <label htmlFor="new-inventory-name">
              Nombre del Inventario
              <input
                type="text"
                id="new-inventory-name"
                value={newInventoryName}
                onChange={(e) => setNewInventoryName(e.target.value)}
                required
                placeholder="Ej: Bodega Principal"
              />
            </label>
            <footer>
              <button type="button" className="secondary" onClick={() => setIsNewInventoryModalOpen(false)} disabled={isCreatingInventory}>Cancelar</button>
              <button type="submit" disabled={isCreatingInventory || loading}>{isCreatingInventory ? 'Creando...' : (loading ? 'Creando...' : 'Crear')}</button>
            </footer>
          </form>
        </article>
      </dialog>
    );
  }

  // [ELIMINADO] useEffect de limpieza aquí provocaba el error de hooks
  // useEffect(() => {
  //   return () => {
  //     imagePreviews.forEach(p => URL.revokeObjectURL(p.url));
  //   };
  // }, [imagePreviews]);

  const handleImagesSelected = (e) => {
    const files = Array.from(e.target.files || []);
    // No revocamos aquí; el efecto de arriba limpia las URLs anteriores
    const previews = files.map(file => ({
      url: URL.createObjectURL(file),
      name: file.name,
      size: file.size
    }));
    setImagePreviews(previews);
  };

  // --- 3. EL RETURN TEMPRANO VA AL FINAL, JUSTO ANTES DEL JSX ---
  if (!isOpen) return null;

  const handleBackdropClick = (e) => {
    if (e.target === e.currentTarget) onClose && onClose();
  };

  // --- 4. EL JSX FINAL ---
  return (
    <div className="apm-backdrop" role="presentation" onMouseDown={handleBackdropClick}>
      <div className="apm-modal" role="dialog" aria-modal="true" aria-label={isEditMode ? 'Editar producto' : 'Añadir producto'} onMouseDown={(e) => e.stopPropagation()}>
        <header className="apm-header">
          <h3 className="apm-title">{isEditMode ? 'Editar Producto' : 'Añadir Nuevo Producto'}</h3>
          <button type="button" className="apm-close" aria-label="Cerrar" onClick={onClose}>&times;</button>
        </header>

        <div className="apm-body">
          {/* If creating brand or inventory, render a compact sub-form here */}
          {isNewBrandModalOpen ? (
            <form onSubmit={handleCreateNewBrand} className="apm-subform">
              <label htmlFor="new-brand-name">Nombre de la Marca</label>
              <input id="new-brand-name" type="text" value={newBrandName} onChange={(e) => setNewBrandName(e.target.value)} placeholder="Ej: Max Glow" required />
              <div className="apm-actions">
                <button type="button" className="btn secondary" onClick={() => setIsNewBrandModalOpen(false)} disabled={isCreatingBrand}>Cancelar</button>
                <button type="submit" className="btn primary" disabled={isCreatingBrand || loading}>{isCreatingBrand ? 'Creando...' : 'Crear'}</button>
              </div>
            </form>
          ) : isNewInventoryModalOpen ? (
            <form onSubmit={handleCreateNewInventory} className="apm-subform">
              <label htmlFor="new-inventory-name">Nombre del Inventario</label>
              <input id="new-inventory-name" type="text" value={newInventoryName} onChange={(e) => setNewInventoryName(e.target.value)} placeholder="Ej: Bodega Principal" required />
              <div className="apm-actions">
                <button type="button" className="btn secondary" onClick={() => setIsNewInventoryModalOpen(false)} disabled={isCreatingInventory}>Cancelar</button>
                <button type="submit" className="btn primary" disabled={isCreatingInventory || loading}>{isCreatingInventory ? 'Creando...' : 'Crear'}</button>
              </div>
            </form>
          ) : (
            <form onSubmit={handleSubmit} className="apm-form vertical">
              <div className="apm-section">
                <div className="apm-row">
                  <div className="field">
                    <label htmlFor="name">Nombre del Producto</label>
                    <input type="text" id="name" value={name} onChange={(e) => setName(e.target.value)} required />
                  </div>

                  <div className="field">
                    <label>Marca</label>
                    <div className="inline">
                      <select id="brand-picker" value={brandId} onChange={(e) => setBrandId(e.target.value)}>
                        <option value="">Ninguna</option>
                        {brands && brands.map(brand => <option key={brand.id} value={brand.id}>{brand.name}</option>)}
                      </select>
                      <button type="button" className="btn primary" onClick={() => setIsNewBrandModalOpen(true)}>Crear Marca</button>
                    </div>
                  </div>
                </div>
              </div>

              <div className="apm-section">
                <div className="apm-row">
                  <div className="field">
                    <label>Imagen</label>
                    <div className="file-upload">
                      <input id="product-images" ref={fileInputRef} type="file" accept="image/*" capture="environment" multiple onChange={handleImagesSelected} />
                      <label className="upload-btn" htmlFor="product-images" aria-label={imagePreviews.length ? 'Editar imagen' : 'Subir imagen'}>{imagePreviews.length ? 'Editar' : 'Subir'}</label>
                      <span className="upload-hint">PNG, JPG. Máx. 5MB c/u</span>
                      {imagePreviews.length > 0 && (
                        <div className="image-previews">
                          {imagePreviews.map((p, idx) => (
                            <figure className="thumb" key={idx}>
                              <img src={p.url} alt={p.name} />
                              <div style={{ fontSize: '0.75rem', textAlign: 'center' }}>{p.name}</div>
                              {isUploading && (
                                <div style={{ display:'flex', gap:8, alignItems:'center', justifyContent:'center' }}>
                                  <div style={{ width: 140, height: 8, background: '#eee', borderRadius: 6 }}>
                                    <div style={{ width: `${uploadProgress[idx]?.full || 0}%`, height: '100%', background: '#2b8aef', borderRadius: 6 }} />
                                  </div>
                                  <div style={{ fontSize: '0.75rem', minWidth: 36 }}>{uploadProgress[idx]?.full ?? 0}%</div>
                                </div>
                              )}
                            </figure>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="field">
                    <label htmlFor="cost">Costo</label>
                    <input type="number" id="cost" value={cost} onChange={(e) => setCost(e.target.value)} min="0" step="0.01" />
                    <label htmlFor="price">Precio</label>
                    <input type="number" id="price" value={price} onChange={(e) => setPrice(e.target.value)} min="0" step="0.01" />
                  </div>
                </div>
              </div>

              <div className="apm-section">
                <div className="apm-row">
                  <div className="field full">
                    <label htmlFor="minQuantity">Cantidad Mínima (Para alertas)</label>
                    <input type="number" id="minQuantity" value={minQuantity} onChange={(e) => setMinQuantity(e.target.value)} min="0" />
                  </div>
                </div>
              </div>

              <div className="apm-section">
                <label>Asignar a Inventarios</label>
                <div className="apm-row">
                  <div className="field">
                    <div className="inline">
                      <select id="inventory-picker" value={selectedInventory || inventories[0]?.id || ''} onChange={(e) => setSelectedInventory(e.target.value)} disabled={inventories.length === 0}>
                        {inventories.length === 0 ? <option>Crea un inventario para continuar</option> : inventories.map(inv => <option key={inv.id} value={inv.id}>{inv.name}</option>)}
                      </select>
                      <button type="button" className="btn secondary" onClick={handleAddInventoryToList} disabled={!(selectedInventory || inventories[0]?.id) || inventoryQuantities.some(iq => iq.inventoryId === (selectedInventory || inventories[0]?.id))}>Añadir</button>
                    </div>
                    <button type="button" className="btn" onClick={() => setIsNewInventoryModalOpen(true)}>Crear nuevo inventario</button>
                  </div>
                </div>

                {inventoryQuantities.length > 0 && (
                  <div className="inventory-list">
                    {inventoryQuantities.map(({ inventoryId, quantity }) => {
                      const inventory = inventories.find(inv => inv.id === inventoryId);
                      return (
                        <div key={inventoryId} className="inventory-item">
                          <div className="inventory-label">{inventory ? inventory.name : 'Inventario no encontrado'}</div>
                          <div className="inventory-controls">
                            <input id={`quantity-${inventoryId}`} type="number" value={quantity} onChange={(e) => handleQuantityChange(inventoryId, e.target.value)} min="0" />
                            <button type="button" className="btn contrast" onClick={() => handleRemoveInventory(inventoryId)} aria-label="Quitar inventario">&times;</button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <footer className="apm-footer">
                {isEditMode && (
                  <button type="button" className="btn danger" onClick={handleDeleteClick} disabled={loading} style={{ marginRight:'auto' }}>{loading ? 'Eliminando...' : 'Eliminar Producto'}</button>
                )}
                <button type="button" className="btn secondary" onClick={onClose} disabled={loading}>Cancelar</button>
                <button type="submit" className="btn primary" disabled={loading || isUploading || (inventories.length === 0 && !isEditMode)}>{loading || isUploading ? 'Guardando...' : (isEditMode ? 'Guardar Cambios' : 'Guardar Producto')}</button>
              </footer>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

export default AddProductModal;