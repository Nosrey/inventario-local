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
  // --- FIN NUEVO ---

  const [imagePreviews, setImagePreviews] = useState([]); // previews de imágenes
  const fileInputRef = useRef(null); // <-- NUEVO: ref al input file

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
    if (!newBrandName.trim()) {
      alert('El nombre de la marca no puede estar vacío.');
      return;
    }
    const newBrand = await onCreateBrand(newBrandName.trim());
    if (newBrand) {
      setBrandId(newBrand.id); // Seleccionar la nueva marca creada
      setIsNewBrandModalOpen(false);
      setNewBrandName('');
    }
  };

  const handleCreateNewInventory = async (e) => {
    e.preventDefault();
    if (!newInventoryName.trim()) {
      alert('El nombre del inventario no puede estar vacío.');
      return;
    }
    const newInventory = await onCreateInventory(newInventoryName.trim());
    if (newInventory) {
      // Añade el nuevo inventario directamente a la lista para asignarle una cantidad
      if (!inventoryQuantities.some(iq => iq.inventoryId === newInventory.id)) {
        setInventoryQuantities([...inventoryQuantities, { inventoryId: newInventory.id, quantity: '' }]);
      }
      setSelectedInventory(newInventory.id); // Selecciónalo en el dropdown también
      setIsNewInventoryModalOpen(false);
      setNewInventoryName('');
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

  // Cambios de cantidad: guarda EXACTO lo que escribe el usuario
  const handleInventoryQtyChange = (inventoryId, value) => {
    const q = toInt(value);
    setInventoryQuantities(prev =>
      prev.map(i => i.inventoryId === inventoryId ? { ...i, quantity: q } : i)
    );
  };

  // Al confirmar: envía cantidades exactas (sin restar 1, sin diferenciales)
  const handleSubmit = async (e) => {
    e?.preventDefault?.();
    await onAddProduct({
      docId: productToEdit?.docId || null,
      name,
      price,
      cost,
      minQuantity,
      brandId,
      inventories: inventoryQuantities.map(i => ({ inventoryId: i.inventoryId, quantity: toInt(i.quantity) }))
    });
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
            <a href="#close" aria-label="Close" className="close" onClick={() => setIsNewBrandModalOpen(false)}></a>
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
              <button type="button" className="secondary" onClick={() => setIsNewBrandModalOpen(false)}>Cancelar</button>
              <button type="submit" disabled={loading}>{loading ? 'Creando...' : 'Crear'}</button>
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
            <a href="#close" aria-label="Close" className="close" onClick={() => setIsNewInventoryModalOpen(false)}></a>
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
              <button type="button" className="secondary" onClick={() => setIsNewInventoryModalOpen(false)}>Cancelar</button>
              <button type="submit" disabled={loading}>{loading ? 'Creando...' : 'Crear'}</button>
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
  if (!isOpen) {
    return null;
  }

  // --- 4. EL JSX FINAL ---
  return (
    <dialog open>
      <article className="inv-modal">
        <header>
          <a href="#close" aria-label="Close" className="close" onClick={onClose}></a>
          <h3>{isEditMode ? 'Editar Producto' : 'Añadir Nuevo Producto'}</h3>
        </header>
        <form onSubmit={handleSubmit}>
          <label htmlFor="name">
            Nombre del Producto
            <input type="text" id="name" value={name} onChange={(e) => setName(e.target.value)} required />
          </label>

          {/* Imágenes (maquetado + preview) */}
          <label htmlFor="product-images">Imágenes</label>
          <div className="file-upload">
            <input
              id="product-images"
              ref={fileInputRef}          // <-- NUEVO: ref aplicado
              type="file"
              accept="image/*"
              multiple
              onChange={handleImagesSelected}
            />
            <label className="upload-btn" htmlFor="product-images">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                   xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"
                      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M17 8l-5-5-5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M12 3v12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              Subir imágenes
            </label>
            <span className="upload-hint">PNG, JPG. Máx. 5MB c/u</span>
          </div>

          {imagePreviews.length > 0 && (
            <div className="image-previews">
              {imagePreviews.map((p, idx) => (
                <figure className="thumb" key={idx}>
                  <img src={p.url} alt={p.name} />
                  <figcaption title={p.name}>
                    {p.name}
                  </figcaption>
                </figure>
              ))}
            </div>
          )}

          {/* --- NUEVO: Sección de Marca --- */}
          <label htmlFor="brand-picker">Marca</label>
          <div className="grid">
            <select
              id="brand-picker"
              value={brandId}
              onChange={(e) => setBrandId(e.target.value)}
            >
              <option value="">Ninguna</option>
              {brands && brands.map(brand => <option key={brand.id} value={brand.id}>{brand.name}</option>)}
            </select>
            <button type="button" onClick={() => setIsNewBrandModalOpen(true)} aria-label="Crear nueva marca" style={{ width: 'auto' }}>Crear Marca</button>
          </div>
          {/* --- FIN NUEVO --- */}

          <div className="grid">
            <label htmlFor="cost">
              Costo
              <input type="number" id="cost" value={cost} onChange={(e) => setCost(e.target.value)} required min="0" step="0.01" />
            </label>
            <label htmlFor="price">
              Precio
              <input type="number" id="price" value={price} onChange={(e) => setPrice(e.target.value)} required min="0" step="0.01" />
            </label>
          </div>

          <label htmlFor="minQuantity">
            Cantidad Mínima (Para alertas)
            <input type="number" id="minQuantity" value={minQuantity} onChange={(e) => setMinQuantity(e.target.value)} required min="0" />
          </label>

          <hr />

          {/* --- SECCIÓN DE INVENTARIOS --- */}
          <label htmlFor="inventory-picker">Asignar a Inventarios</label>
          <div className="grid">
            <select
              id="inventory-picker"
              value={selectedInventory || inventories[0]?.id || ''}
              onChange={(e) => setSelectedInventory(e.target.value)}
              disabled={inventories.length === 0}
            >
              {inventories.length === 0 ? (
                <option>Crea un inventario para continuar</option>
              ) : (
                inventories.map(inv => <option key={inv.id} value={inv.id}>{inv.name}</option>)
              )}
            </select>
            <button
              type="button"
              className="secondary"
              onClick={handleAddInventoryToList}
              disabled={
                !(selectedInventory || inventories[0]?.id) ||
                inventoryQuantities.some(iq => iq.inventoryId === (selectedInventory || inventories[0]?.id))
              }
              style={{ width: 'auto' }}
            >
              Añadir inventario
            </button>
            <button type="button" onClick={() => setIsNewInventoryModalOpen(true)} aria-label="Crear nuevo inventario" style={{ width: 'auto' }}>
              Crear nuevo inventario
            </button>
          </div>

          <hr />

          {/* --- LISTA DE INVENTARIOS Y CANTIDADES --- */}
          {inventoryQuantities.length > 0 && (
            <div className="inventory-qty-list" style={{ marginTop: 'var(--pico-spacing)', display: 'flex', flexDirection: 'column', gap: 'var(--pico-spacing)' }}>
              {inventoryQuantities.map(({ inventoryId, quantity }) => {
                const inventory = inventories.find(inv => inv.id === inventoryId);
                return (
                  <div key={inventoryId}>
                    <label
                      htmlFor={`quantity-${inventoryId}`}
                      style={{ textTransform: 'capitalize', marginBottom: 'calc(var(--pico-form-element-spacing-vertical) / 4)' }}
                    >
                      {inventory ? `Cantidad en ${inventory.name}` : 'Inventario no encontrado'}
                    </label>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 'var(--pico-spacing)' }}>
                      <input
                        id={`quantity-${inventoryId}`}
                        type="number"
                        value={quantity}
                        onChange={(e) => handleQuantityChange(inventoryId, e.target.value)}
                        placeholder="Cantidad Inicial"
                        required
                        min="0"
                      />
                      <button
                        type="button"
                        className="contrast"
                        onClick={() => handleRemoveInventory(inventoryId)}
                        aria-label="Quitar inventario"
                        style={{ marginLeft: 'var(--pico-spacing)' }}
                      >
                        &times;
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <footer style={{ paddingTop: 'var(--pico-spacing)', display:'flex', gap:'0.75rem', justifyContent:'flex-end', flexWrap:'wrap' }}>
            {isEditMode && (
              <button
                type="button"
                className="danger delete-btn"
                onClick={handleDeleteClick}
                disabled={loading}
                style={{ marginRight:'auto' }}
              >
                {loading ? 'Eliminando...' : 'Eliminar Producto'}
              </button>
            )}
            <button type="button" className="secondary" onClick={onClose} disabled={loading}>Cancelar</button>
            <button type="submit" disabled={loading || (inventories.length === 0 && !isEditMode)}>
              {loading ? 'Guardando...' : (isEditMode ? 'Guardar Cambios' : 'Guardar Producto')}
            </button>
          </footer>
        </form>
      </article>
    </dialog>
  );
}

export default AddProductModal;