import React, { useState, useMemo, useEffect, useRef } from 'react';
import { smartSearch } from '../../utils/smartSearch.js';
import { doc, setDoc, serverTimestamp, updateDoc, increment, runTransaction, getDoc, collection, getDocs, query, where, limit, onSnapshot, writeBatch } from 'firebase/firestore';
import QtyButton from '../UI/QtyButton';
import { db } from '../../firebase.js';
import { useData } from '../../context/DataProvider.jsx';
import ProductSearchModal from './ProductSearchModal/ProductSearchModal.js';
import ImageViewerModal from '../ImageViewerModal/ImageViewerModal';
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

    // Cleanup for any pending notice timeout to avoid setting state after unmount
    React.useEffect(() => {
        return () => {
            try { if (showNotification._t) clearTimeout(showNotification._t); } catch (e) { }
        };
    }, []);

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
    const [showPreferences, setShowPreferences] = useState(false);
    // Default prefs are OFF when not present in DB/localStorage
    const [prefUseSmartProductSearch, setPrefUseSmartProductSearch] = useState(false);
    // NOTE: Pref stored under users/{uid}.prefs.noAutoCloseAfterAdd represents the
    // "Do NOT auto-close after add" flag. Checkbox true => do NOT auto-close (modal stays open).
    // For backward compatibility we also read the older key `prefs.autoCloseAfterAdd`.
    // Missing/undefined => OFF => modal WILL auto-close after add.
    const [prefDoNotAutoCloseAfterAdd, setPrefDoNotAutoCloseAfterAdd] = useState(false);

    // load persisted pref on mount / when user changes
    useEffect(() => {
        let mounted = true;
        const load = async () => {
            try {
                if (user?.uid) {
                    const snap = await getDoc(doc(db, 'users', user.uid));
                    if (!mounted) return;
                    const data = snap.exists() ? snap.data() : {};
                    const prefs = data.prefs || {};
                    // Only enable when explicit true in prefs; missing/undefined => remain false
                    if (prefs && prefs.useSmartProductSearch === true) setPrefUseSmartProductSearch(true);
                    if (typeof prefs.useSmartProductSearch === 'boolean' && typeof prefs.useSmartProductSearch !== 'undefined') {
                        // noop (already handled)
                    }
                    // Only enable when explicit true in prefs; missing/undefined => remain false
                    // Prefer the new clearer key `noAutoCloseAfterAdd`. Fall back to old key if needed.
                    if (prefs && prefs.noAutoCloseAfterAdd === true) setPrefDoNotAutoCloseAfterAdd(true);
                    else if (prefs && prefs.autoCloseAfterAdd === true) setPrefDoNotAutoCloseAfterAdd(true);
                } else {
                    const raw = localStorage.getItem('prefs:useSmartProductSearch');
                    if (raw !== null) setPrefUseSmartProductSearch(raw === '1');
                    // Prefer new localStorage key, fallback to old key for compatibility
                    const raw2 = localStorage.getItem('prefs:noAutoCloseAfterAdd');
                    if (raw2 !== null) setPrefDoNotAutoCloseAfterAdd(raw2 === '1');
                    else {
                        const rawOld = localStorage.getItem('prefs:autoCloseAfterAdd');
                        if (rawOld !== null) setPrefDoNotAutoCloseAfterAdd(rawOld === '1');
                    }
                }
            } catch (e) {
                // ignore
            }
        };
        load();
        return () => { mounted = false; };
    }, [user?.uid]);
    const [notification, setNotification] = useState({ message: '', type: '' });
    const [isProcessingSale, setIsProcessingSale] = useState(false);
    const [viewerOpen, setViewerOpen] = useState(false);
    const [viewerSrc, setViewerSrc] = useState(null);
    // Sugerencias de cliente (autocompletar por cédula/nombre)
    const [customerSuggestions, setCustomerSuggestions] = useState([]);
    const custSearchTimerRef = useRef(null);
    // Caché local de clientes (map cedula -> cliente)
    const customersCacheRef = useRef(new Map());
    const customersCacheLoadedRef = useRef(false);
    const [customersList, setCustomersList] = useState([]);
    const [customersFilter, setCustomersFilter] = useState('');
    const [selectedCustomerCedula, setSelectedCustomerCedula] = useState(null);
    const [filterSource, setFilterSource] = useState(null); // 'name'|'id'|'panel'|null
    const [panelActiveIndex, setPanelActiveIndex] = useState(-1); // keyboard navigation index
    const customersListContainerRef = useRef(null);
    // UI state for customers panel
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

    // Normalize cedula intelligently: keep leading letter prefix (e.g., V, E) and strip
    // punctuation/spacing from the numeric part. Examples:
    //  "26.396.806" -> "26396806"
    //  "V-12.345.678" -> "V12345678"
    const normalizeCedula = (s) => {
        const raw = String(s || '').trim();
        if (!raw) return '';
        // extract leading letters (if any)
        const prefixMatch = raw.match(/^\s*([A-Za-z]+)\s*[-:\/]?\s*/);
        const prefix = prefixMatch ? prefixMatch[1].toUpperCase() : '';
        // extract all digits
        const digits = raw.replace(/[^0-9]/g, '');
        if (prefix) return `${prefix}${digits}`;
        return digits || raw.toUpperCase().replace(/\s+/g, '');
    };

    // Title-case a full name (preserve accents, handle extra spaces)
    const titleCaseName = (v) => {
        if (!v) return '';
        return String(v).trim().replace(/\s+/g, ' ').split(' ').map(w => {
            const lower = w.toLowerCase();
            return lower.charAt(0).toUpperCase() + lower.slice(1);
        }).join(' ');
    };

    // sanitize customer data we keep locally / show in panel
    const sanitizeCustomer = (id, data) => {
        const src = data || {};
        const rawCed = String(src.cedula || src.id || id || '');
        const ced = normalizeCedula(rawCed);
        const name = titleCaseName(src.name || '');
        return {
            id: id || ced,
            cedula: ced,
            name: name,
            phone: src.phone || '',
            address: src.address || '',
            name_lower: (name || '').toLowerCase()
            // intentionally omit notes and any paymentMethod or other sensitive fields
        };
    };

    // Upsert a sanitized customer into local cache + localStorage and update visible list
    const upsertCustomerToLocalCache = (cust) => {
        try {
            if (!cust) return;
            const ced = normalizeCedula(cust.cedula || cust.id || cust.id || '');
            if (!ced) return;
            const obj = sanitizeCustomer(ced, { ...cust, cedula: ced });
            const m = customersCacheRef.current || new Map();
            m.set(ced, obj);
            customersCacheRef.current = m;
            customersCacheLoadedRef.current = true;
            const arrVals = Array.from(m.values()).map(v => ({ ...v }));
            try { localStorage.setItem('customers:cache_v1', JSON.stringify(arrVals)); } catch (e) { }
            // update visible list (keep sorted by name)
            setCustomersList(Array.from(m.values()).sort((a, b) => (a.name || '').localeCompare(b.name || '')).slice(0, 1000));
        } catch (e) {
            console.debug('upsertCustomerToLocalCache error', e);
        }
    };

    // Temporary: import customers from history (reads history/main/sells and upserts any customer that has BOTH cedula and name)
    const [importingHistory, setImportingHistory] = useState(false);
    const importCustomersFromHistory = async () => {
        if (importingHistory) return;
        setImportingHistory(true);
        try {
            const collRef = collection(db, 'history', 'main', 'sells');
            const snaps = await getDocs(collRef);
            const m = customersCacheRef.current || new Map();
            let added = 0, updated = 0, skipped = 0;
            const toWrite = new Map();
            for (const d of snaps.docs) {
                try {
                    const sale = d.data();
                    const c = sale?.customer;
                    // require both cedula and name (other fields optional)
                    if (!c) { skipped++; continue; }
                    const rawCed = String(c.id || c.cedula || '').trim();
                    const ced = normalizeCedula(rawCed);
                    if (!ced) { skipped++; continue; }
                    const rawName = String(c.name || '').trim();
                    if (!rawName) { skipped++; continue; }
                    const name = titleCaseName(rawName);
                    const phone = c.phone || '';
                    const address = c.address || '';
                    const existing = m.get(ced);
                    const payload = { name, phone, address, cedula: ced, name_lower: (name || '').toLowerCase() };
                    if (existing) {
                        if (existing.name === name && existing.phone === phone && existing.address === address) {
                            skipped++;
                            continue;
                        } else {
                            toWrite.set(ced, payload);
                            updated++;
                        }
                    } else {
                        toWrite.set(ced, payload);
                        added++;
                    }
                } catch (e) {
                    skipped++;
                }
            }

            // batch write to Firestore in chunks
            try {
                const entries = Array.from(toWrite.entries());
                const chunkSize = 450; // safe below 500
                for (let i = 0; i < entries.length; i += chunkSize) {
                    const chunk = entries.slice(i, i + chunkSize);
                    const batch = writeBatch(db);
                    for (const [ced, payload] of chunk) {
                        const r = doc(db, 'customers', ced);
                        batch.set(r, payload, { merge: true });
                    }
                    await batch.commit();
                }
            } catch (e) {
                console.error('Error escribiendo clientes en Firestore:', e);
                showNotification('No se pudo guardar algunos clientes en Firestore. Revisa la consola.', 'error');
            }

            // update local cache and UI
            for (const [ced, payload] of toWrite.entries()) {
                m.set(ced, { id: ced, cedula: ced, name: payload.name, phone: payload.phone, address: payload.address, name_lower: payload.name_lower });
            }
            customersCacheRef.current = m;
            try { localStorage.setItem('customers:cache_v1', JSON.stringify(Array.from(m.values()))); } catch (e) { }
            setCustomersList(Array.from(m.values()).sort((a, b) => (a.name || '').localeCompare(b.name || '')).slice(0, 1000));
            showNotification(`Importación completada: ${added} nuevos, ${updated} actualizados, ${skipped} omitidos.`, 'success', 6000);
        } catch (err) {
            console.error('Error importando clientes desde historial:', err);
            showNotification('No se pudo importar clientes desde historial. Revisa la consola.', 'error');
        } finally {
            setImportingHistory(false);
        }
    };

    // Buscar clientes cuando cambia la cédula o el nombre (debounce)
    useEffect(() => {
        // Only attach real-time listener when we have an authenticated user (rules require it).
        // Restore cache from localStorage for instant results regardless.
        try {
            const raw = localStorage.getItem('customers:cache_v1');
            if (raw) {
                const arr = JSON.parse(raw);
                if (Array.isArray(arr)) {
                    const m = new Map();
                    for (const c of arr) {
                        const ced = String(c.cedula || c.id || c.document || '').toUpperCase();
                        const obj = sanitizeCustomer(c.id || ced, c);
                        m.set(ced, obj);
                    }
                    customersCacheRef.current = m;
                    customersCacheLoadedRef.current = true;
                    // populate list state
                    setCustomersList(Array.from(m.values()).sort((a, b) => (a.name || '').localeCompare(b.name || '')).slice(0, 1000));
                }
            }
        } catch (e) {
            customersCacheLoadedRef.current = false;
        }

        if (!user?.uid) {
            // do not attempt real-time listener if not signed in (avoids permission errors)
            return;
        }

        let warnedSnapshotError = false;
        const coll = collection(db, 'customers');
        const unsub = onSnapshot(coll, (snap) => {
            try {
                const m = customersCacheRef.current || new Map();
                for (const d of snap.docChanges()) {
                    const id = d.doc.id;
                    const data = d.doc.data();
                    if (d.type === 'removed') {
                        m.delete(id);
                    } else {
                        const ced = String(data.cedula || data.id || id || '').toUpperCase();
                        const obj = sanitizeCustomer(id, data);
                        m.set(ced, obj);
                    }
                }
                customersCacheRef.current = m;
                customersCacheLoadedRef.current = true;
                const arrVals = Array.from(m.values()).map(v => ({ ...v }));
                try { localStorage.setItem('customers:cache_v1', JSON.stringify(arrVals)); } catch (e) { }
                // update visible list
                setCustomersList(Array.from(m.values()).sort((a, b) => (a.name || '').localeCompare(b.name || '')).slice(0, 1000));
            } catch (e) {
                if (!warnedSnapshotError) {
                    console.debug('customers onSnapshot error', e);
                    warnedSnapshotError = true;
                }
            }
        }, (err) => {
            // Likely permission denied; log once and proceed without real-time sync
            if (!warnedSnapshotError) {
                console.debug('customers onSnapshot failed (probably insufficient permissions)', err?.message || err);
                warnedSnapshotError = true;
            }
        });

        return () => unsub();
    }, [user?.uid]);

    // Clear selection highlight if user edits the cedula and it no longer matches
    useEffect(() => {
        if (!selectedCustomerCedula) return;
        const activeCed = normalizeCedula(activeCustomer.id || '');
        if (activeCed !== selectedCustomerCedula) {
            setSelectedCustomerCedula(null);
        }
    }, [activeCustomer.id, selectedCustomerCedula]);

    // Compute filtered customers according to rules described by user
    const filteredCustomers = useMemo(() => {
        const qPanel = (customersFilter || '').trim().toLowerCase();
        const nameInput = (activeCustomer.name || '').trim().toLowerCase();
        const idInput = (activeCustomer.id || '').trim().toLowerCase();

        const all = customersList || [];

        // helper to match name or cedula
        const match = (c, q) => {
            if (!q) return true;
            const name = (c.name || '').toLowerCase();
            const ced = (c.cedula || c.id || '').toLowerCase();
            return name.includes(q) || ced.includes(q);
        };

        // Follow last-edited input (filterSource):
        // - if panel was last edited -> filter only by panel input
        // - if name or id was last edited -> filter by the combination of name and id inputs
        // - fallback: if no explicit source, prefer name/id if present, else panel
        const src = filterSource || (nameInput || idInput ? 'nameid' : (qPanel ? 'panel' : null));

        if (src === 'panel') {
            if (!qPanel) return all.slice(0, 1000);
            try {
                const res = smartSearch(all, qPanel, { keys: ['name', 'cedula'], nameKey: 'name', maxResults: 1000 });
                return res.map(r => r.item);
            } catch (e) {
                return all.filter(c => match(c, qPanel)).slice(0, 1000);
            }
        }

        // name/id combined mode
        if (src === 'name' || src === 'id' || src === 'nameid' || src === null) {
            // if neither name nor id provided, show all (or panel if explicit qPanel exists and no name/id)
            if (!nameInput && !idInput) {
                if (qPanel) return all.filter(c => match(c, qPanel)).slice(0, 1000);
                return all.slice(0, 1000);
            }
            // Combine name and id into one fuzzy query when both present
            try {
                const queryParts = [];
                if (nameInput) queryParts.push(nameInput);
                if (idInput) queryParts.push(idInput);
                const combinedQ = queryParts.join(' ');
                if (combinedQ) {
                    const res = smartSearch(all, combinedQ, { keys: ['name', 'cedula'], nameKey: 'name', maxResults: 1000 });
                    return res.map(r => r.item);
                }
                return all.slice(0, 1000);
            } catch (e) {
                return all.filter(c => {
                    const nameMatch = nameInput ? (c.name || '').toLowerCase().includes(nameInput) : true;
                    const idMatch = idInput ? (c.cedula || c.id || '').toLowerCase().includes(idInput) : true;
                    return nameMatch && idMatch;
                }).slice(0, 1000);
            }
        }

        return all.slice(0, 1000);
    }, [customersList, customersFilter, activeCustomer.name, activeCustomer.id, filterSource]);

    // Keep panelActiveIndex within bounds when filteredCustomers changes
    useEffect(() => {
        if (!filteredCustomers || filteredCustomers.length === 0) {
            setPanelActiveIndex(-1);
            return;
        }
        if (panelActiveIndex >= filteredCustomers.length) {
            setPanelActiveIndex(filteredCustomers.length - 1);
        }
    }, [filteredCustomers]);

    // When the active index changes, focus the corresponding item and scroll into view
    useEffect(() => {
        try {
            if (panelActiveIndex < 0) return;
            const container = customersListContainerRef.current;
            if (!container) return;
            const el = container.querySelector(`[data-index="${panelActiveIndex}"]`);
            if (el && typeof el.focus === 'function') {
                el.focus({ preventScroll: false });
                el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            }
        } catch (e) {
            // ignore
        }
    }, [panelActiveIndex]);

    const handleCustomersListKeyDown = (e) => {
        if (!filteredCustomers || filteredCustomers.length === 0) return;
        const max = filteredCustomers.length - 1;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setPanelActiveIndex(i => (i < 0 || i >= max) ? 0 : i + 1);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setPanelActiveIndex(i => (i <= 0) ? max : i - 1);
        } else if (e.key === 'Home') {
            e.preventDefault();
            setPanelActiveIndex(0);
        } else if (e.key === 'End') {
            e.preventDefault();
            setPanelActiveIndex(max);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (panelActiveIndex >= 0 && panelActiveIndex <= max) {
                const c = filteredCustomers[panelActiveIndex];
                if (c) {
                    const ced = String(c.cedula || c.id || '').toUpperCase();
                    setFilterSource('panel');
                    setSelectedCustomerCedula(ced);
                    selectCustomerSuggestion(c);
                }
            }
        } else if (e.key === 'Escape') {
            e.preventDefault();
            setPanelActiveIndex(-1);
            setSelectedCustomerCedula(null);
            setFilterSource(null);
        }
    };

    // Buscar clientes cuando cambia la cédula o el nombre (debounce) - ahora consulta caché primero
    useEffect(() => {
        if (custSearchTimerRef.current) { clearTimeout(custSearchTimerRef.current); custSearchTimerRef.current = null; }

        const ced = String(activeCustomer?.id || '').trim();
        const name = String(activeCustomer?.name || '').trim();

        if (!ced && !name) { setCustomerSuggestions([]); return; }

        custSearchTimerRef.current = setTimeout(async () => {
            try {
                const suggestions = [];
                const cacheMap = customersCacheRef.current || new Map();

                // 1) buscar en caché por cédula exacta
                if (ced) {
                    const normalized = normalizeCedula(ced);
                    const fromCache = cacheMap.get(normalized);
                    if (fromCache) {
                        setCustomerSuggestions([fromCache]);
                        return;
                    }
                }

                // 2) buscar en caché por nombre/cedula usando smartSearch (fuzzy tolerant)
                if ((name && name.length >= 1) && cacheMap.size > 0) {
                    try {
                        const arr = Array.from(cacheMap.values());
                        const results = smartSearch(arr, name, { keys: ['name', 'cedula'], nameKey: 'name', maxResults: 10 });
                        if (results && results.length) {
                            setCustomerSuggestions(results.map(r => r.item));
                            return;
                        }
                    } catch (e) {
                        // fallback to prefix if something goes wrong
                    }
                }

                // Si no hay resultados en caché, caer al fetch remoto (comportamiento previo)
                // 1) búsqueda por cédula exacta si hay cédula
                if (ced) {
                    const normalized = normalizeCedula(ced);
                    try {
                        const snap = await getDoc(doc(db, 'customers', normalized));
                        if (snap.exists()) suggestions.push(sanitizeCustomer(snap.id, snap.data()));
                    } catch (e) { }
                }

                // 2) búsqueda por nombre (prefijo) si nombre >= 2 chars
                if (name && name.length >= 2) {
                    const qLower = name.toLowerCase();
                    try {
                        const coll = collection(db, 'customers');
                        const q = query(coll, where('name_lower', '>=', qLower), where('name_lower', '<=', qLower + '\\uf8ff'), limit(10));
                        const snaps = await getDocs(q);
                        for (const s of snaps.docs) {
                            if (!suggestions.find(x => x.id === s.id)) suggestions.push(sanitizeCustomer(s.id, s.data()));
                        }
                    } catch (e) { }
                }

                setCustomerSuggestions(suggestions.slice(0, 10));
            } catch (err) {
                console.warn('Error buscando clientes:', err);
                setCustomerSuggestions([]);
            }
        }, 300);

        return () => { if (custSearchTimerRef.current) clearTimeout(custSearchTimerRef.current); };
    }, [activeCustomer?.id, activeCustomer?.name]);

    const selectCustomerSuggestion = (cust) => {
        // carga los datos atados a la cedula en la pestaña activa
        // IMPORTANT: do not load or save 'notes' or payment methods into customer records or form
        setActiveTabCustomer(prev => ({
            ...prev,
            name: titleCaseName(cust.name || ''),
            phone: cust.phone || '',
            id: normalizeCedula(cust.cedula || cust.id || cust.document || cust.dni || ''),
            address: cust.address || ''
            // keep prev.notes untouched (do not load cust.notes)
        }));
        // limpiar sugerencias
        setCustomerSuggestions([]);
    };

    // no autocomplete dropdown; panel-based selection only

    const userInteractedRef = useRef(false); // NUEVO: evita sobreescritura tras interacción del usuario

    // Enhanced persistent notification + retry manager (copied from Buys)
    const retryRef = useRef({ timer: null, running: false, resolve: null, reject: null });
    const lastOperationRef = useRef(null);

    const clearRetry = () => {
        try { if (retryRef.current.timer) clearInterval(retryRef.current.timer); } catch (e) { }
        retryRef.current = { timer: null, running: false, resolve: null, reject: null };
    };

    const showErrorWithRetry = (errMsg, operationFn, autoSeconds = 30) => {
        if (retryRef.current.running) return;
        let seconds = autoSeconds;
        retryRef.current.running = true;
        lastOperationRef.current = operationFn;

        const attempt = async () => {
            try {
                const fn = lastOperationRef.current || operationFn;
                const res = await fn();
                clearRetry();
                setNotification({ message: 'Operación completada correctamente.', type: 'success' });
                return res;
            } catch (err) {
                console.error('Retry operation failed:', err);
                setNotification({ message: `${errMsg}. Reintentando...`, type: 'error', retryCountdown: seconds, persistent: true });
                retryRef.current.attempt = attempt;
                retryRef.current.lastErrMsg = errMsg;
                try { if (retryRef.current.timer) clearInterval(retryRef.current.timer); } catch (e) { }
                retryRef.current.timer = setInterval(async () => {
                    seconds -= 1;
                    setNotification(prev => prev ? { ...prev, retryCountdown: seconds } : prev);
                    if (seconds <= 0) {
                        try { clearInterval(retryRef.current.timer); } catch (e) { }
                        seconds = autoSeconds;
                        try { await attempt(); } catch (e) { /* will reenter catch and restart timer */ }
                    }
                }, 1000);
                throw err;
            }
        };

        retryRef.current.attempt = attempt;
        retryRef.current.lastErrMsg = errMsg;
        return attempt();
    };

    const handleManualRetry = async () => {
        if (!retryRef.current || typeof retryRef.current.attempt !== 'function') {
            showNotification('No hay un reintento disponible.', 'error');
            return;
        }
        // Show immediate feedback and start the attempt
        setNotification({ message: `${retryRef.current.lastErrMsg || 'Error al procesar la venta'}. Reintentando...`, type: 'error' });
        setIsProcessingSale(true);
        try {
            await retryRef.current.attempt();
        } catch (e) {
            // attempt will schedule countdown and persistent notification
        } finally {
            setIsProcessingSale(false);
        }
    };

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
                for (const t of clone.filter(t => t.id !== activeTab.id).sort((a, b) => Number(a.id) - Number(b.id))) {
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
    const notifiedLoadedRef = useRef(false);

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
            const quickCount = Array.isArray(parsed.tabs) ? parsed.tabs.reduce((s, t) => s + ((t.cart && Array.isArray(t.cart)) ? t.cart.reduce((ss, it) => ss + (Number(it.quantity) || 0), 0) : 0), 0) : 0;
            if (!parsed || !Array.isArray(parsed.tabs)) { quickLoadedRef.current = true; return; }

            // Normalizar/llenar tabs faltantes (asegura 9 pestañas con ids 1..9)
            const cachedTabs = Array.from({ length: 9 }, (_, i) => {
                const found = parsed.tabs.find(t => t.id === String(i + 1));
                if (found) {
                    // sanitize: do NOT restore customer.notes or paymentMethod from persisted state
                    const cust = found.customer || { name: '', phone: '', id: '', address: '' };
                    const sanitizedCust = { name: cust.name || '', phone: cust.phone || '', id: cust.id || '', address: cust.address || '' };
                    return { id: String(i + 1), name: String(i + 1), cart: (found.cart || []).map(it => ({ ...it })), customer: sanitizedCust, paymentMethod: '' };
                }
                return { id: String(i + 1), name: String(i + 1), cart: [], customer: { name: '', phone: '', id: '', address: '' }, paymentMethod: '' };
            });

            // Aplicar inmediatamente los tabs recuperados para que la UI muestre la sesión restaurada
            setTabs(cachedTabs);

            // Mostrar notificación genérica si se restauraron items
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
            const finalCount = Array.isArray(parsed.tabs) ? parsed.tabs.reduce((s, t) => s + ((t.cart && Array.isArray(t.cart)) ? t.cart.reduce((ss, it) => ss + (Number(it.quantity) || 0), 0) : 0), 0) : 0;
            if (!parsed || !Array.isArray(parsed.tabs)) { loadedFromCacheRef.current = true; return; }

            // Normalizar/llenar tabs faltantes (asegura 9 pestañas con ids 1..9)
            const cachedTabs = Array.from({ length: 9 }, (_, i) => {
                const found = parsed.tabs.find(t => t.id === String(i + 1));
                if (found) {
                    const cust = found.customer || { name: '', phone: '', id: '', address: '' };
                    const sanitizedCust = { name: cust.name || '', phone: cust.phone || '', id: cust.id || '', address: cust.address || '' };
                    return { id: String(i + 1), name: String(i + 1), cart: (found.cart || []).map(it => ({ ...it })), customer: sanitizedCust, paymentMethod: '' };
                }
                return { id: String(i + 1), name: String(i + 1), cart: [], customer: { name: '', phone: '', id: '', address: '' }, paymentMethod: '' };
            });

            // Restablecer activeInventoryId y activeTabId si son válidos
            if (parsed.activeInventoryId && inventories.some(i => i.id === parsed.activeInventoryId)) {
                setActiveInventoryId(parsed.activeInventoryId);
            }
            if (parsed.activeTabId && typeof parsed.activeTabId === 'string') {
                setActiveTabId(parsed.activeTabId);
            }

            // Reconciliar cantidades con stock actual
            const invIdToUse = parsed.activeInventoryId && inventories.some(i => i.id === parsed.activeInventoryId) ? parsed.activeInventoryId : (inventories[0]?.id || null);
            const { tabs: adjustedTabs, adjustments } = reconcileTabsWithStock(cachedTabs, invIdToUse);
            setTabs(adjustedTabs);
            // If not yet notified in quick-load, notify now when there are items
            if (!notifiedLoadedRef.current && finalCount > 0) {
                showNotification('Se cargaron los datos de la sesión anterior.', 'info', 5000);
                notifiedLoadedRef.current = true;
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
            // sanitize tabs: remove customer.notes and paymentMethod before persisting
            const sanitizedTabs = tabs.map(t => ({
                id: t.id,
                name: t.name,
                cart: (t.cart || []).map(it => ({ ...it })),
                customer: { name: t.customer?.name || '', phone: t.customer?.phone || '', id: t.customer?.id || '', address: t.customer?.address || '' },
                paymentMethod: ''
            }));

            const payload = {
                tabs: sanitizedTabs,
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

        let operationFn = null;

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

            // Prepare the remote operation so it can be retried
            // Ensure a stable saleId for retries: persist pending sale info in localStorage
            const pendingKey = user?.uid ? `cashier:pending:${user.uid}` : 'cashier:pending:anon';
            let stored = null;
            try { stored = JSON.parse(localStorage.getItem(pendingKey) || 'null'); } catch (e) { stored = null; }
            const saleId = stored?.saleId || `sell_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            // persist minimal payload so retries (or page reloads) use the same saleId
            try { localStorage.setItem(pendingKey, JSON.stringify({ saleId, createdAt: Date.now() })); } catch (e) { }

            operationFn = async () => {
                // use a transaction to make the operation atomic and idempotent
                const saleRef = doc(db, 'history', 'main', 'sells', saleId);
                const to2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
                const items = cart.map(item => {
                    const unit = calculateAmounts(item.price, appSettings.dolarBCV, appSettings.dolarParalelo);
                    const unitPriceBsRounded = Math.max(0, Math.round(unit.bs));
                    const subtotalUSD = item.price * item.quantity;
                    const sub = calculateAmounts(subtotalUSD, appSettings.dolarBCV, appSettings.dolarParalelo);
                    return {
                        productDocId: item.docId,
                        productId: item.id ?? null,
                        name: item.name,
                        quantity: item.quantity,
                        unitPriceUSD: to2(item.price),
                        ratesUsed: { bcv: to2(appSettings.dolarBCV), paralelo: to2(appSettings.dolarParalelo) },
                        unitPriceBs: unitPriceBsRounded,
                        unitPriceUsdAdjusted: to2(unit.usdAdjusted),
                        subtotalBs: Math.max(0, Math.round(unitPriceBsRounded * (Number(item.quantity) || 0))),
                        subtotalUsdAdjusted: to2(sub.usdAdjusted),
                    };
                });

                const cartTotal = cart.reduce((t, i) => t + (i.price * i.quantity), 0);
                const totalsCalc = calculateAmounts(cartTotal, appSettings.dolarBCV, appSettings.dolarParalelo);
                const totalsBsSum = items.reduce((acc, it) => acc + (Number(it.subtotalBs) || 0), 0);
                const activeInventoryName = inventories.find(i => i.id === activeInventoryId)?.name || '';

                // build inventory updates object
                const updates = {};
                for (const item of cart) updates[`products.${item.docId}.quantity`] = increment(-item.quantity);

                // run transaction: check sale doc existence first to avoid duplicate application
                await runTransaction(db, async (tx) => {
                    const existing = await tx.get(saleRef);
                    if (existing.exists()) {
                        // already processed, nothing to do
                        return;
                    }

                    // If user is signed in and there's a cedula, read the customer doc now (reads must come before writes)
                    const cedRaw = (activeCustomer && (activeCustomer.id || activeCustomer.cedula)) || '';
                    const cedId = normalizeCedula(cedRaw) || null;
                    let existingCust = null;
                    let custRef = null;
                    if (user?.uid && cedId) {
                        try {
                            custRef = doc(db, 'customers', cedId);
                            existingCust = await tx.get(custRef);
                        } catch (e) {
                            // If we cannot read customer (permissions), proceed without blocking the sale
                            existingCust = null;
                        }
                    }

                    // apply inventory updates (writes start after all reads)
                    tx.update(inventoryDocRef, updates);

                    // write or merge customer if we have a custRef and tx read succeeded or we are signed in
                    try {
                        if (custRef && user?.uid) {
                            const normalizedName = titleCaseName(activeCustomer.name || '');
                            const normalizedCed = normalizeCedula(activeCustomer.id || cedId || '');
                            const custPayload = {
                                name: normalizedName,
                                phone: activeCustomer.phone || '',
                                address: activeCustomer.address || '',
                                cedula: normalizedCed || cedId,
                                name_lower: (normalizedName || '').toLowerCase()
                                // intentionally omit notes and any paymentMethod
                            };
                            if (existingCust && existingCust.exists()) {
                                const old = existingCust.data() || {};
                                const merged = { ...old };
                                for (const k of ['name', 'phone', 'address']) {
                                    if (custPayload[k]) merged[k] = custPayload[k];
                                }
                                merged.cedula = normalizedCed || cedId;
                                merged.name_lower = (merged.name || '').toLowerCase();
                                tx.set(custRef, merged, { merge: true });
                            } else {
                                tx.set(custRef, custPayload, { merge: true });
                            }
                        }
                    } catch (custErr) {
                        // do not block sale if customer save fails; just warn (avoid noisy logs)
                        console.debug('Could not save customer in transaction:', custErr?.message || custErr);
                    }

                    tx.set(saleRef, {
                        id: saleId,
                        soldAt: serverTimestamp(),
                        soldAtISO: new Date().toISOString(),
                        userId: user?.uid || null,
                        inventoryId: activeInventoryId,
                        inventoryName: activeInventoryName,
                        customer: {
                            name: (activeCustomer && activeCustomer.name) || '',
                            phone: (activeCustomer && activeCustomer.phone) || '',
                            id: (activeCustomer && activeCustomer.id) || '',
                            address: (activeCustomer && activeCustomer.address) || ''
                        },
                        notes: (activeCustomer && activeCustomer.notes) || '',
                        paymentMethod: activePaymentMethod,
                        items,
                        totals: {
                            bs: Math.max(0, Math.round(totalsBsSum)),
                            usdAdjusted: to2(totalsCalc.usdAdjusted),
                            usdInt: Math.max(0, Math.floor(totalsCalc.usdInt)),
                            bsDecimals: Math.max(0, Math.round(totalsCalc.bsDecimals)),
                        },
                        ratesUsed: { bcv: to2(appSettings.dolarBCV), paralelo: to2(appSettings.dolarParalelo) },
                        summary: { itemCount: cart.reduce((n, i) => n + i.quantity, 0), productLines: cart.length }
                    });
                });

                // reconcile other tabs after inventory update (same logic)
                try {
                    const currentStockMap = {};
                    for (const [pid, pdata] of Object.entries(activeInv.products || {})) {
                        currentStockMap[pid] = Number(pdata?.quantity) || 0;
                    }
                    const soldMap = cart.reduce((m, it) => { m[it.docId] = (m[it.docId] || 0) + Number(it.quantity || 0); return m; }, {});
                    const stockAfterMap = {};
                    for (const pid of Object.keys(soldMap)) {
                        stockAfterMap[pid] = Math.max(0, (currentStockMap[pid] || 0) - soldMap[pid]);
                    }

                    const adjustedInfo = [];
                    setTabs(prevTabs => {
                        const clone = prevTabs.map(t => ({ ...t, cart: (t.cart || []).map(i => ({ ...i })) }));
                        const otherTabs = clone.filter(t => t.id !== activeTabId).sort((a, b) => Number(a.id) - Number(b.id));

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

                // success: clear pending marker
                try { localStorage.removeItem(pendingKey); } catch (e) { }
            };

            // Execute the remote operation now; if it fails the catch below
            // will start the retry manager using the prepared operationFn.
            await operationFn();

            // success: local UI updates (only after operationFn completed without throwing)
            showNotification("Venta realizada con éxito.", 'success');
            // upsert customer into local cache so panel shows the new/updated customer immediately
            try {
                const custForCache = {
                    id: normalizeCedula((activeCustomer && activeCustomer.id) || ''),
                    cedula: normalizeCedula((activeCustomer && activeCustomer.id) || ''),
                    name: titleCaseName((activeCustomer && activeCustomer.name) || ''),
                    phone: (activeCustomer && activeCustomer.phone) || '',
                    address: (activeCustomer && activeCustomer.address) || ''
                };
                upsertCustomerToLocalCache(custForCache);
            } catch (e) { }

            setCurrentTabCart([]);
            setActiveTabCustomer({ ...defaultCustomer });
            setActiveTabPaymentMethod('');
        } catch (err) {
            console.error('Error al procesar la venta:', err);
            // If we prepared a remote operation, use retry manager
            if (typeof operationFn === 'function') {
                showErrorWithRetry('Error al procesar la venta', operationFn, 30).catch(() => { });
            } else {
                setError(err?.message || 'No se pudo completar la venta.');
                showNotification(err?.message || 'No se pudo completar la venta.', 'error');
            }
        } finally {
            setIsProcessingSale(false);
        }
    };

    // Wrapper that checks for cedula presence and shows a modal if missing
    const [showCedulaConfirm, setShowCedulaConfirm] = useState(false);
    const confirmSaleWithCedulaCheck = () => {
        const ced = normalizeCedula(activeCustomer?.id || '');
        if (!ced) {
            // show professional confirmation modal
            setShowCedulaConfirm(true);
            return;
        }
        // otherwise proceed normally
        handleConfirmSale();
    };

    const handleProceedWithoutCedula = async () => {
        setShowCedulaConfirm(false);
        // proceed with the sale even though no cedula
        await handleConfirmSale();
    };

    const cartTotal = useMemo(() => cart.reduce((t, i) => t + (i.price * i.quantity), 0), [cart]);
    const totals = useMemo(() => {
        const calc = (usd) => calculateAmounts(usd, appSettings.dolarBCV, appSettings.dolarParalelo);
        const totalsFromUsd = calc(cartTotal); // mantiene USD igual que antes

        // SUMAR los Bs por línea usando el precio unitario redondeado * cantidad
        const sumBs = cart.reduce((s, item) => {
            const unit = calc(Number(item.price) || 0);
            const unitRounded = Math.max(0, Math.round(unit.bs));
            const qty = Number(item.quantity) || 0;
            return s + (unitRounded * qty);
        }, 0);

        // sumar bsDecimals por línea a partir de la parte decimal por unidad * cantidad
        const sumBsDecimals = cart.reduce((s, item) => {
            const unit = calc(Number(item.price) || 0);
            const qty = Number(item.quantity) || 0;
            return s + ((Number(unit.bsDecimals) || 0) * qty);
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
                            <div className="header-left">
                                <h2 style={{ margin: 0 }}>Ventas</h2>
                            </div>

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

                            <div className="right-controls">
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
                                <button
                                    type="button"
                                    className="settings-btn"
                                    title="Preferencias"
                                    onClick={() => setShowPreferences(true)}
                                >
                                    <span aria-hidden>⚙</span>
                                </button>
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
                                        // compute per-item unit and rounded Bs values
                                        const unitCalc = calculateAmounts(item.price, appSettings.dolarBCV, appSettings.dolarParalelo);
                                        const unit = {
                                            bs: item.priceBs ?? unitCalc.bs,
                                            usdAdjusted: item.priceUsdAdjusted ?? unitCalc.usdAdjusted,
                                            bsDecimals: item.priceBsDecimals ?? unitCalc.bsDecimals
                                        };
                                        // rounded unit Bs used in UI and history: follow existing policy (already rounded in calculateAmounts)
                                        const unitPriceBsRounded = Math.max(0, Math.round(unit.bs));
                                        const subtotalUSD = item.price * item.quantity;
                                        const subtotalBsRounded = Math.max(0, Math.round(unitPriceBsRounded * (Number(item.quantity) || 0)));
                                        const sub = calculateAmounts(subtotalUSD, appSettings.dolarBCV, appSettings.dolarParalelo);
                                        return (
                                            <div className="cart-row" key={item.docId}>
                                                <div className="cart-cell product" data-label="Producto">
                                                    {/* Thumbnail that opens viewer when clicked */}
                                                    {(item.thumbnailWebp || item.thumbnail || item.image) && (
                                                        <button
                                                            type="button"
                                                            className="cart-thumb-btn"
                                                            onClick={(e) => { e.stopPropagation(); const src = item.thumbnailWebp || item.thumbnail || item.image; setViewerSrc(src); setViewerOpen(true); }}
                                                            aria-label={`Ver imagen de ${item.name}`}
                                                        >
                                                            <img className="cart-thumb" src={item.thumbnailWebp || item.thumbnail || item.image} alt={item.name} />
                                                        </button>
                                                    )}
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
                                                                value={priceEditMap[item.docId] ?? (
                                                                    (item.priceUsdAdjusted !== undefined && item.priceUsdAdjusted !== null)
                                                                        ? String(item.priceUsdAdjusted)
                                                                        : (Number.isFinite(item.price) ? String(calculateAmounts(item.price, appSettings.dolarBCV, appSettings.dolarParalelo).usdAdjusted) : '')
                                                                )}
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
                                                        {formatBs(calculateAmounts(item.price, appSettings.dolarBCV, appSettings.dolarParalelo).bs)}
                                                    </small>
                                                </div>
                                                <div className="cart-cell quantity" data-label="Cant.">
                                                    <div
                                                        className="qty-control"
                                                        role="group"
                                                        aria-label={`Cantidad de ${item.name}`}
                                                    >
                                                        {/* Use SVG-based buttons to avoid font-size layout issues */}
                                                        <QtyButton
                                                            variant="minus"
                                                            onClick={() => decrementQuantity(item.docId)}
                                                            ariaLabel={`Restar 1 a ${item.name}`}
                                                            disabled={item.quantity <= 1}
                                                        />
                                                        <span className="qty-number" aria-live="polite">{item.quantity}</span>
                                                        <QtyButton
                                                            variant="plus"
                                                            onClick={() => incrementQuantity(item.docId)}
                                                            ariaLabel={`Sumar 1 a ${item.name}`}
                                                            disabled={getAvailableForProduct(item.docId, item.quantity) <= 0}
                                                        />
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
                                                    <span>{formatBs(subtotalBsRounded)}</span>
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
                                                onChange={(e) => {
                                                    const v = e.target.value;
                                                    // typing in name clears the panel filter and sets source to name
                                                    setCustomersFilter('');
                                                    setFilterSource('name');
                                                    setActiveTabCustomer(p => ({ ...p, name: v }));
                                                }}
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
                                                onChange={(e) => {
                                                    const v = e.target.value;
                                                    // typing in cedula clears the panel filter and sets source to id
                                                    setCustomersFilter('');
                                                    setFilterSource('id');
                                                    setActiveTabCustomer(p => ({ ...p, id: v }));
                                                }}
                                            />
                                        </label>
                                        {/* Sugerencias debajo de cédula/nombre */}
                                        {/* suggestion dropdown anchored to focused input */}
                                        {/* no inline suggestions here; use customers panel below */}
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
                                            <>
                                                {!retryRef.current.running ? (
                                                    <button
                                                        className="confirm-btn"
                                                        onClick={confirmSaleWithCedulaCheck}
                                                        disabled={isProcessingSale || !activePaymentMethod}
                                                        aria-busy={isProcessingSale}
                                                        aria-disabled={isProcessingSale || !activePaymentMethod}
                                                        title={!activePaymentMethod ? 'Seleccione un método de pago para habilitar este botón' : ''}
                                                    >
                                                        {isProcessingSale ? 'Procesando...' : 'Confirmar Venta'}
                                                    </button>
                                                ) : (
                                                    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                                                        <button className="confirm-btn" onClick={handleManualRetry} disabled={isProcessingSale} aria-busy={isProcessingSale}>{isProcessingSale ? 'Procesando...' : 'Reintentar ahora'}</button>
                                                    </div>
                                                )}
                                            </>
                                        )}
                                    </div>
                                </div>
                            </section>
                            {/* Nuevo panel: lista de clientes */}
                            <section className="customers-panel" aria-label="Lista de clientes">
                                <div className="customers-panel-inner">
                                    <div className="customers-panel-header">
                                        <h4>Clientes</h4>
                                        <input
                                            type="search"
                                            placeholder="Filtrar por nombre..."
                                            value={customersFilter}
                                            onChange={(e) => { setCustomersFilter(e.target.value); setFilterSource('panel'); }}
                                            aria-label="Filtrar clientes por nombre"
                                        />
                                    </div>
                                    <div
                                        className="customers-list"
                                        role="list"
                                        ref={customersListContainerRef}
                                        tabIndex={0}
                                        onKeyDown={handleCustomersListKeyDown}
                                        aria-label="Lista de clientes filtrados"
                                    >
                                        {filteredCustomers.map((c, idx) => {
                                            const ced = String(c.cedula || c.id || '').toUpperCase();
                                            const isSelected = selectedCustomerCedula && selectedCustomerCedula === ced;
                                            const isActive = panelActiveIndex === idx;
                                            return (
                                                <button
                                                    key={ced || idx}
                                                    type="button"
                                                    data-index={idx}
                                                    tabIndex={isActive ? 0 : -1}
                                                    className={`customers-list-item${isSelected ? ' selected' : ''}`}
                                                    onClick={() => {
                                                        // clicking a panel item sets filter source to 'panel' and selects
                                                        setFilterSource('panel');
                                                        setSelectedCustomerCedula(ced);
                                                        selectCustomerSuggestion(c);
                                                        setPanelActiveIndex(idx);
                                                    }}
                                                    onMouseMove={() => setPanelActiveIndex(idx)}
                                                    role="listitem"
                                                    aria-selected={isSelected}
                                                >
                                                    <div className="cli-top"><strong>{c.name}</strong><span className="cli-ced">{ced}</span></div>
                                                    <div className="cli-bottom">{c.phone ? `${c.phone} · ` : ''}{c.address || ''}</div>
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                            </section>
                        </>
                    )}
                </article>
            </section>
            {/* Cedula confirmation modal */}
            {showCedulaConfirm && (
                <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="cedula-modal-title">
                    <div className="modal-card">
                        <h3 id="cedula-modal-title">Atención: cédula no proporcionada</h3>
                        <p>
                            No ha indicado la cédula del cliente. Si no añade la cédula, los datos del cliente
                            no se guardarán en la libreta de clientes. ¿Desea continuar con la venta sin guardar
                            la cédula del cliente?
                        </p>
                        <div className="modal-actions">
                            <button className="outline secondary" onClick={() => setShowCedulaConfirm(false)}>Cancelar</button>
                            <button className="confirm-btn" onClick={handleProceedWithoutCedula}>Continuar y ejecutar venta</button>
                        </div>
                    </div>
                </div>
            )}

            {/* 2. Reemplaza el botón HTML por el componente AddProductButton */}
            <AddProductButton onClick={() => setIsModalOpen(true)} />

            {/* import button removed (was used once) */}

            <ProductSearchModal
                isOpen={isModalOpen}
                onClose={() => setIsModalOpen(false)}
                onAddProduct={handleAddProductToCart}
                allProducts={products}
                user={user}
                inventories={inventories}
                activeInventoryId={activeInventoryId}
                onInventoryChange={handleInventoryChange}
                appSettings={appSettings}
                cart={cart} /* carrito de la pestaña activa */
                reservedMap={reservedMap} /* reservado por otras pestañas */
                // Inverted pref stored as `autoCloseAfterAdd` represents "Do NOT auto-close".
                // We compute the effective autoClose boolean (true => modal will auto-close).
                autoCloseAfterAdd={!prefDoNotAutoCloseAfterAdd}
            />

            {/* Preferences modal */}
            {showPreferences && (
                <div className="modal-backdrop" role="dialog" aria-modal="true">
                    <div className="modal-card">
                        <h3>Preferencias</h3>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                <input
                                    type="checkbox"
                                    checked={!!prefUseSmartProductSearch}
                                    onChange={async (e) => {
                                        const v = !!e.target.checked;
                                        setPrefUseSmartProductSearch(v);
                                        try {
                                            if (user?.uid) {
                                                await setDoc(doc(db, 'users', user.uid), { prefs: { useSmartProductSearch: v } }, { merge: true });
                                            } else {
                                                localStorage.setItem('prefs:useSmartProductSearch', v ? '1' : '0');
                                            }
                                        } catch (err) {
                                            console.debug('Could not persist pref', err);
                                        }
                                    }}
                                />
                                <span>Búsqueda inteligente (Product Search Modal)</span>
                            </label>
                            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                <input
                                    type="checkbox"
                                    // Checkbox now means "Do NOT auto-close after add" (inverted semantic)
                                    checked={!!prefDoNotAutoCloseAfterAdd}
                                    onChange={async (e) => {
                                        const v = !!e.target.checked;
                                        setPrefDoNotAutoCloseAfterAdd(v);
                                        try {
                                            if (user?.uid) {
                                                // Persist only the new clearer key; reads still fallback to old key for compatibility
                                                await setDoc(doc(db, 'users', user.uid), { prefs: { noAutoCloseAfterAdd: v } }, { merge: true });
                                            } else {
                                                localStorage.setItem('prefs:noAutoCloseAfterAdd', v ? '1' : '0');
                                            }
                                        } catch (err) {
                                            console.debug('Could not persist pref', err);
                                        }
                                    }}
                                />
                                <span>No cerrar automáticamente tras agregar producto</span>
                            </label>
                        </div>
                        <div style={{ marginTop: '1rem', display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
                            <button className="outline secondary" onClick={() => setShowPreferences(false)}>Cerrar</button>
                        </div>
                    </div>
                </div>
            )}
            {/* Image viewer for Cashier (portal-based) */}
            <ImageViewerModal isOpen={viewerOpen} onClose={() => { setViewerOpen(false); setViewerSrc(null); }} src={viewerSrc} alt="Imagen" />

        </>
    );
}

// Cedula confirmation modal (rendered inside the component via state)

export default Cashier;