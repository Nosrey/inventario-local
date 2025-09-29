import React, { useState, useMemo, useEffect, useRef } from 'react';
import { doc, setDoc, serverTimestamp, updateDoc, increment, getDoc, getDocFromServer } from 'firebase/firestore';
import { db } from '../../firebase.js';
import { useData } from '../../context/DataProvider.jsx';
import ProductSearchModal from './ProductSearchModalBuys/ProductSearchModalBuys.js';
import AddProductButton from '../AddProductButton/AddProductButton.js';
import './Buys.css';

// Reuse same conversion helper as Cashier
const calculateAmounts = (amountUSD, bcvRate, paraleloRate) => {
  const safe = (n) => (typeof n === 'number' && isFinite(n) ? n : 0);
  const usd = safe(amountUSD);
  const bcv = safe(bcvRate);
  const par = safe(paraleloRate);

  if (usd <= 0 || bcv <= 0 || par <= 0) {
    return { bs: 0, usdAdjusted: usd, usdInt: 0, bsDecimals: 0 };
  }

  const precioBsExact = usd * par; // USD -> Bs (paralelo)
  const bsRaw = Math.ceil(precioBsExact);
  const bsRounded10 = Math.ceil(bsRaw / 10) * 10;

  const usdAdjusted = precioBsExact / bcv; // Bs -> USD (BCV)
  const usdInt = Math.floor(usdAdjusted);
  const bsDecimals = Math.ceil((usdAdjusted - usdInt) * bcv);

  return { bs: bsRounded10, usdAdjusted, usdInt, bsDecimals };
};

const formatUSD = (v) =>
  (Number.isFinite(v) ? v : 0).toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const formatBs = (v) => `${Math.max(0, Math.round(v)).toLocaleString('es-VE')} Bs.`;

