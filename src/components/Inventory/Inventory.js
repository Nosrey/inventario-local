import React, { useState, useEffect } from 'react';
import { doc, setDoc, writeBatch, runTransaction, deleteDoc, deleteField, serverTimestamp, getDoc, getDocFromServer, collection, addDoc, query, where, getDocs } from 'firebase/firestore';
import { db } from '../../firebase.js';
import { useData } from '../../context/DataProvider.jsx';
import AddProductButton from '../AddProductButton/AddProductButton.js';
import NewModalAddProductModal from '../NewModalAddProductModal/NewModalAddProductModal.js';
import ProductSearchBar from '../ProductSearchBar/ProductSearchBar.js';
import { FixedSizeList as List } from 'react-window';
import './Inventory.css';
// --- NUEVO: reutilizamos estilos y layout de ProductSearchModal para mejor legibilidad ---
import '../Cashier/ProductSearchModal/ProductSearchModal.css';

// Eliminamos listeners locales: usamos el contexto global
function Inventory({ user }) {
  const { loading, productsMap, inventories, brands } = useData();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [selectedInventoryId, setSelectedInventoryId] = useState('total');
  const [productToEdit, setProductToEdit] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [viewMode, setViewMode] = useState('grid'); // ← defecto ahora: cuadrícula

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
    } catch (e) {}
    return () => {
      try {
        document?.body?.classList?.remove('inventory-bg');
        document?.documentElement?.classList?.remove('inventory-bg');
      } catch (e) {}
    };
  }, []);

  const handleSetViewMode = async (mode) => {
    setViewMode(mode);
    if (user?.uid) {
      try { await setDoc(doc(db, 'users', user.uid), { inventoryView: mode }, { merge: true }); } catch {}
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
    const productData = productsMap[productDocId];

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
  const handleAddProduct = async (productData) => {
    setIsUpdating(true);
    try {
      const { docId, name, price, cost, minQuantity, brandId, inventories: targetInvs = [] } = productData;

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
        await setDoc(doc(db, 'products', docId), { ...payload, updatedAt: serverTimestamp() }, { merge: true });

        const batch = writeBatch(db);
        for (const iq of targetInvs) {
          const q = toInt(iq.quantity);
          const invRef = doc(db, 'inventories', iq.inventoryId);
          batch.set(invRef, { products: { [docId]: { quantity: q } }, updatedAt: serverTimestamp() }, { merge: true });
        }
        await batch.commit();

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
      }

      // Listeners globales actualizarán la UI
    } catch (err) {
      console.error('Error guardando producto:', err);
      alert(err?.message || 'No se pudo guardar el producto.');
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
      // Borra documento del producto
      await deleteDoc(doc(db, 'products', productDocId));

      // Quita la entrada en cada inventario
      const batch = writeBatch(db);
      inventories.forEach(inv => {
        const invRef = doc(db, 'inventories', inv.id);
        batch.update(invRef, { [`products.${productDocId}`]: deleteField(), updatedAt: serverTimestamp() });
      });
      await batch.commit();
    } catch (err) {
      console.error('Error eliminando producto:', err);
      alert(err?.message || 'No se pudo eliminar el producto.');
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
      alert(err?.message || 'No se pudo crear el inventario');
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
      alert(err?.message || 'No se pudo crear la marca');
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

  const filteredAndSortedKeys = Object.keys(productsMap)
    .filter(productDocId => (productsMap[productDocId]?.name || '').toLowerCase().includes(searchTerm.toLowerCase()))
    .sort((a, b) => (productsMap[a].id ?? 0) - (productsMap[b].id ?? 0));

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
          <div className="compact-row-inner">
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
              <button onClick={() => handleEditClick(productDocId)} className="outline secondary row-edit-btn" aria-label={`Editar ${productInfo?.name || ''}`}>
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
            <button onClick={() => handleEditClick(productDocId)} className="outline secondary row-edit-btn">
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
      <section style={{ width: "100%", margin: '0 auto', padding: '2rem 1rem' }}>
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
                  onClick={() => {/* no-op */}}
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
                              style={{ cursor: 'default' }}
                            >
                              <div className="lps-thumb" style={{ flex: '0 0 54px' }}>
                                {hasImage ? (
                                  <img
                                    src={productInfo.image}
                                    alt={productInfo?.name || ''}
                                    loading="lazy"
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
                                <button onClick={() => handleEditClick(productDocId)} className="outline secondary row-edit-btn" aria-label={`Editar ${productInfo?.name || ''}`}>
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
      />
    </>
  );
}

export default Inventory;