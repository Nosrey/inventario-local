import React, { useState, useMemo, useEffect, useRef } from 'react';
import { doc, setDoc, serverTimestamp, updateDoc, increment } from 'firebase/firestore';
import { db } from '../../firebase.js';
import { useData } from '../../context/DataProvider.jsx';
import ProductSearchModal from './ProductSearchModal/ProductSearchModal.js';
import AddProductButton from '../AddProductButton/AddProductButton.js';
import './Cashier.css';

// 1. Función de cálculo de precios con la nueva salida (Bs redondeado hacia arriba a múltiplo de 10)
const calculateAmounts = (amountUSD, bcvRate, paraleloRate) => {
    const safe = (n) => (typeof n === 'number' && isFinite(n) ? n : 0);
    const usd = safe(amountUSD);
    const bcv = safe(bcvRate);
    const par = safe(paraleloRate);

    if (usd <= 0 || bcv <= 0 || par <= 0) {
        return { bs: 0, usdAdjusted: usd, usdInt: 0, bsDecimals: 0 };
    }

    const precioBsExact = usd * par;     // USD -> Bs (paralelo)
    // redondeo normal primero (como antes)
    const bsRaw = Math.ceil(precioBsExact);
    // NUEVO: redondear hacia arriba al siguiente múltiplo de 10
    const bsRounded10 = Math.ceil(bsRaw / 10) * 10;

    const usdAdjusted = precioBsExact / bcv; // Bs -> USD (BCV)
    const usdInt = Math.floor(usdAdjusted);
    const bsDecimals = Math.ceil((usdAdjusted - usdInt) * bcv);

    return { bs: bsRounded10, usdAdjusted, usdInt, bsDecimals };
};

const formatUSD = (v) =>
    (Number.isFinite(v) ? v : 0).toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const formatBs = (v) =>
    `${Math.max(0, Math.round(v)).toLocaleString('es-VE')} Bs.`;