function Buys({ user, initialActiveInventoryId }) {
  const { loading, products, inventories, settings } = useData();
  const [activeInventoryId, setActiveInventoryId] = useState(null);

  const defaultCustomer = { name: '', phone: '', id: '', address: '', notes: '' };
  const initialTabs = Array.from({ length: 9 }, (_, i) => ({
    id: String(i + 1),
    name: String(i + 1),
    cart: [],
  }));
  const [tabs, setTabs] = useState(() => initialTabs);
  const [activeTabId, setActiveTabId] = useState('1');

  const cart = useMemo(() => {
    const t = tabs.find(x => x.id === activeTabId);
    return t ? t.cart : [];
  }, [tabs, activeTabId]);

  const setCurrentTabCart = (newCartOrUpdater) => {
    setTabs(prev => prev.map(t => t.id === activeTabId ? { ...t, cart: typeof newCartOrUpdater === 'function' ? newCartOrUpdater(t.cart) : newCartOrUpdater } : t));
  };

  const handleManualRetry = async () => {
    if (!retryRef.current || typeof retryRef.current.attempt !== 'function') {
      showNotification('No hay un reintento disponible.', 'error');
      return;
    }
    console.log('Manual retry invoked');
    // Show immediate feedback and start the attempt
    setNotification({ message: `${retryRef.current.lastErrMsg || 'Error al procesar la compra'}. Reintentando...`, type: 'error' });
    setIsProcessingBuy(true);
    try {
      await retryRef.current.attempt();
    } catch (e) {
      console.log('Manual retry attempt failed', e);
      // If it fails, attempt() will schedule the countdown and persistent notification
    } finally {
      setIsProcessingBuy(false);
    }
  };

  const updateCurrentTabCart = (updater) => setCurrentTabCart(prev => updater(prev));

  const [error, setError] = useState(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [notification, setNotification] = useState({ message: '', type: '' });
  const [isProcessingBuy, setIsProcessingBuy] = useState(false);
  const [appSettings, setAppSettings] = useState({ dolarBCV: 0, dolarParalelo: 0 });

  const userInteractedRef = useRef(false); // evita sobreescritura tras interacción manual
  const markUserInteracted = () => {
    if (!userInteractedRef.current) {
      userInteractedRef.current = true;
    }
  };
  const loadedFromCacheRef = useRef(false);
  const [lastLoadInfo, setLastLoadInfo] = useState({ quickKey: null, finalKey: null, persistedAt: null });
  const [parsedQuickPayload, setParsedQuickPayload] = useState(null);
  const [parsedFinalPayload, setParsedFinalPayload] = useState(null);

  const makeCacheKeys = () => {
    const keys = [];
    if (user?.uid) keys.push(`buys:state:${user.uid}`);
    keys.push('buys:state:anon');
    return keys;
  };

  useEffect(() => {
    setAppSettings({ dolarBCV: Number(settings.dolarBCV) || 0, dolarParalelo: Number(settings.dolarParalelo) || 0 });
  }, [settings]);

  // --- Versión mejorada de carga de cache en dos fases (idéntica a Cashier) ---
  // 1) carga rápida al montar para restaurar inmediatamente tras F5 (no depende de inventories)
  // 2) cuando inventories esté disponible, hacer reconciliación inteligente con stock y aplicar ajustes
  const quickLoadedRef = useRef(false);
  const notifiedLoadedRef = useRef(false);

  useEffect(() => {
    if (quickLoadedRef.current) return;
    try {
      // intentamos leer anon y user (si existe); priorizamos user si está presente
      const keys = [];
      if (user?.uid) keys.push(`buys:state:${user.uid}`);
      keys.push('buys:state:anon');

      let raw = null;
      let usedKey = null;
      for (const k of keys) {
        const r = localStorage.getItem(k);
        if (r) { raw = r; usedKey = k; break; }
      }
      if (!raw) { quickLoadedRef.current = true; return; }
  const parsed = JSON.parse(raw);
  const quickCount = Array.isArray(parsed.tabs) ? parsed.tabs.reduce((s, t) => s + ((t.cart && Array.isArray(t.cart)) ? t.cart.reduce((ss, it) => ss + (Number(it.quantity) || 0), 0) : 0), 0) : 0;
  setLastLoadInfo(prev => ({ ...prev, quickKey: usedKey || null, quickCount }));
      if (!parsed || !Array.isArray(parsed.tabs)) { quickLoadedRef.current = true; return; }

      // Normalizar/llenar tabs faltantes (asegura 9 pestañas con ids 1..9)
      const cachedTabs = Array.from({ length: 9 }, (_, i) => {
        const found = parsed.tabs.find(t => t.id === String(i+1));
        return found ? {
          id: String(i+1),
          name: String(i+1),
          cart: (found.cart || []).map(it => ({
            ...it,
            quantity: Number(it.quantity) || 0,
            cost: it.cost !== undefined ? Number(it.cost) : (it.baseCost !== undefined ? Number(it.baseCost) : 0),
            baseCost: it.baseCost !== undefined ? Number(it.baseCost) : (it.cost !== undefined ? Number(it.cost) : 0),
            costUsdAdjusted: it.costUsdAdjusted !== undefined ? Number(it.costUsdAdjusted) : undefined,
            costBs: it.costBs !== undefined ? Number(it.costBs) : undefined,
            costBsDecimals: it.costBsDecimals !== undefined ? Number(it.costBsDecimals) : undefined,
          })),
          customer: found.customer || { name: '', phone: '', id: '', address: '', notes: '' },
          paymentMethod: found.paymentMethod || ''
        } : { id: String(i+1), name: String(i+1), cart: [], customer: { name: '', phone: '', id: '', address: '', notes: '' }, paymentMethod: '' };
      });

      // Log parsed and normalized cached tabs for debugging quantities
      try {
        /* debug log removed */
      } catch (e) { /* ignore logging errors */ }
      // Aplicar inmediatamente los tabs recuperados para que la UI muestre la sesión restaurada
      setTabs(cachedTabs);

      // Mostrar notificación genérica si se restauraron items (evitar duplicados)
      if (!notifiedLoadedRef.current && quickCount > 0) {
        showNotification('Se cargaron los datos de la sesión anterior.', 'info', 5000);
        notifiedLoadedRef.current = true;
      }

      // Restaurar activeTabId (si viene en payload)
      if (parsed.activeTabId && typeof parsed.activeTabId === 'string') {
        setActiveTabId(parsed.activeTabId);
      }
      // Restaurar activeInventoryId si existe (no validamos aún contra inventories)
      if (parsed.activeInventoryId && typeof parsed.activeInventoryId === 'string') {
        setActiveInventoryId(parsed.activeInventoryId);
      }
    } catch (err) {
      console.warn('Error al cargar cache (rápido) de buys:', err);
    } finally {
      quickLoadedRef.current = true;
    }
  }, []);

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
  const finalCount = Array.isArray(parsed.tabs) ? parsed.tabs.reduce((s, t) => s + ((t.cart && Array.isArray(t.cart)) ? t.cart.reduce((ss, it) => ss + (Number(it.quantity) || 0), 0) : 0), 0) : 0;
  setLastLoadInfo(prev => ({ ...prev, finalKey: usedKey || null, finalCount }));
  if (!parsed || !Array.isArray(parsed.tabs)) { loadedFromCacheRef.current = true; return; }

  // Normalizar/llenar tabs faltantes (asegura 9 pestañas con ids 1..9)
      const cachedTabs = Array.from({ length: 9 }, (_, i) => {
        const found = parsed.tabs.find(t => t.id === String(i+1));
        return found ? {
          id: String(i+1),
          name: String(i+1),
          cart: (found.cart || []).map(it => ({
            ...it,
            quantity: Number(it.quantity) || 0,
            cost: it.cost !== undefined ? Number(it.cost) : (it.baseCost !== undefined ? Number(it.baseCost) : 0),
            baseCost: it.baseCost !== undefined ? Number(it.baseCost) : (it.cost !== undefined ? Number(it.cost) : 0),
            costUsdAdjusted: it.costUsdAdjusted !== undefined ? Number(it.costUsdAdjusted) : undefined,
            costBs: it.costBs !== undefined ? Number(it.costBs) : undefined,
            costBsDecimals: it.costBsDecimals !== undefined ? Number(it.costBsDecimals) : undefined,
          })),
          customer: found.customer || { name: '', phone: '', id: '', address: '', notes: '' },
          paymentMethod: found.paymentMethod || ''
        } : { id: String(i+1), name: String(i+1), cart: [], customer: { name: '', phone: '', id: '', address: '', notes: '' }, paymentMethod: '' };
      });

      // Restablecer activeInventoryId y activeTabId si son válidos
      if (parsed.activeInventoryId && inventories.some(i => i.id === parsed.activeInventoryId)) {
        setActiveInventoryId(parsed.activeInventoryId);
      } else if (!activeInventoryId) {
        setActiveInventoryId(inventories[0]?.id || null);
      }
      if (parsed.activeTabId && typeof parsed.activeTabId === 'string') setActiveTabId(parsed.activeTabId);

      // Reconcile quantities with stock similar to Cashier
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
          const invProducts = inv.products || {};
          // If the inventory doesn't contain this product id, skip adjustments
          // (do not assume missing === 0 stock; item may belong to another inventory)
          if (!(pid in invProducts)) continue;
          const totalStock = Number(invProducts[pid]?.quantity) || 0;
          const desiredActive = Number((activeTab.cart.find(i => i.docId === pid) || { quantity: 0 }).quantity) || 0;

          // If the inventory explicitly reports zero stock, be conservative and
          // do not force cached quantities to 0 during restore. The zero value
          // in the inventory may be stale or represent a different source of
          // truth; we'll rely on confirm-time remote validation instead.
          if (totalStock === 0) {
            // Inventory reports zero stock; skip aggressive adjustment during restore.
            continue;
          }

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

      const invIdToUse = parsed.activeInventoryId && inventories.some(i => i.id === parsed.activeInventoryId) ? parsed.activeInventoryId : (inventories[0]?.id || null);
      const { tabs: adjustedTabs, adjustments } = reconcileTabsWithStock(cachedTabs, invIdToUse);
      try {
        /* debug log removed */
      } catch (e) { /* ignore logging errors */ }
      setTabs(adjustedTabs);
      // Si no se notificó aún en la fase rápida, notificar ahora cuando haya items
      if (!notifiedLoadedRef.current && finalCount > 0) {
        showNotification('Se cargaron los datos de la sesión anterior.', 'info', 5000);
        notifiedLoadedRef.current = true;
      }
    } catch (err) {
      console.warn('Error al cargar cache de buys (reconciliación):', err);
    } finally {
      loadedFromCacheRef.current = true;
    }
  }, [inventories, user?.uid]);

  // Persist buys state when tabs/activeInventoryId/activeTabId change
  useEffect(() => {
    try {
      // Only persist after we've completed the quick-load OR the user has
      // interacted with the UI. This prevents an initial empty-state write
      // from clobbering an existing non-empty cached payload during mount
      // races or premature navigation.
      if (!quickLoadedRef.current && !userInteractedRef.current) return;

      // Extra protection: if the quick-loader reported a non-empty cached
      // payload (quickCount > 0) but our current tabs are empty and the
      // user hasn't interacted, skip saving to avoid overwriting valid cache.
      const currentCount = Array.isArray(tabs) ? tabs.reduce((s, t) => s + ((t.cart && Array.isArray(t.cart)) ? t.cart.reduce((ss, it) => ss + (Number(it.quantity) || 0), 0) : 0), 0) : 0;
      if (!userInteractedRef.current && lastLoadInfo.quickKey && (lastLoadInfo.quickCount || 0) > 0 && currentCount === 0) {
        return;
      }


  const payload = { tabs, activeInventoryId, activeTabId, savedAt: Date.now() };
  const s = JSON.stringify(payload);

  // Defensive: avoid overwriting a non-empty stored payload with an empty
  // local payload that could appear during a mount/unmount navigation race.
  const keysToCheck = [];
  if (user?.uid) keysToCheck.push(`buys:state:${user.uid}`);
  keysToCheck.push('buys:state:anon');

      let skip = false;
      // If our current state is empty and the user didn't interact, be conservative:
      // check existing stored payloads and avoid overwriting any non-empty stored state.
      if (currentCount === 0 && !userInteractedRef.current) {
        try {
          for (const k of keysToCheck) {
            const rawStored = localStorage.getItem(k);
            if (!rawStored) continue;
              try {
                const parsedStored = JSON.parse(rawStored);
                const storedCount = Array.isArray(parsedStored.tabs) ? parsedStored.tabs.reduce((s, t) => s + ((t.cart && Array.isArray(t.cart)) ? t.cart.reduce((ss, it) => ss + (Number(it.quantity) || 0), 0) : 0), 0) : 0;
                if (storedCount > 0) {
                  skip = true;
                  break;
                }
            } catch (e) {
              // ignore parse errors and continue
            }
          }
        } catch (e) {
          // if localStorage access fails, fall back to normal persist
        }
      }

      if (!skip) {
        if (user?.uid) localStorage.setItem(`buys:state:${user.uid}`, s);
        localStorage.setItem('buys:state:anon', s);
  setLastLoadInfo(prev => ({ ...prev, persistedAt: Date.now() }));
      }

      // minimal persist (same behavior as Cashier)
    } catch (err) {
      console.warn('No se pudo guardar cache de buys:', err);
    }
  }, [tabs, activeInventoryId, activeTabId, user?.uid]);

  useEffect(() => {
    if (!inventories.length) return;
    // Avoid overwriting if the user already changed the selector manually
    if (userInteractedRef.current) return;
    // separate localStorage key for Buys
    const lsKey = user?.uid ? `inventoryPickedBuys:${user.uid}` : null;

    (async () => {
      let candidate = null;

      // 1) Try remote saved pick for Buys (Firestore user doc)
      if (user?.uid) {
        try {
          let userSnap;
          try {
            userSnap = await getDocFromServer(doc(db, 'users', user.uid));
          } catch (_) {
            // fallback to cached getDoc if server read fails
            userSnap = await getDoc(doc(db, 'users', user.uid));
          }
          if (userSnap && userSnap.exists()) {
            const data = userSnap.data() || {};
            const picked = data.inventoryPickedBuys;
            if (picked && inventories.some(i => i.id === picked)) {
              candidate = picked;
            }
          }
        } catch (e) {
          // ignore failures and continue to fallbacks
        }
      }

      // 2) fallback: initial prop passed from root
      if (!candidate && initialActiveInventoryId && inventories.some(i => i.id === initialActiveInventoryId)) {
        candidate = initialActiveInventoryId;
      }

      // 3) fallback: localStorage
      if (!candidate && lsKey) {
        const lsVal = localStorage.getItem(lsKey);
        if (lsVal && inventories.some(i => i.id === lsVal)) candidate = lsVal;
      }

      // 4) fallback: current state
      if (!candidate && activeInventoryId && inventories.some(i => i.id === activeInventoryId)) candidate = activeInventoryId;

      // 5) final fallback: first available inventory
      if (!candidate) candidate = inventories[0].id;

      if (candidate !== activeInventoryId) setActiveInventoryId(candidate);
    })();
  }, [inventories, initialActiveInventoryId, activeInventoryId, user]);

  // NORMALIZAR / DEDUPLICAR ENTRADAS ANTIGUAS por cada pestaña (igual que Cashier)
  useEffect(() => {
    setTabs(prevTabs => prevTabs.map(tab => {
      const map = {};
      let changed = false;
      for (const item of tab.cart) {
        const key = item.docId || item.id;
        try {
          /* debug log removed */
        } catch (e) {}
        if (map[key]) {
          map[key].quantity += Number(item.quantity) || 0;
          changed = true;
        } else {
          map[key] = { ...item, docId: key, quantity: Number(item.quantity) || 0 };
        }
      }
      return changed ? { ...tab, cart: Object.values(map) } : tab;
    }));
  }, []);

  const showNotification = (message, type = 'error', duration = 4000) => {
    setNotification({ message, type });
    window.clearTimeout(showNotification._t);
    showNotification._t = window.setTimeout(() => setNotification({ message: '', type: '' }), duration);
  };

  // Enhanced persistent notification + retry manager
  const retryRef = useRef({ timer: null, running: false, resolve: null, reject: null });
  const lastOperationRef = useRef(null);

  const clearRetry = () => {
    try { if (retryRef.current.timer) clearInterval(retryRef.current.timer); } catch (e) {}
    retryRef.current = { timer: null, running: false, resolve: null, reject: null };
  };

  const showErrorWithRetry = (errMsg, operationFn, autoSeconds = 30) => {
    // If already retrying, ignore
    if (retryRef.current.running) return;
    let seconds = autoSeconds;
    retryRef.current.running = true;

    // remember the last operation so manual retry can call it even if attempt ref is missing
    lastOperationRef.current = operationFn;

    const attempt = async () => {
      try {
        const fn = lastOperationRef.current || operationFn;
        const res = await fn();
        // success: clear notification and timers
        clearRetry();
        setNotification({ message: 'Operación completada correctamente.', type: 'success' });
        return res;
      } catch (err) {
        console.error('Retry operation failed:', err);
  // show persistent short notification; controls will be on the buy button area
  setNotification({ message: `${errMsg}. Reintentando...`, type: 'error', retryCountdown: seconds, persistent: true });
  // expose attempt so UI can trigger it manually
  retryRef.current.attempt = attempt;
  retryRef.current.lastErrMsg = errMsg;
        // start countdown
        try { if (retryRef.current.timer) clearInterval(retryRef.current.timer); } catch (e) {}
        retryRef.current.timer = setInterval(async () => {
          seconds -= 1;
          setNotification(prev => prev ? { ...prev, retryCountdown: seconds } : prev);
          if (seconds <= 0) {
            try { clearInterval(retryRef.current.timer); } catch (e) {}
            // auto try again
            seconds = autoSeconds; // reset for next round if fails again
            try { await attempt(); } catch (e) { /* will reenter catch and restart timer */ }
          }
        }, 1000);
        throw err;
      }
    };

    // expose attempt immediately so manual retry is available even while first attempt runs
    retryRef.current.attempt = attempt;
    retryRef.current.lastErrMsg = errMsg;

    // start first attempt
    return attempt();
  };

  const handleInventoryChange = async (newInventoryId) => {
    if (newInventoryId === activeInventoryId) return;
    userInteractedRef.current = true;
    setActiveInventoryId(newInventoryId);
    const lsKey = user?.uid ? `inventoryPickedBuys:${user.uid}` : null;
    if (lsKey) localStorage.setItem(lsKey, newInventoryId);
    if (user?.uid) {
      try {
        // persist the picked inventory for Buys under a distinct field
        await setDoc(doc(db, 'users', user.uid), { inventoryPickedBuys: newInventoryId }, { merge: true });
      } catch {
        showNotification("No se pudo guardar la selección de inventario.", 'error');
      }
    }
  };

  // Price editing helpers (work with USD-adjusted like in Cashier)
  const [priceEditMap, setPriceEditMap] = useState({});
  const commitPriceEdit = (docId) => {
    const raw = priceEditMap[docId];
    if (raw === undefined) return;
    // apply locally only; persist to product doc happens when the buy is confirmed
    handleAdjustedCostChange(docId, raw);
    setPriceEditMap(prev => { const next = { ...prev }; delete next[docId]; return next; });
  };

  const handleAddProductToCart = (product, quantity = 1) => {
    markUserInteracted();
    const key = product.docId || product.id;
    if (!key) return;
    updateCurrentTabCart(prev => {
      const existing = prev.find(i => (i.docId || i.id) === key);
      if (existing) {
        return prev.map(i => (i.docId || i.id) === key ? { ...i, docId: key, quantity: i.quantity + quantity } : i);
      }

      const costUsd = Number(product.cost ?? product.price ?? 0);
      const unit = calculateAmounts(costUsd, appSettings.dolarBCV, appSettings.dolarParalelo);
      const roundedCostUsd = Number(costUsd.toFixed(2));
      return [...prev, {
        ...product,
        docId: key,
        quantity,
        baseCost: costUsd,
        cost: roundedCostUsd,
        costUsdAdjusted: Number((unit.usdAdjusted || 0).toFixed(2)),
        costBs: unit.bs,
        costBsDecimals: unit.bsDecimals,
        customCost: false
      }];
    });
  };

  const handleRemoveProductFromCart = (productDocId) => {
    markUserInteracted();
    setCurrentTabCart(curr => curr.filter(i => i.docId !== productDocId));
  };

  const handleQuantityChange = (productDocId, newQuantity) => {
    const q = newQuantity === '' ? 0 : Number(newQuantity);
    if (!Number.isFinite(q) || q < 0) return;
    markUserInteracted();
    setCurrentTabCart(curr => curr.map(i => i.docId === productDocId ? { ...i, quantity: q } : i));
  };

  // change unit cost (USD)
  const handleUnitCostChange = (docId, raw) => {
    const cleaned = String(raw).replace(',', '.').trim();
    const num = cleaned === '' ? 0 : parseFloat(cleaned);
    if (cleaned !== '' && (!Number.isFinite(num) || num < 0)) return;
    markUserInteracted();
    setCurrentTabCart(curr => curr.map(i => {
      if (i.docId !== docId) return i;
      const newCost = cleaned === '' ? 0 : num;
      const unit = calculateAmounts(newCost, appSettings.dolarBCV, appSettings.dolarParalelo);
      return {
        ...i,
        cost: newCost,
        customCost: true,
        costBs: unit.bs,
        costUsdAdjusted: unit.usdAdjusted,
        costBsDecimals: unit.bsDecimals
      };
    }));
  };

  // edit the USD adjusted visible value -> recalc internal cost
  const handleAdjustedCostChange = (docId, raw) => {
    const cleaned = String(raw).replace(',', '.').trim();
    const num = cleaned === '' ? 0 : parseFloat(cleaned);
    if (cleaned !== '' && (!Number.isFinite(num) || num < 0)) return;
    const bcv = Number(appSettings.dolarBCV) || 1;
    const par = Number(appSettings.dolarParalelo) || 1;
    markUserInteracted();
    setCurrentTabCart(curr => curr.map(i => {
      if (i.docId !== docId) return i;
      // Do NOT adapt the entered value: store the cost exactly as the user typed
      // and mark it custom. This keeps the raw USD value untouched for Buys.
      const newUsdAdjusted = cleaned === '' ? 0 : num;
      const unit = calculateAmounts(newUsdAdjusted, bcv, par);
      return {
        ...i,
        cost: newUsdAdjusted,
        costUsdAdjusted: newUsdAdjusted,
        costBs: unit.bs,
        costBsDecimals: unit.bsDecimals,
        customCost: true
      };
    }));
  };

  const resetUnitCost = (docId) => {
    markUserInteracted();
    setCurrentTabCart(curr => curr.map(i => {
      if (i.docId !== docId) return i;
      const base = i.baseCost ?? i.cost ?? 0;
      const baseRounded = Number(Number(base).toFixed(2));
      const unit = calculateAmounts(baseRounded, appSettings.dolarBCV, appSettings.dolarParalelo);
      return {
        ...i,
        cost: baseRounded,
        customCost: false,
        costUsdAdjusted: Number(unit.usdAdjusted.toFixed(2)),
        costBs: unit.bs,
        costBsDecimals: unit.bsDecimals
      };
    }));
  };

  const cartTotal = useMemo(() => cart.reduce((t, i) => t + (Number(i.cost || 0) * Number(i.quantity || 0)), 0), [cart]);
  const totals = useMemo(() => {
    const calc = (usd) => calculateAmounts(usd, appSettings.dolarBCV, appSettings.dolarParalelo);
    const totalsFromUsd = calc(cartTotal);
    const sumBs = cart.reduce((s, item) => {
      const subtotalUSD = (Number(item.cost) || 0) * (Number(item.quantity) || 0);
      const sub = calc(subtotalUSD);
      return s + (Number(sub.bs) || 0);
    }, 0);
    const sumBsDecimals = cart.reduce((s, item) => {
      const subtotalUSD = (Number(item.cost) || 0) * (Number(item.quantity) || 0);
      const sub = calc(subtotalUSD);
      return s + (Number(sub.bsDecimals) || 0);
    }, 0);
    return { ...totalsFromUsd, bs: sumBs, bsDecimals: sumBsDecimals };
  }, [cart, cartTotal, appSettings.dolarBCV, appSettings.dolarParalelo]);

  const incrementQuantity = (docId) => {
    const item = cart.find(i => i.docId === docId);
    if (!item) return;
    handleQuantityChange(docId, item.quantity + 1);
  };
  const decrementQuantity = (docId) => {
    const item = cart.find(i => i.docId === docId);
    if (!item) return;
    const next = item.quantity - 1;
    if (next <= 0) handleRemoveProductFromCart(docId); else handleQuantityChange(docId, next);
  };

  const handleConfirmBuy = async () => {
    if (cart.length === 0) { showNotification('El carrito está vacío.', 'error'); return; }
    if (!activeInventoryId) { showNotification('No hay un inventario seleccionado.', 'error'); return; }

  setIsProcessingBuy(true);
  const inventoryDocRef = doc(db, 'inventories', activeInventoryId);
  let operationFn = null;
  try {
      // --- VALIDACIÓN PREVIA (usar cache cuando sea posible) ---
      // Recolectar cantidades desde cache
      const cachedInv = inventories.find(i => i.id === activeInventoryId) || null;
      let needRemoteCheck = false;
      const diffs = [];
      for (const item of cart) {
        const cachedQty = Number(cachedInv?.products?.[item.docId]?.quantity) || 0;
        // Si el item tiene originalStock (fue añadido desde un modal con stock) y difiere del cache => posible desincronía
        if (item.originalStock !== undefined && Number(item.originalStock) !== cachedQty) {
          needRemoteCheck = true; break;
        }
        // Si no tenemos cached entry (0) pero cart tiene cantidad -> verificar remoto
        if (!cachedInv?.products || !(item.docId in (cachedInv.products || {}))) {
          needRemoteCheck = true; break;
        }
      }

      if (needRemoteCheck) {
        try {
          const remoteSnap = await getDoc(inventoryDocRef);
          if (remoteSnap.exists()) {
            const remote = remoteSnap.data() || {};
            const remoteProducts = remote.products || {};
            for (const item of cart) {
              const cachedQty = Number(cachedInv?.products?.[item.docId]?.quantity) || 0;
              const remoteQty = Number(remoteProducts?.[item.docId]?.quantity) || 0;
              if (cachedQty !== remoteQty) {
                diffs.push({ docId: item.docId, name: item.name, cachedQty, remoteQty });
              }
            }
          }
        } catch (e) {
          console.warn('No se pudo leer inventario remoto para validación previa:', e);
        }
      }

      if (diffs.length) {
        // Mostrar resumen y pedir confirmación
        const lines = diffs.map(d => `${d.name || d.docId}: cache=${d.cachedQty} remoto=${d.remoteQty}`);
        const msg = `El inventario remoto difiere del cache para algunos productos:\n${lines.join('\n')}\n\n¿Deseas continuar de todos modos?`;
        if (!window.confirm(msg)) {
          showNotification('Compra cancelada por discrepancias de inventario.', 'error');
          setIsProcessingBuy(false);
          return;
        }
      }

      // Build updates: increment quantities (se aplica con increment, evita lectura extra)
      const updates = {};
      for (const item of cart) {
        updates[`products.${item.docId}.quantity`] = increment(Number(item.quantity || 0));
      }

  // Prepare remote operation as a retriable function
      const buyId = `buy_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
      const to2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
      const items = cart.map(item => {
        const unit = calculateAmounts(item.cost, appSettings.dolarBCV, appSettings.dolarParalelo);
        const subtotalUSD = Number(item.cost || 0) * Number(item.quantity || 0);
        const sub = calculateAmounts(subtotalUSD, appSettings.dolarBCV, appSettings.dolarParalelo);
        return {
          productDocId: item.docId,
          productId: item.id ?? null,
          name: item.name,
          quantity: item.quantity,
          unitCostUSD: to2(item.cost),
          ratesUsed: { bcv: to2(appSettings.dolarBCV), paralelo: to2(appSettings.dolarParalelo) },
          unitCostBs: Math.max(0, Math.round(unit.bs)),
          unitCostUsdAdjusted: to2(unit.usdAdjusted),
          subtotalBs: Math.max(0, Math.round(sub.bs)),
          subtotalUsdAdjusted: to2(sub.usdAdjusted),
        };
      });

      const totalsCalc = calculateAmounts(cartTotal, appSettings.dolarBCV, appSettings.dolarParalelo);
      const activeInventoryName = inventories.find(i => i.id === activeInventoryId)?.name || '';

      operationFn = async () => {
        // Persist custom costs into product docs so the product's cost is replaced
        // by the cost used in this buy when the user confirmed the purchase.
        for (const item of cart) {
          if (!item || !item.docId) continue;
          if (item.customCost || (item.baseCost !== undefined && Number(item.baseCost) !== Number(item.cost))) {
            // update product doc; allow failure to bubble so the retry manager can handle it
            await updateDoc(doc(db, 'products', item.docId), { cost: Number(item.cost || 0), updatedAt: serverTimestamp() });
          }
        }
        // update inventory counts
        await updateDoc(inventoryDocRef, updates);
        // Note: Buys should not persist product canonical costs here. Keep product
        // cost unmodified by Buys flows. (Cashier handles canonical cost updates.)
        // write history
        await setDoc(doc(db, 'history', 'main', 'buys', buyId), {
          id: buyId,
          boughtAt: serverTimestamp(),
          boughtAtISO: new Date().toISOString(),
          userId: user?.uid || null,
          inventoryId: activeInventoryId,
          inventoryName: activeInventoryName,
          items,
          totals: {
            bs: Math.max(0, Math.round(totalsCalc.bs)),
            usdAdjusted: to2(totalsCalc.usdAdjusted),
            usdInt: Math.max(0, Math.floor(totalsCalc.usdInt)),
            bsDecimals: Math.max(0, Math.round(totalsCalc.bsDecimals)),
          },
          ratesUsed: { bcv: to2(appSettings.dolarBCV), paralelo: to2(appSettings.dolarParalelo) },
          summary: { itemCount: cart.reduce((n, i) => n + i.quantity, 0), productLines: cart.length }
        });
      };

      // Try the operation once now; if it fails we'll trigger the retry manager in catch
      await operationFn();

      showNotification('Compra registrada con éxito.', 'success');
  markUserInteracted();
  setCurrentTabCart([]);
    } catch (err) {
      console.error('Error al procesar la compra:', err);
      // If we have operationFn, start retry manager (do not override the whole UI error state)
      if (typeof operationFn === 'function') {
        showErrorWithRetry('Error al procesar la compra', operationFn, 30).catch(() => {});
      } else {
        setError(err?.message || 'No se pudo completar la compra.');
        showNotification(err?.message || 'No se pudo completar la compra.', 'error');
      }
    } finally {
      setIsProcessingBuy(false);
    }
  };

  return (
    <>
      {notification.message && (
        <div
          className={`app-toast app-toast-fixed ${notification.type}`}
          data-icon={notification.type === 'success' ? '✓' : notification.type === 'error' ? '✕' : 'ℹ'}
          role="status"
          aria-live="polite"
        >
          <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
            <div style={{ flex: 1 }}>{notification.message}{notification.retryCountdown ? ` — Reintentando en ${notification.retryCountdown}s` : ''}</div>
          </div>
        </div>
      )}
      <section className="cashier-container">
        <article>
          <header>
            <div className="cashier-header">
              <h2>Compras</h2>
              {/* lastLoadInfo debug removed to match Cashier UI */}
              {/* cache debug removed to match Cashier behaviour */}
              <div className="tabs-row" role="tablist" aria-label="Pestañas de compras">
                {tabs.map(t => (
                  <button key={t.id} role="tab" aria-selected={t.id === activeTabId} className={`tab-btn${t.id === activeTabId ? ' active' : ''}`} onClick={() => setActiveTabId(t.id)}>{t.name}</button>
                ))}
              </div>

              <div className="inventory-selector-wrapper">
                <label htmlFor="buys-inventory-select">Inventario:</label>
                <select id="buys-inventory-select" value={activeInventoryId || ''} onChange={(e) => handleInventoryChange(e.target.value)} disabled={loading}>
                  {inventories.length === 0 && <option>Cargando...</option>}
                  {inventories.map(inv => (<option key={inv.id} value={inv.id}>{inv.name}</option>))}
                </select>
              </div>
            </div>
          </header>

          {loading && <p>Cargando productos...</p>}
          {error && <p style={{ color: 'var(--pico-color-red-500)' }}>{error}</p>}

          {!loading && !error && (
            <>
              <figure className="cart-area">
                <div className="cart-header-row">
                  <div>Producto</div>
                  <div>Costo</div>
                  <div>Cant.</div>
                  <div>Subtotal</div>
                  <div></div>
                </div>
                <div className="cart-body">
                  {cart.length === 0 && <div className="cart-empty">Añade productos para empezar una compra.</div>}
                  {cart.map(item => {
                    const unit = { bs: item.costBs ?? calculateAmounts(item.cost, appSettings.dolarBCV, appSettings.dolarParalelo).bs, usdAdjusted: item.costUsdAdjusted ?? calculateAmounts(item.cost, appSettings.dolarBCV, appSettings.dolarParalelo).usdAdjusted, bsDecimals: item.costBsDecimals ?? calculateAmounts(item.cost, appSettings.dolarBCV, appSettings.dolarParalelo).bsDecimals };
                    const subtotalUSD = Number(item.cost || 0) * Number(item.quantity || 0);
                    const sub = calculateAmounts(subtotalUSD, appSettings.dolarBCV, appSettings.dolarParalelo);
                    return (
                      <div className="cart-row" key={item.docId}>
                        <div className="cart-cell product" data-label="Producto">
                          <span className="cart-name">{item.name}</span>
                          {item.customCost && <small style={{ color: 'var(--c-accent)' }}>Costo personalizado</small>}
                        </div>
                        <div className="cart-cell price" data-label="Costo">
                          <div className="unit-price-row">
                            <label className="unit-price-editor">
                              <input type="text" inputMode="decimal" pattern="[0-9.,]*" value={ priceEditMap[item.docId] ?? (item.cost !== undefined && item.cost !== null ? String(Number(item.cost).toFixed(2)) : '') } onChange={(e) => setPriceEditMap(prev => ({ ...prev, [item.docId]: e.target.value }))} onBlur={() => commitPriceEdit(item.docId)} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); else if (e.key === 'Escape') setPriceEditMap(prev => { const next = { ...prev }; delete next[item.docId]; return next; }); }} aria-label={`Costo unitario USD de ${item.name}`} />
                              <span className="suffix">USD</span>
                              {item.customCost && item.baseCost !== item.cost && (
                                <button type="button" className="reset-price-btn" onClick={() => resetUnitCost(item.docId)} title="Restaurar costo original">↺</button>
                              )}
                            </label>
                          </div>
                          <small className="price-bs-hint">{ formatBs( calculateAmounts(item.cost, appSettings.dolarBCV, appSettings.dolarParalelo).bs ) }</small>
                        </div>
                        <div className="cart-cell quantity" data-label="Cant.">
                          <div className="qty-control" role="group" aria-label={`Cantidad de ${item.name}`}>
                            <button type="button" className="qty-icon" onClick={() => decrementQuantity(item.docId)} aria-label={`Restar 1 a ${item.name}`} disabled={item.quantity <= 1}>−</button>
                            <span className="qty-number" aria-live="polite">{item.quantity}</span>
                            <button type="button" className="qty-icon" onClick={() => incrementQuantity(item.docId)} aria-label={`Sumar 1 a ${item.name}`}>+</button>
                          </div>
                        </div>
                        <div className="cart-cell subtotal" data-label="Subtotal">
                          <span>{formatBs(sub.bs)}</span>
                          <small>≈ {formatUSD(sub.usdAdjusted)}</small>
                        </div>
                        <div className="cart-cell remove">
                          <button onClick={() => handleRemoveProductFromCart(item.docId)} className="remove-btn" aria-label={`Eliminar ${item.name}`}>&times;</button>
                        </div>
                      </div>
                    );
                  })}
                </div>
                {cart.length > 0 && (
                  <div className="cart-footer">
                    <div className="totals-block">
                      <div className="totals-line"><span>Total</span><strong>{formatBs(totals.bs)}</strong></div>
                      <div className="totals-line alt">≈ {formatUSD(totals.usdAdjusted)}</div>
                      <div className="totals-line alt">Mixto: ${totals.usdInt} y {formatBs(totals.bsDecimals)}</div>
                    </div>
                  </div>
                )}
              </figure>

              <section className="customer-form grid-form" aria-label="Compras acciones">
                <div className="group payment" aria-label="Compra">
                  <h3>Compra</h3>
                  <div className="payment-fields">
                    {cart.length > 0 && (
                      <>
                        {!retryRef.current.running ? (
                          <>
                            <button className="confirm-btn" onClick={() => handleConfirmBuy()} disabled={isProcessingBuy} aria-busy={isProcessingBuy}>{isProcessingBuy ? 'Procesando...' : 'Confirmar Compra'}</button>
                          </>
                        ) : (
                          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                            <button className="confirm-btn" onClick={handleManualRetry} disabled={isProcessingBuy} aria-busy={isProcessingBuy}>{isProcessingBuy ? 'Procesando...' : 'Reintentar ahora'}</button>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </section>
            </>
          )}
        </article>
      </section>

      <AddProductButton onClick={() => setIsModalOpen(true)} />

      <ProductSearchModal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} onAddProduct={handleAddProductToCart} allProducts={products} inventories={inventories} activeInventoryId={activeInventoryId} onInventoryChange={handleInventoryChange} appSettings={appSettings} cart={cart} reservedMap={{}} />
    </>
  );
}

export default Buys;
