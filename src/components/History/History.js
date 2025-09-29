import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { collection, query, orderBy, limit, onSnapshot, startAfter, getDocs, doc, writeBatch, increment, serverTimestamp, getDoc } from 'firebase/firestore';
import { db } from '../../firebase';
import { useData } from '../../context/DataProvider.jsx';
import './History.css';
import { getAuth } from 'firebase/auth'; // <-- add for debugging

const PAGE_SIZE_LIVE = 120;
const PAGE_SIZE_OLDER = 100;

function formatBs(v) {
  return `${(Number(v) || 0).toLocaleString('es-VE')} Bs.`;
}

function formatUSD(v) {
  return (Number.isFinite(v) ? v : 0).toLocaleString('en-US', {
    style: 'currency', currency: 'USD',
    minimumFractionDigits: 2, maximumFractionDigits: 2
  });
}

// Reemplaza la función formatDate y añade una segunda para el detalle:

function formatDateList(ts) {
  if (!ts) return '—';
  try {
    const d = ts.toDate ? ts.toDate() : (typeof ts === 'string' ? new Date(ts) : ts);
    if (isNaN(d.getTime())) return '—';
    const day = String(d.getDate()).padStart(2,'0');
    const month = String(d.getMonth() + 1).padStart(2,'0');
    const year = d.getFullYear();
    return `${day}/${month}/${year}`;
  } catch {
    return '—';
  }
}

function formatDateDetail(ts) {
  if (!ts) return '—';
  try {
    const d = ts.toDate ? ts.toDate() : (typeof ts === 'string' ? new Date(ts) : ts);
    if (isNaN(d.getTime())) return '—';
    // Con AM/PM (hour12 true)
    return d.toLocaleString('es-VE', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: true
    });
  } catch {
    return '—';
  }
}

// Nuevo: formato compacto para el modal: "dd/mm/aa a las hh:mm"
function formatDateModal(ts) {
  if (!ts) return '—';
  try {
    const d = ts.toDate ? ts.toDate() : (typeof ts === 'string' ? new Date(ts) : ts);
    if (isNaN(d.getTime())) return '—';
    const day = String(d.getDate()).padStart(2,'0');
    const month = String(d.getMonth() + 1).padStart(2,'0');
    const year = String(d.getFullYear()).slice(-2);
    const hours = String(d.getHours()).padStart(2,'0');
    const minutes = String(d.getMinutes()).padStart(2,'0');
    return `${day}/${month}/${year} a las ${hours}:${minutes}`;
  } catch {
    return '—';
  }
}

