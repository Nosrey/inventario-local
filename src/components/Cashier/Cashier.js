import React, { useState, useMemo, useEffect, useRef } from 'react';
import { doc, setDoc, serverTimestamp, updateDoc, increment } from 'firebase/firestore';
import { db } from '../../firebase.js';
import { useData } from '../../context/DataProvider.jsx';
import ProductSearchModal from './ProductSearchModal/ProductSearchModal.js';
import AddProductButton from '../AddProductButton/AddProductButton.js';
import './Cashier.css';

// 1. Función de cálculo de precios con la nueva salida (Bs, USD con decimales y mixto)
const calculateAmounts = (amountUSD, bcvRate, paraleloRate) => {
    const safe = (n) => (typeof n === 'number' && isFinite(n) ? n : 0);
    const usd = safe(amountUSD);
    const bcv = safe(bcvRate);
    const par = safe(paraleloRate);

    if (usd <= 0 || bcv <= 0 || par <= 0) {
        return { bs: 0, usdAdjusted: usd, usdInt: 0, bsDecimals: 0 };
    }

    const precioBsExact = usd * par;     // USD -> Bs (paralelo)
    const bs = Math.ceil(precioBsExact); // Redondeo hacia arriba
    const usdAdjusted = precioBsExact / bcv; // Bs -> USD (BCV)
    const usdInt = Math.floor(usdAdjusted);
    const bsDecimals = Math.ceil((usdAdjusted - usdInt) * bcv);

    return { bs, usdAdjusted, usdInt, bsDecimals };
};

const formatUSD = (v) =>
    (Number.isFinite(v) ? v : 0).toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const formatBs = (v) =>
    `${Math.max(0, Math.round(v)).toLocaleString('es-VE')} Bs.`;