function Cashier({ user, initialActiveInventoryId }) { // añadido prop
    const { loading, products, inventories, settings } = useData();
    const [activeInventoryId, setActiveInventoryId] = useState(null);
    // PESTAÑAS: 9 pestañas desplegadas por defecto (1..9)
    const defaultCustomer = { name: '', phone: '', id: '', address: '', notes: '' };
    const initialTabs = Array.from({ length: 9 }, (_, i) => ({
        id: String(i + 1),
        name: String(i + 1),
        cart: [],
        customer: { ...defaultCustomer },
        paymentMethod: ''
    }));
    const [tabs, setTabs] = useState(() => initialTabs);
    const [activeTabId, setActiveTabId] = useState('1');
    // Helper: carrito actual derivado de tabs
    const cart = React.useMemo(() => {
        const t = tabs.find(x => x.id === activeTabId);
        return t ? t.cart : [];
    }, [tabs, activeTabId]);

    // Mapa de reservas en OTRAS pestañas: { docId: cantidadReservada }
    const reservedMap = React.useMemo(() => {
        const m = Object.create(null);
        for (const t of tabs) {
            if (t.id === activeTabId) continue;
            for (const it of t.cart || []) {
                if (!it?.docId) continue;
                m[it.docId] = (m[it.docId] || 0) + (Number(it.quantity) || 0);
            }
        }
        return m;
    }, [tabs, activeTabId]);

    const setCurrentTabCart = (newCartOrUpdater) => {
        setTabs(prev => prev.map(t => t.id === activeTabId ? {
            ...t,
            cart: typeof newCartOrUpdater === 'function' ? newCartOrUpdater(t.cart) : newCartOrUpdater
        } : t));
    };

    const updateCurrentTabCart = (updater) => setCurrentTabCart(prev => updater(prev));

    const [error, setError] = useState(null);
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [notification, setNotification] = useState({ message: '', type: '' });
    const [isProcessingSale, setIsProcessingSale] = useState(false);
    const [appSettings, setAppSettings] = useState({ dolarBCV: 0, dolarParalelo: 0 });
    // helpers para datos por pestaña (cliente y método de pago)
    const getActiveTab = () => tabs.find(t => t.id === activeTabId) || null;
    const activeCustomer = getActiveTab()?.customer ?? defaultCustomer;
    const activePaymentMethod = getActiveTab()?.paymentMethod ?? '';

    const setActiveTabCustomer = (updater) => {
        setTabs(prev => prev.map(t => t.id === activeTabId ? {
            ...t,
            customer: typeof updater === 'function' ? updater(t.customer ?? defaultCustomer) : updater
        } : t));
    };

    const setActiveTabPaymentMethod = (valOrUpdater) => {
        setTabs(prev => prev.map(t => t.id === activeTabId ? {
            ...t,
            paymentMethod: typeof valOrUpdater === 'function' ? valOrUpdater(t.paymentMethod ?? '') : valOrUpdater
        } : t));
    };

    const userInteractedRef = useRef(false); // NUEVO: evita sobreescritura tras interacción del usuario

    // Estado temporal para editar el USD ajustado en el input sin formateos forzados
    const [priceEditMap, setPriceEditMap] = useState({});

    const commitPriceEdit = (docId) => {
      const raw = priceEditMap[docId];
      if (raw === undefined) return;
      // Llama al handler que ya actualiza el carrito
      handleAdjustedUsdChange(docId, raw);
      // limpiar estado temporal
      setPriceEditMap(prev => {
        const next = { ...prev };
        delete next[docId];
        return next;
      });
    };

    // --- NUEVO: caché local + reconciliación con stock al cargar ---
    // Devuelve prioridad de claves a probar (primero user, luego anon)
    const makeCacheKeys = () => {
        const keys = [];
        if (user?.uid) keys.push(`cashier:state:${user.uid}`);
        keys.push('cashier:state:anon');
        return keys;
    };
    const loadedFromCacheRef = useRef(false);

    const reconcileTabsWithStock = (tabsToRecon, invId) => {
      const inv = inventories.find(i => i.id === invId) || inventories[0];
      if (!inv) return { tabs: tabsToRecon, adjustments: [] };

      // clone tabs
      const clone = tabsToRecon.map(t => ({ ...t, cart: (t.cart || []).map(i => ({ ...i })) }));
      const activeIdx = clone.findIndex(t => t.id === activeTabId) !== -1 ? clone.findIndex(t => t.id === activeTabId) : 0;
      const activeTab = clone[activeIdx];

      // collect product ids present in any tab
      const allPids = new Set();
      for (const t of clone) for (const it of t.cart || []) if (it?.docId) allPids.add(it.docId);

      const adjustments = [];

      for (const pid of allPids) {
        const totalStock = Number(inv.products?.[pid]?.quantity) || 0;
        const desiredActive = Number((activeTab.cart.find(i => i.docId === pid) || { quantity: 0 }).quantity) || 0;

        // If active desires more than totalStock, cap active and zero others
        if (desiredActive >= totalStock) {
          const newActiveQty = Math.min(desiredActive, totalStock);
          if (newActiveQty !== desiredActive) {
            const item = activeTab.cart.find(i => i.docId === pid);
            if (item) {
              adjustments.push(`${item.name || pid} (pestaña ${activeTab.id}): ${desiredActive}→${newActiveQty}`);
              item.quantity = newActiveQty;
            }
          }
          // zero others
          for (const t of clone) {
            if (t.id === activeTab.id) continue;
            const it = t.cart.find(i => i.docId === pid);
            if (it && Number(it.quantity) > 0) {
              adjustments.push(`${it.name || pid} (pestaña ${t.id}): ${it.quantity}→0`);
              it.quantity = 0;
            }
          }
        } else {
          // keep active desired, distribute remaining to other tabs in ascending order
          let remaining = totalStock - desiredActive;
          for (const t of clone.filter(t => t.id !== activeTab.id).sort((a,b) => Number(a.id) - Number(b.id))) {
            const it = t.cart.find(i => i.docId === pid);
            if (!it) continue;
            const old = Number(it.quantity) || 0;
            const allowed = Math.min(old, remaining);
            if (old !== allowed) {
              adjustments.push(`${it.name || pid} (pestaña ${t.id}): ${old}→${allowed}`);
              it.quantity = allowed;
            }
            remaining = Math.max(0, remaining - allowed);
          }
        }
      }

      return { tabs: clone, adjustments };
    };

        // --- Versión mejorada de carga de cache en dos fases ---
        // 1) carga rápida al montar para restaurar inmediatamente tras F5 (no depende de inventories)
        // 2) cuando inventories esté disponible, hacer reconciliación inteligente con stock y aplicar ajustes
        const quickLoadedRef = useRef(false);

        useEffect(() => {
            if (quickLoadedRef.current) return;
            try {
                // intentamos leer anon y user (si existe); priorizamos user si está presente
                const keys = [];
                if (user?.uid) keys.push(`cashier:state:${user.uid}`);
                keys.push('cashier:state:anon');

                let raw = null;
                for (const k of keys) {
                    const r = localStorage.getItem(k);
                    if (r) { raw = r; break; }
                }
                if (!raw) { quickLoadedRef.current = true; return; }
                const parsed = JSON.parse(raw);
                if (!parsed || !Array.isArray(parsed.tabs)) { quickLoadedRef.current = true; return; }

                // Normalizar/llenar tabs faltantes (asegura 9 pestañas con ids 1..9)
                const cachedTabs = Array.from({ length: 9 }, (_, i) => {
                    const found = parsed.tabs.find(t => t.id === String(i+1));
                    return found ? { id: String(i+1), name: String(i+1), cart: (found.cart || []).map(it => ({ ...it })) , customer: found.customer || { name: '', phone: '', id: '', address: '', notes: '' }, paymentMethod: found.paymentMethod || '' } : { id: String(i+1), name: String(i+1), cart: [], customer: { name: '', phone: '', id: '', address: '', notes: '' }, paymentMethod: '' };
                });

                // Aplicar inmediatamente los tabs recuperados para que la UI muestre la sesión restaurada
                setTabs(cachedTabs);

                // Restaurar activeTabId (si viene en payload)
                if (parsed.activeTabId && typeof parsed.activeTabId === 'string') {
                    setActiveTabId(parsed.activeTabId);
                }
                // Restaurar activeInventoryId si existe (no validamos aún contra inventories)
                if (parsed.activeInventoryId && typeof parsed.activeInventoryId === 'string') {
                    setActiveInventoryId(parsed.activeInventoryId);
                }
            } catch (err) {
                console.warn('Error al cargar cache (rápido) de cashier:', err);
            } finally {
                quickLoadedRef.current = true;
            }
        }, []); // ejecutar sólo al montar

        // segunda fase: cuando inventories o user estén disponibles, reconciliar con stock y aplicar ajustes definitivos
        useEffect(() => {
            if (loadedFromCacheRef.current) return;
            if (!inventories.length) return;
            const keys = makeCacheKeys();
            try {
                let raw = null;
                let usedKey = null;
                for (const k of keys) {
                    const r = localStorage.getItem(k);
                    if (r) { raw = r; usedKey = k; break; }
                }
                if (!raw) { loadedFromCacheRef.current = true; return; }
                const parsed = JSON.parse(raw);
                if (!parsed || !Array.isArray(parsed.tabs)) { loadedFromCacheRef.current = true; return; }

                // Normalizar/llenar tabs faltantes (asegura 9 pestañas con ids 1..9)
                const cachedTabs = Array.from({ length: 9 }, (_, i) => {
                    const found = parsed.tabs.find(t => t.id === String(i+1));
                    return found ? { id: String(i+1), name: String(i+1), cart: (found.cart || []).map(it => ({ ...it })) , customer: found.customer || { name: '', phone: '', id: '', address: '', notes: '' }, paymentMethod: found.paymentMethod || '' } : { id: String(i+1), name: String(i+1), cart: [], customer: { name: '', phone: '', id: '', address: '', notes: '' }, paymentMethod: '' };
                });

                // Restablecer activeInventoryId y activeTabId si son válidos
                if (parsed.activeInventoryId && inventories.some(i => i.id === parsed.activeInventoryId)) {
                    setActiveInventoryId(parsed.activeInventoryId);
                }
                if (parsed.activeTabId && typeof parsed.activeTabId === 'string') {
                    setActiveTabId(parsed.activeTabId);
                }

                // Reconciliar cantidades con stock actual
                const invIdToUse = parsed.activeInventoryId && inventories.some(i=>i.id===parsed.activeInventoryId) ? parsed.activeInventoryId : (inventories[0]?.id || null);
                const { tabs: adjustedTabs, adjustments } = reconcileTabsWithStock(cachedTabs, invIdToUse);
                setTabs(adjustedTabs);
                if (adjustments.length) {
                    const short = adjustments.slice(0, 6).join(', ');
                    const msg = `Se ajustaron cantidades al restaurar la sesión: ${short}${adjustments.length > 6 ? '…' : ''}`;
                    showNotification(msg, 'info', 7000);
                }
            } catch (err) {
                console.warn('Error al cargar cache de cashier (reconciliación):', err);
            } finally {
                loadedFromCacheRef.current = true;
            }
        }, [inventories, user?.uid]); // eslint-disable-line react-hooks/exhaustive-deps

    // Persistir cache cuando cambien tabs / inventario activo / pestaña activa
    useEffect(() => {
      try {
        const payload = {
          tabs,
          activeInventoryId,
          activeTabId,
          savedAt: Date.now()
        };
        // Guardar preferente en clave de user (si existe) y siempre actualizar la clave anon como fallback
        if (user?.uid) {
          localStorage.setItem(`cashier:state:${user.uid}`, JSON.stringify(payload));
        }
        // Mantener copia anon para recuperaciones rápidas (F5 sin auth resuelta)
        localStorage.setItem('cashier:state:anon', JSON.stringify(payload));
      } catch (err) {
        console.warn('No se pudo guardar cache de cashier:', err);
      }
    }, [tabs, activeInventoryId, activeTabId, user?.uid]);
    
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

    // NORMALIZAR / DEDUPLICAR ENTRADAS ANTIGUAS por cada pestaña
    useEffect(() => {
        setTabs(prevTabs => prevTabs.map(tab => {
            const map = {};
            let changed = false;
            for (const item of tab.cart) {
                const key = item.docId || item.id;
                if (map[key]) {
                    map[key].quantity += item.quantity;
                    changed = true;
                } else {
                    map[key] = { ...item, docId: key };
                }
            }
            return changed ? { ...tab, cart: Object.values(map) } : tab;
        }));
    }, []);

    // Helper: disponibilidad real considerando inventario activo y reservas en otras pestañas
    const getAvailableForProduct = (productDocId, qtyInThisTab = 0) => {
        const key = productDocId;
        const activeInv = inventories.find(inv => inv.id === activeInventoryId);
        const totalStock = Number(activeInv?.products?.[key]?.quantity) || 0;
        const reservedInOtherTabs = tabs.reduce((sum, t) => {
            if (t.id === activeTabId) return sum;
            const it = t.cart.find(i => (i.docId || i.id) === key);
            return sum + (it ? Number(it.quantity) || 0 : 0);
        }, 0);
        return Math.max(0, totalStock - reservedInOtherTabs - qtyInThisTab);
    };

    // Helper: detalles de reservas en otras pestañas para un producto
    const getReservedDetails = (productDocId) => {
        const details = [];
        let total = 0;
        for (const t of tabs) {
            if (t.id === activeTabId) continue;
            const it = (t.cart || []).find(i => (i.docId || i.id) === productDocId);
            if (it && Number(it.quantity) > 0) {
                total += Number(it.quantity);
                details.push({ tabId: t.id, qty: Number(it.quantity) });
            }
        }
        return { total, details };
    };

    const handleAddProductToCart = (product, quantity = 1) => {
        const key = product.docId || product.id;
        if (!key) return;

        let errorMsg = null;

        updateCurrentTabCart(prev => {
            const existing = prev.find(i => (i.docId || i.id) === key);
            const qtyInCart = existing ? Number(existing.quantity) : 0;

            // ahora obtenemos el stock TOTAL desde el inventario activo (no desde product.totalStock)
            const activeInv = inventories.find(inv => inv.id === activeInventoryId);
            const totalStock = Number(activeInv?.products?.[key]?.quantity) || Number(product.totalStock) || 0;

            // CALCULA reservas en OTRAS pestañas
            const reservedInOtherTabs = tabs.reduce((sum, t) => {
                if (t.id === activeTabId) return sum;
                const it = t.cart.find(i => (i.docId || i.id) === key);
                return sum + (it ? Number(it.quantity) || 0 : 0);
            }, 0);

            const availableForActive = Math.max(0, totalStock - reservedInOtherTabs - qtyInCart);

            if (totalStock <= 0 || availableForActive <= 0) {
                errorMsg = `"${product.name}" no tiene stock disponible para añadir (reservado en otras pestañas).`;
                return prev;
            }
            if (quantity > availableForActive) {
                errorMsg = `Solo puedes añadir ${availableForActive} unidad(es) más de "${product.name}" en esta pestaña.`;
                return prev;
            }

            if (existing) {
                return prev.map(i =>
                    (i.docId || i.id) === key
                        ? { ...i, docId: key, quantity: i.quantity + quantity, totalStock }
                        : i
                );
            }

            // --- NUEVO: inicializar priceUsdAdjusted y Bs al agregar ---
            const unit = calculateAmounts(product.price, appSettings.dolarBCV, appSettings.dolarParalelo);
            const roundedUsdAdj = Number((unit.usdAdjusted || 0).toFixed(2));
            const roundedPrice = Number((product.price || 0).toFixed(2));
            
            return [...prev, {
                ...product,
                docId: key,
                quantity,
                totalStock,           // guardamos el totalStock que refleje el inventario activo al añadir
                basePrice: product.price,      // precio original (oculto)
                price: roundedPrice,          // price interno (redondeado a 2 decimales)
                priceUsdAdjusted: roundedUsdAdj,
                priceBs: unit.bs,
                priceBsDecimals: unit.bsDecimals,
                customPrice: false
            }];
        });

        if (errorMsg) showNotification(errorMsg, 'error');
    };

    const handleRemoveProductFromCart = (productDocId) => {
        setCurrentTabCart(curr => curr.filter(i => i.docId !== productDocId));
    };

    const handleQuantityChange = (productDocId, newQuantity) => {
        const q = newQuantity === '' ? 0 : Number(newQuantity);
        if (!Number.isFinite(q) || q < 0) return;

        const activeInv = inventories.find(inv => inv.id === activeInventoryId);
        const totalStock = Number(activeInv?.products?.[productDocId]?.quantity) || 0;

        // reservas en otras pestañas (excluyendo la activa)
        const reservedInOtherTabs = tabs.reduce((sum, t) => {
            if (t.id === activeTabId) return sum;
            const it = (t.cart || []).find(i => (i.docId || i.id) === productDocId);
            return sum + (it ? Number(it.quantity) || 0 : 0);
        }, 0);

        const allowedMax = Math.max(0, totalStock - reservedInOtherTabs);
        const prodInfo = products.find(p => p.docId === productDocId);

        if (q > allowedMax) {
            showNotification(`Stock máximo disponible para "${prodInfo?.name || ''}" es ${allowedMax} (reservado en otras pestañas).`, 'error');
            setCurrentTabCart(curr => curr.map(i => i.docId === productDocId ? { ...i, quantity: allowedMax } : i));
            return;
        }
        setCurrentTabCart(curr => curr.map(i => i.docId === productDocId ? { ...i, quantity: q } : i));
    };

    // Confirmar venta sin lecturas extra (usa inventario del contexto)
    const handleConfirmSale = async () => {
        if (cart.length === 0) { showNotification("El carrito está vacío.", 'error'); return; }
        if (!activeInventoryId) { showNotification("No hay un inventario seleccionado.", 'error'); return; }
        if (!activePaymentMethod) { showNotification("Selecciona un método de pago.", 'error'); return; }

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

            // --- RECONCILIAR OTRAS PESTAÑAS: ajustar cantidades si ahora hay menos stock ---
            try {
                // stock actual antes de la venta (tomado del activeInv leído arriba)
                const currentStockMap = {};
                for (const [pid, pdata] of Object.entries(activeInv.products || {})) {
                    currentStockMap[pid] = Number(pdata?.quantity) || 0;
                }
                // cantidad vendida por producto en esta venta
                const soldMap = cart.reduce((m, it) => { m[it.docId] = (m[it.docId] || 0) + Number(it.quantity || 0); return m; }, {});

                // stock restante por producto (después de la venta local)
                const stockAfterMap = {};
                for (const pid of Object.keys(soldMap)) {
                    stockAfterMap[pid] = Math.max(0, (currentStockMap[pid] || 0) - soldMap[pid]);
                }

                // Ajustar otras pestañas en orden ascendente (1..9). Se asigna stock restante en orden.
                const adjustedInfo = []; // acumula mensajes para notificación
                setTabs(prevTabs => {
                    // clonar pestañas y carritos
                    const clone = prevTabs.map(t => ({ ...t, cart: (t.cart || []).map(i => ({ ...i })) }));
                    const otherTabs = clone.filter(t => t.id !== activeTabId).sort((a,b) => Number(a.id) - Number(b.id));

                    for (const pid of Object.keys(stockAfterMap)) {
                        let remaining = stockAfterMap[pid];
                        for (const tab of otherTabs) {
                            const item = tab.cart.find(i => i.docId === pid);
                            if (!item) continue;
                            const oldQty = item.quantity || 0;
                            const allowed = Math.min(oldQty, remaining);
                            if (oldQty !== allowed) {
                                adjustedInfo.push(`${item.name || pid}: ${oldQty}→${allowed}`);
                                item.quantity = allowed;
                            }
                            remaining = Math.max(0, remaining - allowed);
                        }
                    }
                    return clone;
                });

                if (adjustedInfo.length) {
                    const short = adjustedInfo.slice(0, 6).join(', ');
                    const msg = `Se ajustaron cantidades en otras pestañas: ${short}${adjustedInfo.length > 6 ? '…' : ''}`;
                    showNotification(msg, 'info', 6000);
                }
            } catch (reconErr) {
                console.warn('Reconcilación de pestañas fallida:', reconErr);
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
                customer: { ...(activeCustomer || defaultCustomer) },
                paymentMethod: activePaymentMethod,
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
            // Vaciar sólo la pestaña activa
            setCurrentTabCart([]);
            setActiveTabCustomer({ ...defaultCustomer });
            setActiveTabPaymentMethod('');
        } catch (err) {
            console.error('Error al procesar la venta:', err);
            setError(err?.message || 'No se pudo completar la venta.');
            showNotification(err?.message || 'No se pudo completar la venta.', 'error');
        } finally {
            setIsProcessingSale(false);
        }
    };

    const cartTotal = useMemo(() => cart.reduce((t, i) => t + (i.price * i.quantity), 0), [cart]);
    const totals = useMemo(() => {
        const calc = (usd) => calculateAmounts(usd, appSettings.dolarBCV, appSettings.dolarParalelo);
        const totalsFromUsd = calc(cartTotal); // mantiene USD igual que antes

        // SUMAR los Bs por línea usando el subtotal ya redondeado por línea (pre-suma)
        const sumBs = cart.reduce((s, item) => {
            const subtotalUSD = (Number(item.price) || 0) * (Number(item.quantity) || 0);
            const sub = calc(subtotalUSD);
            return s + (Number(sub.bs) || 0);
        }, 0);

        // sumar bsDecimals por línea (mantener consistencia si se usa)
        const sumBsDecimals = cart.reduce((s, item) => {
            const subtotalUSD = (Number(item.price) || 0) * (Number(item.quantity) || 0);
            const sub = calc(subtotalUSD);
            return s + (Number(sub.bsDecimals) || 0);
        }, 0);

        return {
            ...totalsFromUsd,
            bs: sumBs,
            bsDecimals: sumBsDecimals
        };
    }, [cart, cartTotal, appSettings.dolarBCV, appSettings.dolarParalelo]);
    // const activeInventoryName = useMemo(() => inventories.find(inv => inv.id === activeInventoryId)?.name || 'Ninguno', [inventories, activeInventoryId]);

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

    // NUEVO: cambiar precio unitario (USD) solo para la línea del carrito
    const handleUnitPriceChange = (docId, raw) => {
        const cleaned = String(raw).replace(',', '.').trim();
        // permitir campo vacío -> 0
        const num = cleaned === '' ? 0 : parseFloat(cleaned);
        if (cleaned !== '' && (!Number.isFinite(num) || num < 0)) return;

        setCurrentTabCart(curr => curr.map(i => {
            if (i.docId !== docId) return i;
            const newPrice = cleaned === '' ? 0 : num;
            // calcular equivalencias en Bs usando la función existente
            const unit = calculateAmounts(newPrice, appSettings.dolarBCV, appSettings.dolarParalelo);
            return {
                ...i,
                // price es el precio editable (visible y usado en la venta)
                price: newPrice,
                // marca que fue editado (no mostramos basePrice)
                customPrice: true,
                // guardamos los valores calculados para mostrar sin recálculo extra
                priceBs: unit.bs,
                priceUsdAdjusted: unit.usdAdjusted,
                priceBsDecimals: unit.bsDecimals
            };
        }));
    };

    // NUEVO: editar el USD "AJUSTADO" visible -> recalcula price (USD interno) y Bs
    const handleAdjustedUsdChange = (docId, raw) => {
        const cleaned = String(raw).replace(',', '.').trim();
        const num = cleaned === '' ? 0 : parseFloat(cleaned);
        if (cleaned !== '' && (!Number.isFinite(num) || num < 0)) return;

        const bcv = Number(appSettings.dolarBCV) || 1;
        const par = Number(appSettings.dolarParalelo) || 1;

        // Redondear a 2 decimales al asignar (commit)
        setCurrentTabCart(curr => curr.map(i => {
            if (i.docId !== docId) return i;
            const newUsdAdjusted = cleaned === '' ? 0 : num;
            const newUsdAdjustedRounded = Number(newUsdAdjusted.toFixed(2));
            // regla de 3 inversa: price (USD interno) = usdAdjusted * BCV / Paralelo
            const newPrice = (newUsdAdjustedRounded * bcv) / par;
            const newPriceRounded = Number(newPrice.toFixed(2));
            const unit = calculateAmounts(newPriceRounded, bcv, par);
            return {
                ...i,
                price: newPriceRounded,
                priceUsdAdjusted: newUsdAdjustedRounded,
                priceBs: unit.bs,
                priceBsDecimals: unit.bsDecimals,
                customPrice: true
            };
        }));
    };

    // RESET restaura a basePrice -> recalcula adjusted y Bs
    const resetUnitPrice = (docId) => {
        setCurrentTabCart(curr => curr.map(i => {
            if (i.docId !== docId) return i;
            const base = i.basePrice ?? i.price ?? 0;
            const baseRounded = Number(Number(base).toFixed(2));
            const unit = calculateAmounts(baseRounded, appSettings.dolarBCV, appSettings.dolarParalelo);
            return {
                ...i,
                price: baseRounded,
                customPrice: false,
                priceUsdAdjusted: Number(unit.usdAdjusted.toFixed(2)),
                priceBs: unit.bs,
                priceBsDecimals: unit.bsDecimals
            };
        }));
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
                            <h2>Ventas</h2>

                            {/* PESTAÑAS: 9 pestañas fijas (1..9) */}
                            <div className="tabs-row" role="tablist" aria-label="Pestañas de ventas">
                                {tabs.map(t => (
                                    <button
                                        key={t.id}
                                        role="tab"
                                        aria-selected={t.id === activeTabId}
                                        className={`tab-btn${t.id === activeTabId ? ' active' : ''}`}
                                        onClick={() => setActiveTabId(t.id)}
                                    >
                                        {t.name}
                                    </button>
                                ))}
                            </div>

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
                                        const unit = {
                                          bs: item.priceBs ?? calculateAmounts(item.price, appSettings.dolarBCV, appSettings.dolarParalelo).bs,
                                          usdAdjusted: item.priceUsdAdjusted ?? calculateAmounts(item.price, appSettings.dolarBCV, appSettings.dolarParalelo).usdAdjusted,
                                          bsDecimals: item.priceBsDecimals ?? calculateAmounts(item.price, appSettings.dolarBCV, appSettings.dolarParalelo).bsDecimals
                                        };
                                        const subtotalUSD = item.price * item.quantity;
                                        const sub = calculateAmounts(subtotalUSD, appSettings.dolarBCV, appSettings.dolarParalelo);
                                        return (
                                            <div className="cart-row" key={item.docId}>
                                                <div className="cart-cell product" data-label="Producto">
                                                    <span className="cart-name">{item.name}</span>
                                                    {item.customPrice && (
                                                        <small style={{ color: 'var(--c-accent)' }}>
                                                            Precio personalizado
                                                        </small>
                                                    )}
                                                </div>
                                                <div className="cart-cell price" data-label="Precio">
                                                    <div className="unit-price-row">
                                                        <label className="unit-price-editor">
                                                            <input
                                                                type="text"
                                                                inputMode="decimal"
                                                                pattern="[0-9.,]*"
                                                                value={ priceEditMap[item.docId] ?? (
                                                                    (item.priceUsdAdjusted !== undefined && item.priceUsdAdjusted !== null)
                                                                        ? String(item.priceUsdAdjusted)
                                                                        : (Number.isFinite(item.price) ? String(calculateAmounts(item.price, appSettings.dolarBCV, appSettings.dolarParalelo).usdAdjusted) : '')
                                                                ) }
                                                                onChange={(e) => {
                                                                    // permitir edición libre: sólo actualiza el mapa temporal
                                                                    setPriceEditMap(prev => ({ ...prev, [item.docId]: e.target.value }));
                                                                }}
                                                                onBlur={() => commitPriceEdit(item.docId)}
                                                                onKeyDown={(e) => {
                                                                    if (e.key === 'Enter') {
                                                                        e.currentTarget.blur(); // disparará onBlur -> commit
                                                                    } else if (e.key === 'Escape') {
                                                                        // cancelar edición
                                                                        setPriceEditMap(prev => {
                                                                            const next = { ...prev };
                                                                            delete next[item.docId];
                                                                            return next;
                                                                        });
                                                                    }
                                                                }}
                                                                aria-label={`Precio unitario USD ajustado de ${item.name}`}
                                                            />
                                                            <span className="suffix">USD</span>
                                                            {item.customPrice && item.basePrice !== item.price && (
                                                                <button
                                                                    type="button"
                                                                    className="reset-price-btn"
                                                                    onClick={() => resetUnitPrice(item.docId)}
                                                                    title="Restaurar precio original"
                                                                >↺</button>
                                                            )}
                                                        </label>
                                                    </div>

                                                    {/* Equivalencia en bolívares del precio unitario */}
                                                    <small className="price-bs-hint">
                                                       { formatBs( calculateAmounts(item.price, appSettings.dolarBCV, appSettings.dolarParalelo).bs ) }
                                                   </small>
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
                                                        <span className="qty-number" aria-live="polite">{item.quantity}</span>
                                                        <button
                                                            type="button"
                                                            className="qty-icon"
                                                            onClick={() => incrementQuantity(item.docId)}
                                                            aria-label={`Sumar 1 a ${item.name}`}
                                                            disabled={getAvailableForProduct(item.docId, item.quantity) <= 0}
                                                        >+</button>
                                                    </div>
                                                    {(() => {
                                                        const reserved = getReservedDetails(item.docId);
                                                        const available = Math.max(0, getAvailableForProduct(item.docId, item.quantity));
                                                        // detalle en formato "pestaña X: N"
                                                        const detailParts = reserved.details.map(d => `pestaña ${d.tabId}: ${d.qty}`);
                                                        const detailStr = detailParts.join(', ');
                                                        return (
                                                            <small className="stock-hint">
                                                                <strong>Stock: {available}</strong>
                                                                {reserved.total > 0 && (
                                                                    <>
                                                                        <br />
                                                                        <span className="stock-reserved">
                                                                            Reservado en otras pestañas: {reserved.total}
                                                                            {detailStr ? ` — (${detailStr})` : ''}
                                                                        </span>
                                                                    </>
                                                                )}
                                                            </small>
                                                        );
                                                    })()}
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
                                                value={activeCustomer.name}
                                                onChange={(e) => setActiveTabCustomer(p => ({ ...p, name: e.target.value }))}
                                                autoComplete="name"
                                            />
                                        </label>
                                        <label>
                                            <span>Teléfono</span>
                                            <input
                                                type="tel"
                                                placeholder="0412-1234567"
                                                value={activeCustomer.phone}
                                                onChange={(e) => setActiveTabCustomer(p => ({ ...p, phone: e.target.value }))}
                                                inputMode="tel"
                                                autoComplete="tel"
                                            />
                                        </label>
                                        <label>
                                            <span>Cédula</span>
                                            <input
                                                type="text"
                                                placeholder="V-12345678"
                                                value={activeCustomer.id}
                                                onChange={(e) => setActiveTabCustomer(p => ({ ...p, id: e.target.value }))}
                                            />
                                        </label>
                                        <label className="span-2">
                                            <span>Dirección</span>
                                            <input
                                                type="text"
                                                placeholder="Calle, sector, ciudad"
                                                value={activeCustomer.address}
                                                onChange={(e) => setActiveTabCustomer(p => ({ ...p, address: e.target.value }))}
                                                autoComplete="street-address"
                                            />
                                        </label>
                                        <label className="span-2">
                                            <span>Notas</span>
                                            <textarea
                                                placeholder="Observaciones, referencias..."
                                                value={activeCustomer.notes}
                                                onChange={(e) => setActiveTabCustomer(p => ({ ...p, notes: e.target.value }))}
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
                                                value={activePaymentMethod}
                                                onChange={(e) => setActiveTabPaymentMethod(e.target.value)}
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
                cart={cart} /* carrito de la pestaña activa */
                reservedMap={reservedMap} /* reservado por otras pestañas */
            />
        </>
    );
}

export default Cashier;