function History() {
  const { inventories, usersMap: globalUsersMap } = useData();
  const [localUsersMap, setLocalUsersMap] = useState({}); // cache for on-demand fetched users
  const fetchingUidsRef = useRef(new Set());
  const [liveSales, setLiveSales] = useState([]);
  const [olderSales, setOlderSales] = useState([]);
  const [mode, setMode] = useState('sells'); // 'sells' or 'buys'
  const [cursor, setCursor] = useState(null);           // último doc snapshot cargado
  const [loadingLive, setLoadingLive] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [noMoreOlder, setNoMoreOlder] = useState(false);
  const [error, setError] = useState('');

  // Filtros
  const [filterInventory, setFilterInventory] = useState('all');
  const [filterMethod, setFilterMethod] = useState('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  const [expanded, setExpanded] = useState(() => new Set());
  const [processingRefunds, setProcessingRefunds] = useState(() => new Set());

  // Nuevo: modal / candidato de reembolso
  const [refundCandidate, setRefundCandidate] = useState(null);
  const [showRefundModal, setShowRefundModal] = useState(false);

  // Listener real-time últimas ventas/compras según modo
  useEffect(() => {
    setLoadingLive(true);
  const colName = mode === 'sells' ? 'sells' : 'buys';
  const ref = collection(db, 'history', 'main', colName);
    const timeField = mode === 'sells' ? 'soldAt' : 'boughtAt';
    const qLive = query(ref, orderBy(timeField, 'desc'), limit(PAGE_SIZE_LIVE));

    const unsub = onSnapshot(qLive, (snap) => {
      const next = snap.docs.map(docSnap => {
        const data = docSnap.data();
        // normalize timestamp to soldAt for backward compatibility in UI
        const ts = data.soldAt || data.boughtAt || null;
        return {
          id: docSnap.id,
          soldAt: ts,
          // record original collection type so we can tell buys vs sells reliably
          type: colName,
          ...data
        };
      });
      setLiveSales(next);
      if (snap.docs.length > 0 && olderSales.length === 0) {
        setCursor(snap.docs[snap.docs.length - 1]);
      }
      setLoadingLive(false);
    }, (err) => {
      console.error('Error live history:', err);
      setError('No se pudo cargar el historial reciente.');
      setLoadingLive(false);
    });

    return () => unsub();
  }, [olderSales.length, mode]);

  const handleLoadMore = useCallback(async () => {
    if (loadingMore || noMoreOlder || loadingLive) return;
    if (!cursor) {
      // Si aún no hay cursor (todavía no llegaron ventas), evita llamada
      return;
    }
    try {
      setLoadingMore(true);
      const colName = mode === 'sells' ? 'sells' : 'buys';
      const ref = collection(db, 'history', 'main', colName);
      const timeField = mode === 'sells' ? 'soldAt' : 'boughtAt';
      const qOlder = query(
        ref,
        orderBy(timeField, 'desc'),
        startAfter(cursor),
        limit(PAGE_SIZE_OLDER)
      );

      const snap = await getDocs(qOlder);
      if (snap.empty) {
        setNoMoreOlder(true);
        setLoadingMore(false);
        return;
      }

      const batch = [];
      snap.forEach(docSnap => {
        const data = docSnap.data();
        const ts = data.soldAt || data.boughtAt || null;
        batch.push({ id: docSnap.id, soldAt: ts, type: colName, ...data });
      });

      setOlderSales(prev => [...prev, ...batch]);

      // Nuevo cursor (último doc de esta página)
      const lastDocSnap = snap.docs[snap.docs.length - 1];
      setCursor(lastDocSnap);

      // Si página menor al tamaño, no hay más
      if (snap.size < PAGE_SIZE_OLDER) {
        setNoMoreOlder(true);
      }
    } catch (err) {
      console.error('Error loading older sales:', err);
      setError('No se pudieron cargar ventas antiguas.');
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, noMoreOlder, loadingLive, cursor]);

  // Merge evitando duplicados
  const allSales = useMemo(() => {
    const map = new Map();
    [...liveSales, ...olderSales].forEach(s => map.set(s.id, s));
    return Array.from(map.values()).sort((a, b) => {
      const ta = a.soldAt?.seconds || 0;
      const tb = b.soldAt?.seconds || 0;
      return tb - ta;
    });
  }, [liveSales, olderSales]);

  const dateFromMs = dateFrom ? new Date(dateFrom + 'T00:00:00').getTime() : null;
  const dateToMs = dateTo ? new Date(dateTo + 'T23:59:59').getTime() : null;

  const filteredSales = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    return allSales.filter(s => {
      // NOTE: ya no excluimos ventas reembolsadas para que sigan visibles (se mostrarán en rojo)
      if (s.soldAt?.seconds) {
        const ms = s.soldAt.seconds * 1000;
        if (dateFromMs && ms < dateFromMs) return false;
        if (dateToMs && ms > dateToMs) return false;
      }
      if (filterInventory !== 'all' && s.inventoryId !== filterInventory) return false;
      if (filterMethod !== 'all' && s.paymentMethod !== filterMethod) return false;
      if (term) {
        const haystack = [
          s.id,
          s.inventoryName,
          s.paymentMethod,
          s.customer?.name,
          s.customer?.id,
          ...(Array.isArray(s.items) ? s.items.map(i => i.name) : [])
        ].filter(Boolean).join(' ').toLowerCase();
        if (!haystack.includes(term)) return false;
      }
      return true;
    });
  }, [allSales, filterInventory, filterMethod, searchTerm, dateFromMs, dateToMs]);

  // DEBUG: Log userIds in filteredSales and their usersMap entries
  useEffect(() => {
    if (mode !== 'buys') return;
    const uids = Array.from(new Set(filteredSales.map(s => s.userId).filter(Boolean)));
  // removed verbose debug logs
    // determine which uids we don't have yet (neither globalUsersMap nor localUsersMap)
    const missing = uids.filter(uid => !(globalUsersMap && globalUsersMap[uid]) && !(localUsersMap && localUsersMap[uid]) && !fetchingUidsRef.current.has(uid));
    if (missing.length === 0) return;

    let cancelled = false;
    const doFetch = async () => {
      try {
        missing.forEach(uid => fetchingUidsRef.current.add(uid));
        const promises = missing.map(uid => getDoc(doc(db, 'users', uid)).then(snap => ({ uid, snap })).catch(err => ({ uid, err })));
        const results = await Promise.all(promises);
        if (cancelled) return;
  // on-demand fetch completed (results stored in localUsersMap)
        setLocalUsersMap(prev => {
          const next = { ...prev };
          results.forEach(r => {
            const uid = r.uid;
            if (r.err) {
              // mark as null to avoid retry storms
              next[uid] = null;
            } else if (r.snap && r.snap.exists()) {
              next[uid] = { uid, ...r.snap.data() };
            } else {
              next[uid] = null;
            }
          });
          return next;
        });
      } catch (err) {
        // ignore; individual failures handled per-item
      } finally {
        missing.forEach(uid => fetchingUidsRef.current.delete(uid));
      }
    };

    doFetch();
    return () => { cancelled = true; };
  }, [mode, filteredSales, globalUsersMap]);

  // Resolve a friendly display name for a sale's userId using the global users cache
  const resolveUserDisplay = (sale) => {
    if (!sale) return '—';
    if (sale._userDisplay) return sale._userDisplay;
    const uid = sale.userId;
    if (!uid) return '—';
    // prefer localUsersMap (on-demand fetched) then globalUsersMap
    const u = (localUsersMap && Object.prototype.hasOwnProperty.call(localUsersMap, uid) ? localUsersMap[uid] : (globalUsersMap && globalUsersMap[uid]));
    if (!u) return '—';
    if (u.username && String(u.username).trim().length > 0) return String(u.username).trim();
    if (u.name && String(u.name).trim().length > 0) return String(u.name).trim();
    if (u.displayName && String(u.displayName).trim().length > 0) return String(u.displayName).trim();
    if (u.email && String(u.email).includes('@')) return String(u.email).split('@')[0];
    return '—';
  };

  const summary = useMemo(() => {
    // Excluir ventas reembolsadas de todos los totales (ventas, líneas, ítems y montos)
    const active = filteredSales.filter(s => !s.refunded);
    let totalBs = 0;
    let totalUsdAdj = 0;
    let lines = 0;
    let units = 0;

    active.forEach(s => {
      totalBs += Number(s.totals?.bs) || 0;
      if (mode === 'sells') {
        totalUsdAdj += Number(s.totals?.usdAdjusted) || 0;
      } else {
        // buys: always compute USD totals from the raw unitCostUSD * quantity (display-only)
        const byItems = (s.items || []).reduce((acc, it) => acc + ((Number(it.unitCostUSD) || 0) * (Number(it.quantity) || 0)), 0);
        totalUsdAdj += byItems;
      }
      lines += Number(s.summary?.productLines) || Number(s.items?.length) || 0;
      units += Number(s.summary?.itemCount) || 0;
    });

    return {
      totalBs,
      totalUsdAdj,
      sales: active.length, // ahora cuenta solo ventas no reembolsadas
      lines,
      units
    };
  }, [filteredSales]);

  const toggleExpand = (id) => {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  // Abrir modal en vez de alert
  const openRefundModal = useCallback((sale) => {
    if (!sale || sale.refunded) return;
    setRefundCandidate(sale);
    setShowRefundModal(true);
  }, []);

  // Evitar scroll de fondo cuando modal abierto
  useEffect(() => {
    document.body.style.overflow = showRefundModal ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [showRefundModal]);

  // Ejecuta el reembolso (lo que antes estaba en handleRefund)
  const performRefund = useCallback(async () => {
    const sale = refundCandidate;
    if (!sale) return;
    setProcessingRefunds(prev => new Set(prev).add(sale.id));
    setShowRefundModal(false);

    try {
      const batch = writeBatch(db);

  // Decide by inspecting the sale object rather than relying on `mode`.
  // Prefer an explicit `type` (set when loading docs) if present.
  const type = sale.type || (sale.boughtAt ? 'buys' : (sale.soldAt ? 'sells' : null));

  if (type === 'sells' || (type === null && (mode === 'sells' || sale.soldAt))) {
        // sell refund logic
        const sellRef = doc(db, 'history', 'main', 'sells', sale.id);
        batch.update(sellRef, { refunded: true, refundedAt: serverTimestamp() });

        if (!sale.inventoryId) {
          throw new Error('Venta sin inventoryId, no se pueden devolver existencias.');
        }
        const inventoryRef = doc(db, 'inventories', sale.inventoryId);

        (sale.items || []).forEach(it => {
          if (!it.productDocId) {
            console.warn('performRefund: item sin productDocId, se omite', it);
            return;
          }
          const fieldPath = `products.${it.productDocId}.quantity`;
          // add back quantities for sells
          batch.update(inventoryRef, { [fieldPath]: increment(Number(it.quantity || 0)) });
        });

      } else {
        // buy return logic: mark buy as refunded/returned and remove the stock that was added
        const buyRef = doc(db, 'history', 'main', 'buys', sale.id);
        batch.update(buyRef, { refunded: true, refundedAt: serverTimestamp() });

        if (!sale.inventoryId) {
          throw new Error('Compra sin inventoryId, no se pueden quitar existencias.');
        }
        const inventoryRef = doc(db, 'inventories', sale.inventoryId);

        (sale.items || []).forEach(it => {
          if (!it.productDocId) {
            console.warn('performRefund (buy): item sin productDocId, se omite', it);
            return;
          }
          const fieldPath = `products.${it.productDocId}.quantity`;
          // reverse the buy: decrement the quantities that were added when the buy was recorded
          batch.update(inventoryRef, { [fieldPath]: increment(Number(it.quantity || 0) * -1) });
        });
      }

      await batch.commit();

      // éxito: limpiar mensaje de error y actualizar estado local
      setError('');
      // update local lists depending on mode
      if (mode === 'sells' || sale.soldAt) {
        setLiveSales(prev => prev.map(s => s.id === sale.id ? { ...s, refunded: true } : s));
        setOlderSales(prev => prev.map(s => s.id === sale.id ? { ...s, refunded: true } : s));
      } else {
        setLiveSales(prev => prev.map(s => s.id === sale.id ? { ...s, refunded: true } : s));
        setOlderSales(prev => prev.map(s => s.id === sale.id ? { ...s, refunded: true } : s));
      }
      setRefundCandidate(null);
      console.log('Refund/Return committed for', sale.id);
    } catch (err) {
      console.error('Error refunding sale:', err);
      setError('No se pudo deshacer la venta/compra. Revisa consola de debug.');
    } finally {
      setProcessingRefunds(prev => {
        const next = new Set(prev);
        next.delete(sale.id);
        return next;
      });
    }
  }, [refundCandidate]);

  // We now rely on `usersMap` provided by DataProvider (globalUsersMap) which keeps all users in cache

  return (
    <section className="history-wrapper">
      <header className="history-header">
        <div>
          <h1>Historial</h1>
          <p className="muted">Registros recientes en tiempo real. Carga más para ver registros antiguos.</p>
        </div>
        <div className="history-summary">
          <div style={{ display: 'flex', gap: '.5rem', alignItems: 'center' }}>
            <label style={{ fontSize: '0.9rem' }}>Modo:</label>
            <select value={mode} onChange={e => { setMode(e.target.value); setOlderSales([]); setCursor(null); }}>
              <option value="sells">Ventas</option>
              <option value="buys">Compras</option>
            </select>
          </div>
          <div><strong>{summary.sales}</strong><span>{mode === 'sells' ? 'Ventas' : 'Compras'}</span></div>
          <div><strong>{summary.lines}</strong><span>Líneas</span></div>
          <div><strong>{summary.units}</strong><span>Ítems</span></div>
          <div><strong>{formatBs(summary.totalBs)}</strong><span>Total Bs</span></div>
          <div><strong>{formatUSD(summary.totalUsdAdj)}</strong><span>Total USD</span></div>
        </div>
      </header>

      <aside className="history-filters">
        <div className="filter-group">
          <label>Inventario</label>
          <select value={filterInventory} onChange={e => setFilterInventory(e.target.value)}>
            <option value="all">Todos</option>
            {inventories.map(inv => (
              <option key={inv.id} value={inv.id}>{inv.name || inv.id}</option>
            ))}
          </select>
        </div>
        {mode === 'sells' && (
          <div className="filter-group">
            <label>Método</label>
            <select value={filterMethod} onChange={e => setFilterMethod(e.target.value)}>
              <option value="all">Todos</option>
              <option value="punto">Punto</option>
              <option value="pago_movil">Pago móvil</option>
              <option value="divisa">Divisa</option>
              <option value="efectivo">Efectivo</option>
            </select>
          </div>
        )}
        <div className="filter-group">
          <label>Desde</label>
          <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
        </div>
        <div className="filter-group">
          <label>Hasta</label>
          <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} />
        </div>
        <div className="filter-group grow">
          <label>Búsqueda</label>
            <input
              type="search"
              placeholder="Cliente, producto, id..."
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
            />
        </div>
        <div className="filter-group actions">
          <button
            className="outline secondary"
            onClick={() => {
              setFilterInventory('all');
              setFilterMethod('all');
              setSearchTerm('');
              setDateFrom('');
              setDateTo('');
            }}
          >
            Limpiar
          </button>
        </div>
      </aside>

      {error && <p style={{ color: 'var(--pico-color-red-500)' }}>{error}</p>}
      {loadingLive && <article aria-busy="true">Cargando ventas recientes…</article>}

      <div className="history-table-wrapper">
  <div className={`history-table-head mode-${mode}`}>
          <div className="h-col date">Fecha</div>
          <div className="h-col customer">{mode === 'sells' ? 'Cliente' : 'Usuario'}</div>
          <div className="h-col inv">Inventario</div>
          {mode === 'sells'
            ? <div className="h-col method">Método</div>
            : <div className="h-col method" style={{ visibility: 'hidden' }}></div>}
          <div className="h-col lines">Líneas</div>
          <div className="h-col items">Ítems</div>
          <div className="h-col totalbs">Total Bs</div>
          <div className="h-col totalusd">Total USD</div>
          <div className="h-col expand"></div>
        </div>
        <div className="history-rows">
          {/* mode-specific row class for grid alignment */}
          {filteredSales.length === 0 && !loadingLive && (
            <div className="history-empty">Sin resultados con los filtros actuales.</div>
          )}
          {filteredSales.map(sale => {
            const isOpen = expanded.has(sale.id);
            const isRefunded = !!sale.refunded;
            return (
              <div
                key={sale.id}
                className={`history-row mode-${mode} ${isOpen ? 'open' : ''} ${isRefunded ? 'refunded' : ''}`}
                title={`ID interno: ${sale.id}`}
              >
                <div className="h-col date">{formatDateList(sale.soldAt)}</div>
                <div className="h-col customer">{mode === 'sells' ? (sale.customer?.name || '—') : resolveUserDisplay(sale)}</div>
                <div className="h-col inv" title={sale.inventoryName}>{sale.inventoryName || sale.inventoryId}</div>
                {mode === 'sells' ? (
                  <div className="h-col method">
                    <span className={`pm-badge pm-${sale.paymentMethod || 'na'}`}>
                      {(sale.paymentMethod || '').replace('_', ' ') || '—'}
                    </span>
                  </div>
                ) : (
                  <div className="h-col method" style={{ visibility: 'hidden' }}></div>
                )}
                <div className="h-col lines">{sale.summary?.productLines ?? sale.items?.length ?? 0}</div>
                <div className="h-col items">{sale.summary?.itemCount ?? 0}</div>
                <div className="h-col totalbs">{formatBs(sale.totals?.bs)}</div>
                <div className="h-col totalusd">{mode === 'sells' ? formatUSD(sale.totals?.usdAdjusted) : formatUSD((sale.items || []).reduce((acc,it) => acc + ((Number(it.unitCostUSD)||0) * (Number(it.quantity)||0)), 0))}</div>
                <div className="h-col expand">
                  <button
                    className="outline secondary small-btn"
                    aria-label="Ver detalles"
                    onClick={() => toggleExpand(sale.id)}
                  >
                    {isOpen ? '−' : '+'}
                  </button>
                </div>
                {isOpen && (
                  <div className="sale-details">
                    <div className="sale-meta">
                      <div><strong>Fecha:</strong> {formatDateDetail(sale.soldAt)}</div>
                      {mode === 'sells' ? (
                        <>
                          <div><strong>Cliente:</strong> {sale.customer?.name || '—'}</div>
                          <div><strong>Cédula:</strong> {sale.customer?.id || '—'}</div>
                          <div><strong>Teléfono:</strong> {sale.customer?.phone || '—'}</div>
                          <div><strong>Dirección:</strong> {sale.customer?.address || '—'}</div>
                          {sale.customer?.notes && (
                            <div className="notes"><strong>Notas:</strong> {sale.customer.notes}</div>
                          )}
                        </>
                      ) : (
                        <>
                          <div><strong>Usuario:</strong> {resolveUserDisplay(sale)}</div>
                        </>
                      )}
                      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '.5rem' }}>
                        {/* For sells show 'Deshacer venta', for buys show 'Devolver compra'. Both use the same refund modal/flow. */}
                        {!isRefunded ? (
                          <button
                            className="outline danger small-btn"
                            disabled={processingRefunds.has(sale.id)}
                            onClick={() => openRefundModal(sale)}
                          >
                            {processingRefunds.has(sale.id) ? 'Procesando...' : (mode === 'sells' ? 'Deshacer venta' : 'Devolver compra')}
                          </button>
                        ) : (
                          <div className="refunded-label">{mode === 'sells' ? 'Venta reembolsada' : 'Compra devuelta'}</div>
                        )}
                      </div>
                    </div>
                    <table className="items-table">
                      <thead>
                        <tr>
                          <th>Producto</th>
                          <th>Cant.</th>
                          <th>USD Unit</th>
                          <th>Bs Unit</th>
                          <th>Subtotal Bs</th>
                          <th>Subtotal USD</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(sale.items || []).map(it => (
                          <tr key={it.productDocId || `${it.name}-${Math.random()}`}>
                            <td>{it.name}</td>
                            <td>{it.quantity}</td>
                            {mode === 'sells' ? (
                              <>
                                <td>{formatUSD(it.unitPriceUSD)}</td>
                                <td>{formatBs(it.unitPriceBs)}</td>
                                <td>{formatBs(it.subtotalBs)}</td>
                                <td>{formatUSD(it.subtotalUsdAdjusted)}</td>
                              </>
                            ) : (
                              // buys: show raw unitCost and subtotal directly from buy doc
                              <>
                                <td>{formatUSD(it.unitCostUSD ?? it.unitCostUSD)}</td>
                                <td>{formatBs(it.unitCostBs ?? it.unitCostBs)}</td>
                                <td>{formatBs(it.subtotalBs ?? it.subtotalBs)}</td>
                                {/* Show USD subtotal for buys as unitCostUSD * quantity (rounded to 2 decimals)
                                    so it matches the displayed USD unit value instead of the adjusted USD computed
                                    via exchange rate conversions. */}
                                <td>{formatUSD(Math.round(((Number(it.unitCostUSD) || 0) * (Number(it.quantity) || 0)) * 100) / 100)}</td>
                              </>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div className="rates-used">
                      <small>Tasas usadas: BCV {sale.ratesUsed?.bcv} | Paralelo {sale.ratesUsed?.paralelo}</small>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="history-footer-actions">
        {!noMoreOlder && filteredSales.length > 0 && (
          <button
            className="outline"
            disabled={loadingMore || loadingLive || !cursor}
            onClick={handleLoadMore}
          >
            {loadingMore ? 'Cargando...' : 'Cargar más antiguas'}
          </button>
        )}
        {noMoreOlder && (
          <span className="no-more">No hay más</span>
        )}
      </div>

      {/* Modal de confirmación de reembolso */}
      {showRefundModal && refundCandidate && (
        <div className="modal-overlay" role="presentation" onMouseDown={() => setShowRefundModal(false)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="refund-modal-title"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <h3 id="refund-modal-title">{mode === 'sells' ? 'Confirmar deshacer venta' : 'Confirmar devolver compra'}</h3>
            <p className="modal-body">
              {mode === 'sells' ? (
                <>¿Deseas marcar la venta realizada el <strong>{formatDateModal(refundCandidate.soldAt)}</strong>{refundCandidate.totals?.bs ? ` por ${formatBs(refundCandidate.totals.bs)}` : ''} como reembolsada y devolver las existencias al inventario?</>
              ) : (
                <>¿Deseas marcar la compra realizada el <strong>{formatDateModal(refundCandidate.boughtAt)}</strong>{refundCandidate.totals?.bs ? ` por ${formatBs(refundCandidate.totals.bs)}` : ''} como devuelta y quitar las existencias del inventario?</>
              )}
              <br/>Esta acción no se podrá deshacer.
            </p>
            <div className="modal-actions">
              <button className="outline" onClick={() => { setShowRefundModal(false); setRefundCandidate(null); }}>
                Cancelar
              </button>
              <button
                className="outline danger"
                onClick={performRefund}
                disabled={processingRefunds.has(refundCandidate.id)}
              >
                {processingRefunds.has(refundCandidate.id) ? 'Procesando...' : (mode === 'sells' ? 'Deshacer venta' : 'Devolver compra')}
              </button>
            </div>
          </div>
        </div>
      )}

    </section>
  );
}

export default History;