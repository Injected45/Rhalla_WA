import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, ShoppingBag, RefreshCw, Send, ExternalLink, ChevronLeft, ChevronRight, X, Code2 } from 'lucide-react';
import { catalogApi, type Catalog as CatalogInfo, type Product } from '../services/api';
import { useSessionsQuery } from '../hooks/queries';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { PageHeader } from '../components/PageHeader';
import { useToast } from '../components/Toast';
import { ApiCodeDialog, type ApiRequestDescriptor } from '../components/ApiCodeDialog';
import './Catalog.css';

export function Catalog() {
  const { t } = useTranslation();
  useDocumentTitle(t('catalog.title'));
  const toast = useToast();

  const { data: allSessions = [] } = useSessionsQuery();
  const sessions = allSessions.filter(s => s.status === 'ready');
  const [session, setSession] = useState('');
  const [error, setError] = useState('');

  const [catalog, setCatalog] = useState<CatalogInfo | null>(null);
  const [loadingCatalog, setLoadingCatalog] = useState(false);

  const [products, setProducts] = useState<Product[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loadingProducts, setLoadingProducts] = useState(false);

  // Send catalog link
  const [catalogChatId, setCatalogChatId] = useState('');
  const [sendingCatalog, setSendingCatalog] = useState(false);

  // Send product modal
  const [sendProductTarget, setSendProductTarget] = useState<Product | null>(null);
  const [productChatId, setProductChatId] = useState('');
  const [productBody, setProductBody] = useState('');
  const [sendingProduct, setSendingProduct] = useState(false);

  const [apiDialog, setApiDialog] = useState<ApiRequestDescriptor | null>(null);
  const sid = session || 'SESSION_ID';

  useEffect(() => {
    if (sessions.length > 0 && !session) setSession(sessions[0].id);
  }, [sessions, session]);

  const loadCatalog = useCallback(async () => {
    if (!session) return;
    setLoadingCatalog(true);
    setError('');
    try {
      setCatalog(await catalogApi.get(session));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setCatalog(null);
    } finally {
      setLoadingCatalog(false);
    }
  }, [session]);

  const loadProducts = useCallback(
    async (p: number) => {
      if (!session) return;
      setLoadingProducts(true);
      setError('');
      try {
        const res = await catalogApi.products(session, p, 20);
        setProducts(res.products);
        setPage(res.pagination.page);
        setTotalPages(res.pagination.totalPages || 1);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setProducts([]);
      } finally {
        setLoadingProducts(false);
      }
    },
    [session],
  );

  const sendCatalogLink = async () => {
    if (!session || !catalogChatId.trim()) return;
    setSendingCatalog(true);
    try {
      await catalogApi.sendCatalog(session, catalogChatId.trim());
      toast.success(t('catalog.toasts.catalogSent'));
      setCatalogChatId('');
    } catch (e) {
      toast.error(t('catalog.toasts.failed'), e instanceof Error ? e.message : undefined);
    } finally {
      setSendingCatalog(false);
    }
  };

  const confirmSendProduct = async () => {
    if (!session || !sendProductTarget || !productChatId.trim()) return;
    setSendingProduct(true);
    try {
      await catalogApi.sendProduct(session, productChatId.trim(), sendProductTarget.id, productBody || undefined);
      toast.success(t('catalog.toasts.productSent'));
      setSendProductTarget(null);
      setProductChatId('');
      setProductBody('');
    } catch (e) {
      toast.error(t('catalog.toasts.failed'), e instanceof Error ? e.message : undefined);
    } finally {
      setSendingProduct(false);
    }
  };

  return (
    <div className="catalog-page">
      <PageHeader title={t('catalog.title')} subtitle={t('catalog.subtitle')} />

      <div className="filters-bar">
        <div className="filter-group">
          <select value={session} onChange={e => setSession(e.target.value)}>
            {sessions.length === 0 && <option value="">{t('catalog.noSessions')}</option>}
            {sessions.map(s => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.phone || '—'})
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && <div className="page-error">{error}</div>}

      {/* Catalog info */}
      <div className="page-card">
        <div className="page-card-header">
          <h2>{t('catalog.info.title')}</h2>
          <div className="card-header-actions">
            <button
              className="dev-api-btn"
              title={t('apiCode.dev')}
              onClick={() => setApiDialog({ method: 'GET', path: `/sessions/${sid}/catalog`, title: t('catalog.info.title') })}
            >
              <Code2 size={16} />
            </button>
            <button className="btn-secondary" onClick={() => void loadCatalog()} disabled={!session}>
              {loadingCatalog ? <Loader2 className="animate-spin" size={18} /> : <RefreshCw size={18} />}
              {t('catalog.info.button')}
            </button>
          </div>
        </div>

        {catalog ? (
          <div className="catalog-info">
            <div className="catalog-info-grid">
              <div>
                <label>{t('catalog.info.name')}</label>
                <span>{catalog.name || '—'}</span>
              </div>
              <div>
                <label>{t('catalog.info.productCount')}</label>
                <span>{catalog.productCount}</span>
              </div>
              <div className="full">
                <label>{t('catalog.info.description')}</label>
                <span>{catalog.description || '—'}</span>
              </div>
              {catalog.url && (
                <div className="full">
                  <label>{t('catalog.info.url')}</label>
                  <a href={catalog.url} target="_blank" rel="noreferrer" className="catalog-link">
                    {catalog.url} <ExternalLink size={13} />
                  </a>
                </div>
              )}
            </div>
          </div>
        ) : (
          <p className="page-hint">{t('catalog.info.empty')}</p>
        )}

        <div className="page-row catalog-send-row">
          <input
            type="text"
            placeholder={t('catalog.info.sendChatPlaceholder')}
            value={catalogChatId}
            onChange={e => setCatalogChatId(e.target.value)}
          />
          <button className="btn-primary" onClick={() => void sendCatalogLink()} disabled={!session || !catalogChatId.trim() || sendingCatalog}>
            {sendingCatalog ? <Loader2 className="animate-spin" size={18} /> : <Send size={18} />}
            {t('catalog.info.sendButton')}
          </button>
        </div>
      </div>

      {/* Products */}
      <div className="page-card">
        <div className="page-card-header">
          <h2>{t('catalog.products.title')}</h2>
          <div className="card-header-actions">
            <button
              className="dev-api-btn"
              title={t('apiCode.dev')}
              onClick={() =>
                setApiDialog({
                  method: 'GET',
                  path: `/sessions/${sid}/catalog/products?page=1&limit=20`,
                  title: t('catalog.products.title'),
                })
              }
            >
              <Code2 size={16} />
            </button>
            <button className="btn-secondary" onClick={() => void loadProducts(1)} disabled={!session}>
              {loadingProducts ? <Loader2 className="animate-spin" size={18} /> : <RefreshCw size={18} />}
              {t('catalog.products.button')}
            </button>
          </div>
        </div>

        {products.length === 0 ? (
          <div className="empty-state-box">
            <ShoppingBag size={48} strokeWidth={1} />
            <p>{t('catalog.products.empty')}</p>
          </div>
        ) : (
          <>
            <div className="product-grid">
              {products.map(p => (
                <div key={p.id} className="product-card">
                  {p.imageUrl ? (
                    <img className="product-image" src={p.imageUrl} alt={p.name} loading="lazy" />
                  ) : (
                    <div className="product-image placeholder">
                      <ShoppingBag size={28} />
                    </div>
                  )}
                  <div className="product-body">
                    <div className="product-name">{p.name}</div>
                    <div className="product-price">{p.priceFormatted || `${p.price} ${p.currency}`}</div>
                    <span className={`product-avail ${p.isAvailable ? 'yes' : 'no'}`}>
                      {p.isAvailable ? t('catalog.products.available') : t('catalog.products.unavailable')}
                    </span>
                    <button className="btn-primary product-send" onClick={() => setSendProductTarget(p)}>
                      <Send size={15} />
                      {t('catalog.products.send')}
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {totalPages > 1 && (
              <div className="catalog-pagination">
                <button className="btn-secondary" onClick={() => void loadProducts(page - 1)} disabled={page <= 1 || loadingProducts}>
                  <ChevronLeft size={16} />
                  {t('catalog.products.prev')}
                </button>
                <span className="page-indicator">{t('catalog.products.pageOf', { page, total: totalPages })}</span>
                <button
                  className="btn-secondary"
                  onClick={() => void loadProducts(page + 1)}
                  disabled={page >= totalPages || loadingProducts}
                >
                  {t('catalog.products.next')}
                  <ChevronRight size={16} />
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {sendProductTarget && (
        <div className="modal-overlay" onClick={() => !sendingProduct && setSendProductTarget(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{t('catalog.send.title', { name: sendProductTarget.name })}</h2>
              <button className="btn-icon" onClick={() => setSendProductTarget(null)} disabled={sendingProduct}>
                <X size={20} />
              </button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label>{t('catalog.send.chatId')}</label>
                <input type="text" value={productChatId} onChange={e => setProductChatId(e.target.value)} placeholder="62812xxxx@c.us" />
              </div>
              <div className="form-group">
                <label>
                  {t('catalog.send.body')} ({t('common.optional')})
                </label>
                <input type="text" value={productBody} onChange={e => setProductBody(e.target.value)} />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setSendProductTarget(null)} disabled={sendingProduct}>
                {t('common.cancel')}
              </button>
              <button className="btn-primary" onClick={() => void confirmSendProduct()} disabled={!productChatId.trim() || sendingProduct}>
                {sendingProduct ? <Loader2 size={16} className="animate-spin" /> : t('catalog.products.send')}
              </button>
            </div>
          </div>
        </div>
      )}

      <ApiCodeDialog request={apiDialog} onClose={() => setApiDialog(null)} />
    </div>
  );
}

export default Catalog;