function Cashier({ user, initialActiveInventoryId }) { // añadido prop
    const { loading, products, inventories, settings } = useData();
    const [activeInventoryId, setActiveInventoryId] = useState(null);
    const [cart, setCart] = useState([]);
    const [error, setError] = useState(null);
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [notification, setNotification] = useState({ message: '', type: '' });
    const [isProcessingSale, setIsProcessingSale] = useState(false);
    const [appSettings, setAppSettings] = useState({ dolarBCV: 0, dolarParalelo: 0 });
    const [customer, setCustomer] = useState({ name: '', phone: '', id: '', address: '', notes: '' });
    const [paymentMethod, setPaymentMethod] = useState('');
    const userInteractedRef = useRef(false); // NUEVO: evita sobreescritura tras interacción del usuario

    // Mantener settings locales (para no romper dependencias de cálculo)
    React.useEffect(() => {
        setAppSettings({
            dolarBCV: Number(settings.dolarBCV) || 0,
            dolarParalelo: Number(settings.dolarParalelo) || 0
        });
    }, [settings]);

    useEffect(() => {
        if (!inventories.length) return;

        // No sobreescribir si el usuario ya cambió manualmente
        if (userInteractedRef.current) return;

        const lsKey = user?.uid ? `activeInventory:${user.uid}` : null;

        let candidate = null;

        // Prioridad 1: valor remoto pasado por prop
        if (initialActiveInventoryId && inventories.some(i => i.id === initialActiveInventoryId)) {
            candidate = initialActiveInventoryId;
        }

        // Prioridad 2: localStorage (si aún no hay candidato)
        if (!candidate && lsKey) {
            const lsVal = localStorage.getItem(lsKey);
            if (lsVal && inventories.some(i => i.id === lsVal)) {
                candidate = lsVal;
            }
        }

        // Prioridad 3: valor actual (si es válido)
        if (!candidate && activeInventoryId && inventories.some(i => i.id === activeInventoryId)) {
            candidate = activeInventoryId;
        }

        // Prioridad 4: primer inventario disponible
        if (!candidate) {
            candidate = inventories[0].id;
        }

        if (candidate !== activeInventoryId) {
            setActiveInventoryId(candidate);
        }
    }, [inventories, initialActiveInventoryId, activeInventoryId, user]);

    const showNotification = (message, type = 'error', duration = 4000) => {
        setNotification({ message, type });
        window.clearTimeout(showNotification._t);
        showNotification._t = window.setTimeout(() => setNotification({ message: '', type: '' }), duration);
    };

    const handleInventoryChange = async (newInventoryId) => {
        if (newInventoryId === activeInventoryId) return;
        userInteractedRef.current = true; // Marca que el usuario ya intervino
        setActiveInventoryId(newInventoryId);

        const lsKey = user?.uid ? `activeInventory:${user.uid}` : null;
        if (lsKey) localStorage.setItem(lsKey, newInventoryId);

        if (user?.uid) {
            try {
                await setDoc(doc(db, 'users', user.uid), { activeInventory: newInventoryId }, { merge: true });
            } catch {
                showNotification("No se pudo guardar la selección de inventario.", 'error');
            }
        }
    };

    // NORMALIZAR / DEDUPLICAR ENTRADAS ANTIGUAS (si ya se habían agregado duplicados sin docId)
    useEffect(() => {
        setCart(prev => {
            const map = {};
            let changed = false;
            for (const item of prev) {
                const key = item.docId || item.id; // usar siempre esta clave
                if (map[key]) {
                    map[key].quantity += item.quantity;
                    changed = true;
                } else {
                    map[key] = { ...item, docId: key }; // forzar docId normalizado
                }
            }
            return changed ? Object.values(map) : prev;
        });
    }, []);

    const handleAddProductToCart = (product, quantity = 1) => {
        const key = product.docId || product.id;
        if (!key) return;

        let errorMsg = null;

        setCart(prev => {
            const existing = prev.find(i => (i.docId || i.id) === key);
            const totalStock = Number(product.totalStock) || 0;
            const qtyInCart = existing ? existing.quantity : 0;

            if (totalStock <= 0) {
                errorMsg = `"${product.name}" no tiene stock.`;
                return prev;
            }
            if (qtyInCart >= totalStock) {
                errorMsg = `No hay más stock disponible para "${product.name}".`;
                return prev;
            }
            if (qtyInCart + quantity > totalStock) {
                errorMsg = `Solo puedes añadir ${totalStock - qtyInCart} unidad(es) más de "${product.name}".`;
                return prev;
            }

            if (existing) {
                return prev.map(i =>
                    (i.docId || i.id) === key
                        ? { ...i, docId: key, quantity: i.quantity + quantity }
                        : i
                );
            }
            return [...prev, { ...product, docId: key, quantity }];
        });

        if (errorMsg) {
            showNotification(errorMsg, 'error');
        }
    };

    const handleRemoveProductFromCart = (productDocId) => {
        setCart(curr => curr.filter(i => i.docId !== productDocId));
    };

    const handleQuantityChange = (productDocId, newQuantity) => {
        const q = newQuantity === '' ? 0 : Number(newQuantity);
        if (!Number.isFinite(q) || q < 0) return;

        const activeInv = inventories.find(inv => inv.id === activeInventoryId);
        const stock = Number(activeInv?.products?.[productDocId]?.quantity) || 0;
        const prodInfo = products.find(p => p.docId === productDocId);

        if (q > stock) {
            showNotification(`Stock máximo para "${prodInfo?.name || ''}" en este inventario es ${stock}.`, 'error');
            setCart(curr => curr.map(i => i.docId === productDocId ? { ...i, quantity: stock } : i));
            return;
        }
        setCart(curr => curr.map(i => i.docId === productDocId ? { ...i, quantity: q } : i));
    };

    // Confirmar venta sin lecturas extra (usa inventario del contexto)
    const handleConfirmSale = async () => {
        if (cart.length === 0) { showNotification("El carrito está vacío.", 'error'); return; }
        if (!activeInventoryId) { showNotification("No hay un inventario seleccionado.", 'error'); return; }
        if (!paymentMethod) { showNotification("Selecciona un método de pago.", 'error'); return; }

        setIsProcessingSale(true);
        const inventoryDocRef = doc(db, 'inventories', activeInventoryId);
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));

        try {
            // Validación local de stock
            const activeInv = inventories.find(inv => inv.id === activeInventoryId);
            if (!activeInv) throw new Error("El inventario seleccionado ya no existe.");

            for (const item of cart) {
                const stock = Number(activeInv.products?.[item.docId]?.quantity) || 0;
                if (item.quantity > stock) {
                    throw new Error(`Stock insuficiente para "${item.name}". Solo quedan ${stock}.`);
                }
            }

            // Descontar con increment() (evita lecturas)
            const updates = {};
            for (const item of cart) {
                updates[`products.${item.docId}.quantity`] = increment(-item.quantity);
            }

            const maxAttempts = 3;
            for (let attempt = 0; attempt < maxAttempts; attempt++) {
                try {
                    await updateDoc(inventoryDocRef, updates);
                    break;
                } catch (err) {
                    const code = String(err?.code || err?.message || '');
                    if (attempt < maxAttempts - 1 && (code.includes('resource-exhausted') || code.includes('429'))) {
                        await sleep(350 + Math.floor(Math.random() * 650));
                        continue;
                    }
                    throw err;
                }
            }

            // Registrar venta en history/main/sells
            const saleId = `sell_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            const to2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
            const items = cart.map(item => {
                const unit = calculateAmounts(item.price, appSettings.dolarBCV, appSettings.dolarParalelo);
                const subtotalUSD = item.price * item.quantity;
                const sub = calculateAmounts(subtotalUSD, appSettings.dolarBCV, appSettings.dolarParalelo);
                return {
                    productDocId: item.docId,
                    productId: item.id ?? null,
                    name: item.name,
                    quantity: item.quantity,
                    unitPriceUSD: to2(item.price),
                    ratesUsed: { bcv: to2(appSettings.dolarBCV), paralelo: to2(appSettings.dolarParalelo) },
                    unitPriceBs: Math.max(0, Math.round(unit.bs)),
                    unitPriceUsdAdjusted: to2(unit.usdAdjusted),
                    subtotalBs: Math.max(0, Math.round(sub.bs)),
                    subtotalUsdAdjusted: to2(sub.usdAdjusted),
                };
            });

            const cartTotal = cart.reduce((t, i) => t + (i.price * i.quantity), 0);
            const totals = calculateAmounts(cartTotal, appSettings.dolarBCV, appSettings.dolarParalelo);
            const activeInventoryName = inventories.find(i => i.id === activeInventoryId)?.name || '';

            await setDoc(doc(db, 'history', 'main', 'sells', saleId), {
                id: saleId,
                soldAt: serverTimestamp(),
                soldAtISO: new Date().toISOString(),
                userId: user?.uid || null,
                inventoryId: activeInventoryId,
                inventoryName: activeInventoryName,
                customer: { ...customer },
                paymentMethod,
                items,
                totals: {
                    bs: Math.max(0, Math.round(totals.bs)),
                    usdAdjusted: to2(totals.usdAdjusted),
                    usdInt: Math.max(0, Math.floor(totals.usdInt)),
                    bsDecimals: Math.max(0, Math.round(totals.bsDecimals)),
                },
                ratesUsed: { bcv: to2(appSettings.dolarBCV), paralelo: to2(appSettings.dolarParalelo) },
                summary: { itemCount: cart.reduce((n, i) => n + i.quantity, 0), productLines: cart.length }
            });

            showNotification("Venta realizada con éxito.", 'success');
            setCart([]);
            setCustomer({ name: '', phone: '', id: '', address: '', notes: '' });
            setPaymentMethod('');
        } catch (err) {
            console.error('Error al procesar la venta:', err);
            setError(err?.message || 'No se pudo completar la venta.');
            showNotification(err?.message || 'No se pudo completar la venta.', 'error');
        } finally {
            setIsProcessingSale(false);
        }
    };

    const cartTotal = useMemo(() => cart.reduce((t, i) => t + (i.price * i.quantity), 0), [cart]);
    const totals = useMemo(
        () => calculateAmounts(cartTotal, appSettings.dolarBCV, appSettings.dolarParalelo),
        [cartTotal, appSettings.dolarBCV, appSettings.dolarParalelo]
    );
    const activeInventoryName = useMemo(() => inventories.find(inv => inv.id === activeInventoryId)?.name || 'Ninguno', [inventories, activeInventoryId]);

    const incrementQuantity = (docId) => {
        const item = cart.find(i => i.docId === docId);
        if (!item) return;
        handleQuantityChange(docId, item.quantity + 1);
    };

    const decrementQuantity = (docId) => {
        const item = cart.find(i => i.docId === docId);
        if (!item) return;
        const next = item.quantity - 1;
        if (next <= 0) {
            handleRemoveProductFromCart(docId);
        } else {
            handleQuantityChange(docId, next);
        }
    };

    return (
        <>
            {/* 4. Renderizar la notificación con la clase de tipo dinámico */}
            {notification.message && (
                <div
                  className={`app-toast app-toast-fixed ${notification.type}`}
                  data-icon={
                    notification.type === 'success'
                      ? '✓'
                      : notification.type === 'error'
                        ? '✕'
                        : 'ℹ'
                  }
                  role="status"
                  aria-live="polite"
                >
                  {notification.message}
                </div>
            )}
            <section className="cashier-container">
                <article>
                    <header>
                        {/* --- INICIO DE LA MODIFICACIÓN VISUAL --- */}
                        <div className="cashier-header">
                            <h2>Caja</h2>
                            <div className="inventory-selector-wrapper">
                                <label htmlFor="main-inventory-select">Inventario Activo:</label>
                                <select
                                    id="main-inventory-select"
                                    value={activeInventoryId || ''}
                                    onChange={(e) => handleInventoryChange(e.target.value)}
                                    disabled={loading}
                                >
                                    {inventories.length === 0 && <option>Cargando...</option>}
                                    {inventories.map(inv => (
                                        <option key={inv.id} value={inv.id}>
                                            {inv.name}
                                        </option>
                                    ))}
                                </select>
                            </div>
                        </div>
                        {/* --- FIN DE LA MODIFICACIÓN VISUAL --- */}
                    </header>

                    {loading && <p>Cargando productos...</p>}
                    {error && <p style={{ color: 'var(--pico-color-red-500)' }}>{error}</p>}

                    {!loading && !error && (
                        <>
                            <figure className="cart-area">
                                <div className="cart-header-row">
                                    <div>Producto</div>
                                    <div>Precio</div>
                                    <div>Cant.</div>
                                    <div>Subtotal</div>
                                    <div></div>
                                </div>
                                <div className="cart-body">
                                    {cart.length === 0 && (
                                        <div className="cart-empty">Añade productos para empezar una venta.</div>
                                    )}
                                    {cart.map(item => {
                                        const unit = calculateAmounts(item.price, appSettings.dolarBCV, appSettings.dolarParalelo);
                                        const subtotalUSD = item.price * item.quantity;
                                        const sub = calculateAmounts(subtotalUSD, appSettings.dolarBCV, appSettings.dolarParalelo);
                                        return (
                                            <div className="cart-row" key={item.docId}>
                                                <div className="cart-cell product" data-label="Producto">
                                                    <span className="cart-name">{item.name}</span>
                                                </div>
                                                <div className="cart-cell price" data-label="Precio">
                                                    <span>{formatBs(unit.bs)}</span>
                                                    <small>≈ {formatUSD(unit.usdAdjusted)}</small>
                                                </div>
                                                <div className="cart-cell quantity" data-label="Cant.">
                                                  <div
                                                    className="qty-control"
                                                    role="group"
                                                    aria-label={`Cantidad de ${item.name}`}
                                                  >
                                                    <button
                                                      type="button"
                                                      className="qty-icon"
                                                      onClick={() => decrementQuantity(item.docId)}
                                                      aria-label={`Restar 1 a ${item.name}`}
                                                      disabled={item.quantity <= 1}
                                                    >−</button>
                                                    <span
                                                      className="qty-number"
                                                      aria-live="polite"
                                                    >{item.quantity}</span>
                                                    <button
                                                      type="button"
                                                      className="qty-icon"
                                                      onClick={() => incrementQuantity(item.docId)}
                                                      aria-label={`Sumar 1 a ${item.name}`}
                                                      disabled={item.quantity >= item.totalStock}
                                                    >+</button>
                                                  </div>
                                                  <small className="stock-hint">
                                                    Stock: {item.totalStock - item.quantity}
                                                  </small>
                                                </div>
                                                <div className="cart-cell subtotal" data-label="Subtotal">
                                                    <span>{formatBs(sub.bs)}</span>
                                                    <small>≈ {formatUSD(sub.usdAdjusted)}</small>
                                                </div>
                                                <div className="cart-cell remove">
                                                    <button
                                                      onClick={() => handleRemoveProductFromCart(item.docId)}
                                                      className="remove-btn"
                                                      aria-label={`Eliminar ${item.name}`}
                                                    >&times;</button>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                                {cart.length > 0 && (
                                  <div className="cart-footer">
                                    <div className="totals-block">
                                      <div className="totals-line">
                                        <span>Total</span>
                                        <strong>{formatBs(totals.bs)}</strong>
                                      </div>
                                      <div className="totals-line alt">≈ {formatUSD(totals.usdAdjusted)}</div>
                                      <div className="totals-line alt">
                                        Mixto: ${totals.usdInt} y {formatBs(totals.bsDecimals)}
                                      </div>
                                    </div>
                                  </div>
                                )}
                            </figure>

                            {/* NUEVO: Formulario de cliente y método de pago */}
                            <section className="customer-form grid-form" aria-label="Datos del cliente y pago">
                                <div className="group">
                                    <h3>Cliente</h3>
                                    <div className="fields">
                                        <label>
                                            <span>Nombre</span>
                                            <input
                                                type="text"
                                                placeholder="Juan Pérez"
                                                value={customer.name}
                                                onChange={(e) => setCustomer(p => ({ ...p, name: e.target.value }))}
                                                autoComplete="name"
                                            />
                                        </label>
                                        <label>
                                            <span>Teléfono</span>
                                            <input
                                                type="tel"
                                                placeholder="0412-1234567"
                                                value={customer.phone}
                                                onChange={(e) => setCustomer(p => ({ ...p, phone: e.target.value }))}
                                                inputMode="tel"
                                                autoComplete="tel"
                                            />
                                        </label>
                                        <label>
                                            <span>Cédula</span>
                                            <input
                                                type="text"
                                                placeholder="V-12345678"
                                                value={customer.id}
                                                onChange={(e) => setCustomer(p => ({ ...p, id: e.target.value }))}
                                            />
                                        </label>
                                        <label className="span-2">
                                            <span>Dirección</span>
                                            <input
                                                type="text"
                                                placeholder="Calle, sector, ciudad"
                                                value={customer.address}
                                                onChange={(e) => setCustomer(p => ({ ...p, address: e.target.value }))}
                                                autoComplete="street-address"
                                            />
                                        </label>
                                        <label className="span-2">
                                            <span>Notas</span>
                                            <textarea
                                                placeholder="Observaciones, referencias..."
                                                value={customer.notes}
                                                onChange={(e) => setCustomer(p => ({ ...p, notes: e.target.value }))}
                                            />
                                        </label>
                                    </div>
                                </div>
                                <div className="group payment" aria-label="Pago">
                                    <h3>Pago</h3>
                                    <div className="payment-fields">
                                        <label className="method-select">
                                            <span>Método</span>
                                            <select
                                                value={paymentMethod}
                                                onChange={(e) => setPaymentMethod(e.target.value)}
                                            >
                                                <option value="">Selecciona...</option>
                                                <option value="punto">Punto</option>
                                                <option value="pago_movil">Pago móvil</option>
                                                <option value="divisa">Divisa</option>
                                                <option value="efectivo">Efectivo</option>
                                            </select>
                                        </label>
                                        {cart.length > 0 && (
                                          <button
                                            className="confirm-btn"
                                            onClick={handleConfirmSale}
                                            disabled={isProcessingSale}
                                            aria-busy={isProcessingSale}
                                          >
                                            {isProcessingSale ? 'Procesando...' : 'Confirmar Venta'}
                                          </button>
                                        )}
                                    </div>
                                </div>
                            </section>
                        </>
                    )}
                </article>
            </section>

            {/* 2. Reemplaza el botón HTML por el componente AddProductButton */}
            <AddProductButton onClick={() => setIsModalOpen(true)} />

            <ProductSearchModal
                isOpen={isModalOpen}
                onClose={() => setIsModalOpen(false)}
                onAddProduct={handleAddProductToCart}
                allProducts={products}
                inventories={inventories}
                activeInventoryId={activeInventoryId}
                onInventoryChange={handleInventoryChange}
                appSettings={appSettings}
                cart={cart} /* NUEVO: pasar carrito para restar stock usado */
            />
        </>
    );
}

export default Cashier;