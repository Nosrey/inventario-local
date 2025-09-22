import React, { useEffect, useState, useMemo, useCallback } from 'react';
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
  const { inventories } = useData();
  const [liveSales, setLiveSales] = useState([]);
  const [olderSales, setOlderSales] = useState([]);
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

  // Listener real-time últimas ventas
  useEffect(() => {
    setLoadingLive(true);
    const sellsRef = collection(db, 'history', 'main', 'sells');
    const qLive = query(sellsRef, orderBy('soldAt', 'desc'), limit(PAGE_SIZE_LIVE));

    const unsub = onSnapshot(qLive, (snap) => {
      const next = snap.docs.map(docSnap => {
        const data = docSnap.data();
        return {
          id: docSnap.id,
          soldAt: data.soldAt || null,
          ...data
        };
      });
      setLiveSales(next);
      // Actualiza cursor solo si aún no hemos cargado older (para evitar saltos)
      if (snap.docs.length > 0 && olderSales.length === 0) {
        setCursor(snap.docs[snap.docs.length - 1]);
      }
      setLoadingLive(false);
    }, (err) => {
      console.error('Error live sells:', err);
      setError('No se pudo cargar el historial reciente.');
      setLoadingLive(false);
    });

    return () => unsub();
  }, [olderSales.length]);

  const handleLoadMore = useCallback(async () => {
    if (loadingMore || noMoreOlder || loadingLive) return;
    if (!cursor) {
      // Si aún no hay cursor (todavía no llegaron ventas), evita llamada
      return;
    }
    try {
      setLoadingMore(true);
      const sellsRef = collection(db, 'history', 'main', 'sells');
      const qOlder = query(
        sellsRef,
        orderBy('soldAt', 'desc'),
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
        batch.push({
          id: docSnap.id,
            soldAt: data.soldAt || null,
            ...data
        });
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

  const summary = useMemo(() => {
    // Excluir ventas reembolsadas de todos los totales (ventas, líneas, ítems y montos)
    const active = filteredSales.filter(s => !s.refunded);
    let totalBs = 0;
    let totalUsdAdj = 0;
    let lines = 0;
    let units = 0;

    active.forEach(s => {
      totalBs += Number(s.totals?.bs) || 0;
      totalUsdAdj += Number(s.totals?.usdAdjusted) || 0;
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
        batch.update(inventoryRef, { [fieldPath]: increment(Number(it.quantity || 0)) });
      });

      await batch.commit();

      // éxito: limpiar mensaje de error y actualizar estado local
      setError('');
      setLiveSales(prev => prev.map(s => s.id === sale.id ? { ...s, refunded: true } : s));
      setOlderSales(prev => prev.map(s => s.id === sale.id ? { ...s, refunded: true } : s));
      setRefundCandidate(null);
      console.log('Refund committed for', sale.id);
    } catch (err) {
      console.error('Error refunding sale:', err);
      setError('No se pudo deshacer la venta. Revisa consola de debug.');
    } finally {
      setProcessingRefunds(prev => {
        const next = new Set(prev);
        next.delete(sale.id);
        return next;
      });
    }
  }, [refundCandidate]);

  return (
    <section className="history-wrapper">
      <header className="history-header">
        <div>
          <h1>Historial de Ventas</h1>
          <p className="muted">Registros recientes en tiempo real. Carga más para ver ventas antiguas.</p>
        </div>
        <div className="history-summary">
          <div><strong>{summary.sales}</strong><span>Ventas</span></div>
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
        <div className="history-table-head">
          <div className="h-col date">Fecha</div>
          <div className="h-col customer">Cliente</div>
          <div className="h-col inv">Inventario</div>
          <div className="h-col method">Método</div>
          <div className="h-col lines">Líneas</div>
          <div className="h-col items">Ítems</div>
          <div className="h-col totalbs">Total Bs</div>
          <div className="h-col totalusd">Total USD</div>
          <div className="h-col expand"></div>
        </div>
        <div className="history-rows">
          {filteredSales.length === 0 && !loadingLive && (
            <div className="history-empty">Sin resultados con los filtros actuales.</div>
          )}
          {filteredSales.map(sale => {
            const isOpen = expanded.has(sale.id);
            const isRefunded = !!sale.refunded;
            return (
              <div
                key={sale.id}
                className={`history-row ${isOpen ? 'open' : ''} ${isRefunded ? 'refunded' : ''}`}
                title={`ID interno: ${sale.id}`}
              >
                <div className="h-col date">{formatDateList(sale.soldAt)}</div>
                <div className="h-col customer">{sale.customer?.name || '—'}</div>
                <div className="h-col inv" title={sale.inventoryName}>{sale.inventoryName || sale.inventoryId}</div>
                <div className="h-col method">
                  <span className={`pm-badge pm-${sale.paymentMethod || 'na'}`}>
                    {(sale.paymentMethod || '').replace('_', ' ') || '—'}
                  </span>
                  {/* removed inline refunded badge to avoid layout break */}
                </div>
                <div className="h-col lines">{sale.summary?.productLines ?? sale.items?.length ?? 0}</div>
                <div className="h-col items">{sale.summary?.itemCount ?? 0}</div>
                <div className="h-col totalbs">{formatBs(sale.totals?.bs)}</div>
                <div className="h-col totalusd">{formatUSD(sale.totals?.usdAdjusted)}</div>
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
                      <div><strong>Cliente:</strong> {sale.customer?.name || '—'}</div>
                      <div><strong>Cédula:</strong> {sale.customer?.id || '—'}</div>
                      <div><strong>Teléfono:</strong> {sale.customer?.phone || '—'}</div>
                      <div><strong>Dirección:</strong> {sale.customer?.address || '—'}</div>
                      {sale.customer?.notes && (
                        <div className="notes"><strong>Notas:</strong> {sale.customer.notes}</div>
                      )}
                      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '.5rem' }}>
                        {!isRefunded ? (
                          <button
                            className="outline danger small-btn"
                            disabled={processingRefunds.has(sale.id)}
                            onClick={() => openRefundModal(sale)}
                          >
                            {processingRefunds.has(sale.id) ? 'Procesando...' : 'Deshacer venta'}
                          </button>
                        ) : (
                          <div className="refunded-label">Venta reembolsada</div>
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
                            <td>{formatUSD(it.unitPriceUSD)}</td>
                            <td>{formatBs(it.unitPriceBs)}</td>
                            <td>{formatBs(it.subtotalBs)}</td>
                            <td>{formatUSD(it.subtotalUsdAdjusted)}</td>
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
            <h3 id="refund-modal-title">Confirmar deshacer venta</h3>
            <p className="modal-body">
              ¿Deseas marcar la venta realizada el <strong>{formatDateModal(refundCandidate.soldAt)}</strong>
              {refundCandidate.totals?.bs ? ` por ${formatBs(refundCandidate.totals.bs)}` : ''} como reembolsada y devolver las existencias al inventario?
              Esta acción no se podrá deshacer.
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
                {processingRefunds.has(refundCandidate.id) ? 'Procesando...' : 'Deshacer venta'}
              </button>
            </div>
          </div>
        </div>
      )}

    </section>
  );
}

export default History;