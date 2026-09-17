import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import {
  Puzzle,
  Power,
  PowerOff,
  Settings,
  CheckCircle,
  AlertCircle,
  Loader2,
  RefreshCw,
  Cpu,
  Database,
  Server,
  Shield,
  Zap,
  X,
  Info,
} from 'lucide-react';
import { pluginsApi } from '../services/api';
import type { Plugin } from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import {
  usePluginsQuery,
  useEnginesQuery,
  useCurrentEngineQuery,
  useInfraStatusQuery,
  queryKeys,
} from '../hooks/queries';
import { PageHeader } from '../components/PageHeader';
import { useToast } from '../components/Toast';
import './Plugins.css';

type PluginType = 'engine' | 'storage' | 'queue' | 'auth' | 'extension';

const pluginTypeIcons: Record<PluginType, typeof Puzzle> = {
  engine: Cpu,
  storage: Database,
  queue: Server,
  auth: Shield,
  extension: Zap,
};

interface EngineConfig {
  type: string;
  headless: boolean;
  sessionDataPath: string;
  browserArgs: string;
}

export default function Plugins() {
  const { t } = useTranslation();
  useDocumentTitle(t('plugins.title'));
  const toast = useToast();
  const queryClient = useQueryClient();
  const { data: plugins = [], isLoading: loadingPlugins, error: queryError } = usePluginsQuery();
  const { data: engines = [] } = useEnginesQuery();
  const { data: currentEngineData } = useCurrentEngineQuery();
  const { data: infraStatus } = useInfraStatusQuery();
  const currentEngine = currentEngineData?.engineType ?? '';
  const loading = loadingPlugins;
  const error = queryError instanceof Error ? queryError.message : null;
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const [showConfigModal, setShowConfigModal] = useState(false);
  const [configPlugin, setConfigPlugin] = useState<Plugin | null>(null);
  const [engineConfig, setEngineConfig] = useState<EngineConfig>({
    type: infraStatus?.engine?.type || 'whatsapp-web.js',
    headless: infraStatus?.engine?.headless ?? true,
    sessionDataPath: '/data/sessions',
    browserArgs: '--no-sandbox --disable-gpu',
  });
  const [schemaConfig, setSchemaConfig] = useState<Record<string, unknown>>({});
  const [savingConfig, setSavingConfig] = useState(false);

  const [showDetailsModal, setShowDetailsModal] = useState(false);
  const [detailsPlugin, setDetailsPlugin] = useState<Plugin | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);

  const [showAllFeatures, setShowAllFeatures] = useState(false);

  const refetchAll = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.plugins });
    void queryClient.invalidateQueries({ queryKey: queryKeys.engines });
    void queryClient.invalidateQueries({ queryKey: queryKeys.currentEngine });
  };

  const handleToggle = async (plugin: Plugin) => {
    setActionLoading(plugin.id);
    try {
      if (plugin.status === 'enabled') {
        await pluginsApi.disable(plugin.id);
      } else {
        await pluginsApi.enable(plugin.id);
      }
      refetchAll();
    } catch (err) {
      toast.error(t('plugins.toasts.errorTitle'), err instanceof Error ? err.message : t('plugins.toasts.errorDefault'));
    } finally {
      setActionLoading(null);
    }
  };

  const handleHealthCheck = async (pluginId: string) => {
    setActionLoading(pluginId);
    try {
      const result = await pluginsApi.healthCheck(pluginId);
      if (result.healthy) {
        toast.success(t('plugins.toasts.healthOk'), result.message);
      } else {
        toast.warning(t('plugins.toasts.healthFail'), result.message);
      }
    } catch (err) {
      toast.error(t('plugins.toasts.healthError'), err instanceof Error ? err.message : t('common.unknownError'));
    } finally {
      setActionLoading(null);
    }
  };

  const hasConfigSchema = (plugin: Plugin | null): boolean =>
    !!plugin?.configSchema && Object.keys(plugin.configSchema.properties).length > 0;

  const handleOpenConfig = (plugin: Plugin) => {
    setConfigPlugin(plugin);
    if (plugin.type === 'engine') {
      setEngineConfig({
        type: plugin.id || 'whatsapp-web.js',
        headless: (plugin.config?.headless as boolean) ?? infraStatus?.engine?.headless ?? true,
        sessionDataPath: (plugin.config?.sessionDataPath as string) || '/data/sessions',
        browserArgs: (plugin.config?.browserArgs as string) || '--no-sandbox --disable-gpu',
      });
    } else if (plugin.configSchema) {
      const initial: Record<string, unknown> = {};
      for (const [key, prop] of Object.entries(plugin.configSchema.properties)) {
        initial[key] = plugin.config?.[key] ?? prop.default ?? (prop.type === 'boolean' ? false : '');
      }
      setSchemaConfig(initial);
    }
    setShowConfigModal(true);
  };

  const handleSaveConfig = async () => {
    if (!configPlugin) return;
    setSavingConfig(true);
    try {
      const config: Record<string, unknown> =
        configPlugin.type === 'engine'
          ? {
              headless: engineConfig.headless,
              sessionDataPath: engineConfig.sessionDataPath,
              browserArgs: engineConfig.browserArgs,
            }
          : schemaConfig;
      const result = await pluginsApi.updateConfig(configPlugin.id, config);
      if (result.success) {
        toast.success(t('plugins.toasts.savedTitle'), result.message || t('plugins.toasts.savedDesc'));
        setShowConfigModal(false);
        refetchAll();
      } else {
        toast.error(t('plugins.toasts.saveFailed'), result.message);
      }
    } catch (err) {
      toast.error(t('plugins.toasts.saveFailed'), err instanceof Error ? err.message : t('common.unknownError'));
    } finally {
      setSavingConfig(false);
    }
  };

  const handleOpenDetails = async (plugin: Plugin) => {
    setDetailsPlugin(plugin);
    setShowDetailsModal(true);
    setDetailsLoading(true);
    try {
      const full = await pluginsApi.get(plugin.id);
      setDetailsPlugin(full);
    } catch (err) {
      toast.error(t('plugins.toasts.detailsError'), err instanceof Error ? err.message : t('common.unknownError'));
    } finally {
      setDetailsLoading(false);
    }
  };

  if (loading) {
    return (
      <div
        className="plugins-page"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '400px' }}
      >
        <Loader2 className="animate-spin" size={32} />
      </div>
    );
  }

  const activeEngine = engines.find(e => e.id === currentEngine);

  return (
    <div className="plugins-page">
      <PageHeader
        title={t('plugins.title')}
        subtitle={t('plugins.subtitle')}
        actions={
          <button className="btn-secondary" onClick={refetchAll}>
            <RefreshCw size={16} />
            {t('plugins.refresh')}
          </button>
        }
      />

      {error && (
        <div className="error-banner">
          <AlertCircle size={20} />
          <span className="error-banner-text">{error}</span>
        </div>
      )}

      <div className="engine-card">
        <div className="engine-header">
          <div className="engine-info">
            <div className="engine-icon-wrapper">
              <Cpu size={24} />
            </div>
            <div>
              <h3 className="engine-title">{t('plugins.engineCard')}</h3>
              <span className="engine-name">{currentEngine}</span>
            </div>
          </div>
          <span className="status-badge connected">{t('plugins.running')}</span>
        </div>

        {activeEngine && activeEngine.features.length > 0 && (
          <div className="engine-features">
            <p className="features-label">{t('plugins.supportedFeatures')}</p>
            <div className="features-list">
              {(showAllFeatures ? activeEngine.features : activeEngine.features.slice(0, 8)).map(feature => (
                <span key={feature} className="feature-tag">
                  {feature}
                </span>
              ))}
              {activeEngine.features.length > 8 && (
                <button
                  type="button"
                  className="feature-more"
                  onClick={() => setShowAllFeatures(v => !v)}
                  aria-expanded={showAllFeatures}
                >
                  {showAllFeatures
                    ? t('plugins.showLess')
                    : t('plugins.more', { count: activeEngine.features.length - 8 })}
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="plugins-grid">
        {plugins.map(plugin => {
          const TypeIcon = pluginTypeIcons[plugin.type as PluginType] || Puzzle;
          const isLoading = actionLoading === plugin.id;

          return (
            <div key={plugin.id} className="plugin-card">
              <div className={`plugin-card-header type-${plugin.type}`}>
                <div className="plugin-info">
                  <div className="plugin-icon-wrapper">
                    <TypeIcon size={20} />
                  </div>
                  <div>
                    <h3 className="plugin-name">{plugin.name}</h3>
                    <span className="plugin-version">v{plugin.version}</span>
                  </div>
                </div>
                {plugin.builtIn && <span className="plugin-builtin-badge">{t('plugins.builtIn')}</span>}
              </div>

              <div className="plugin-card-body">
                <p className="plugin-description">{plugin.description || t('plugins.noDescription')}</p>

                <div className="plugin-status-row">
                  <div className="plugin-status">
                    <span className={`status-dot ${plugin.status}`} />
                    <span className="status-text">{plugin.status}</span>
                  </div>
                  <span className="plugin-type-label">{plugin.type}</span>
                </div>

                {plugin.error && (
                  <div className="plugin-error">
                    <p className="plugin-error-text">{plugin.error}</p>
                  </div>
                )}

                {plugin.provides && plugin.provides.length > 0 && (
                  <div className="plugin-provides">
                    {plugin.provides.map(item => (
                      <span key={item} className="provides-tag">
                        {item}
                      </span>
                    ))}
                  </div>
                )}

                <div className="plugin-actions">
                  {plugin.type === 'engine' ? (
                    (() => {
                      const enginePlugins = plugins.filter(p => p.type === 'engine');
                      const isOnlyEngine = enginePlugins.length === 1;
                      const isActive = plugin.status === 'enabled';

                      if (isOnlyEngine && isActive) {
                        return (
                          <span className="btn-required">
                            <CheckCircle size={16} />
                            {t('plugins.required')}
                          </span>
                        );
                      } else if (isActive) {
                        return (
                          <span className="btn-active">
                            <CheckCircle size={16} />
                            {t('plugins.active')}
                          </span>
                        );
                      } else {
                        return (
                          <button
                            onClick={() => handleToggle(plugin)}
                            disabled={isLoading}
                            className="btn-toggle enable"
                          >
                            {isLoading ? (
                              <Loader2 size={16} className="animate-spin" />
                            ) : (
                              <>
                                <Power size={16} />
                                {t('plugins.activate')}
                              </>
                            )}
                          </button>
                        );
                      }
                    })()
                  ) : (
                    <button
                      onClick={() => handleToggle(plugin)}
                      disabled={isLoading}
                      className={`btn-toggle ${plugin.status === 'enabled' ? 'disable' : 'enable'}`}
                    >
                      {isLoading ? (
                        <Loader2 size={16} className="animate-spin" />
                      ) : plugin.status === 'enabled' ? (
                        <>
                          <PowerOff size={16} />
                          {t('plugins.disable')}
                        </>
                      ) : (
                        <>
                          <Power size={16} />
                          {t('plugins.enable')}
                        </>
                      )}
                    </button>
                  )}

                  <button
                    onClick={() => handleOpenDetails(plugin)}
                    className="btn-action"
                    title={t('plugins.details')}
                  >
                    <Info size={16} />
                  </button>

                  <button
                    onClick={() => handleHealthCheck(plugin.id)}
                    disabled={isLoading}
                    className="btn-action"
                    title={t('plugins.healthCheck')}
                  >
                    <CheckCircle size={16} />
                  </button>

                  <button className="btn-action" title={t('plugins.configure')} onClick={() => handleOpenConfig(plugin)}>
                    <Settings size={16} />
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {plugins.length === 0 && !loading && (
        <div className="empty-state">
          <Puzzle size={64} />
          <h3>{t('plugins.empty.title')}</h3>
          <p>{t('plugins.empty.description')}</p>
        </div>
      )}

      {showConfigModal && configPlugin && (
        <div className="modal-overlay" onClick={() => setShowConfigModal(false)}>
          <div className="modal config-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{t('plugins.config.title', { name: configPlugin.name })}</h2>
              <button className="btn-icon" onClick={() => setShowConfigModal(false)}>
                <X size={20} />
              </button>
            </div>

            <div className="modal-body">
              {configPlugin.type === 'engine' ? (
                <>
                  <div className="config-info-banner">
                    <AlertCircle size={16} />
                    <span>{t('plugins.config.restartNotice')}</span>
                  </div>

                  <div className="config-form">
                    <div className="form-group">
                      <label>{t('plugins.config.engineType')}</label>
                      <select
                        value={engineConfig.type}
                        onChange={e => setEngineConfig({ ...engineConfig, type: e.target.value })}
                      >
                        <option value="whatsapp-web.js">WhatsApp Web.js</option>
                      </select>
                    </div>

                    <div className="form-group toggle-group">
                      <div className="toggle-info">
                        <label>{t('plugins.config.headless')}</label>
                        <small>{t('plugins.config.headlessDesc')}</small>
                      </div>
                      <label className="toggle-switch">
                        <input
                          type="checkbox"
                          checked={engineConfig.headless}
                          onChange={e => setEngineConfig({ ...engineConfig, headless: e.target.checked })}
                        />
                        <span className="toggle-slider"></span>
                      </label>
                    </div>

                    <div className="form-group">
                      <label>{t('plugins.config.sessionDataPath')}</label>
                      <input
                        type="text"
                        value={engineConfig.sessionDataPath}
                        onChange={e => setEngineConfig({ ...engineConfig, sessionDataPath: e.target.value })}
                      />
                    </div>

                    <div className="form-group">
                      <label>{t('plugins.config.browserArgs')}</label>
                      <input
                        type="text"
                        value={engineConfig.browserArgs}
                        onChange={e => setEngineConfig({ ...engineConfig, browserArgs: e.target.value })}
                        placeholder="--no-sandbox --disable-gpu"
                      />
                    </div>
                  </div>
                </>
              ) : hasConfigSchema(configPlugin) ? (
                <div className="config-form">
                  {Object.entries(configPlugin.configSchema!.properties).map(([key, prop]) => {
                    const value = schemaConfig[key];
                    const label = prop.title || key;
                    if (prop.type === 'boolean') {
                      return (
                        <div className="form-group toggle-group" key={key}>
                          <div className="toggle-info">
                            <label>{label}</label>
                            {prop.description && <small>{prop.description}</small>}
                          </div>
                          <label className="toggle-switch">
                            <input
                              type="checkbox"
                              checked={Boolean(value)}
                              onChange={e => setSchemaConfig({ ...schemaConfig, [key]: e.target.checked })}
                            />
                            <span className="toggle-slider"></span>
                          </label>
                        </div>
                      );
                    }
                    return (
                      <div className="form-group" key={key}>
                        <label>{label}</label>
                        {prop.enum && prop.enum.length > 0 ? (
                          <select
                            value={String(value ?? '')}
                            onChange={e => setSchemaConfig({ ...schemaConfig, [key]: e.target.value })}
                          >
                            {prop.enum.map(opt => (
                              <option key={String(opt)} value={String(opt)}>
                                {String(opt)}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <input
                            type={prop.secret ? 'password' : prop.type === 'number' ? 'number' : 'text'}
                            value={value === undefined || value === null ? '' : String(value)}
                            onChange={e =>
                              setSchemaConfig({
                                ...schemaConfig,
                                [key]: prop.type === 'number' ? Number(e.target.value) : e.target.value,
                              })
                            }
                          />
                        )}
                        {prop.description && <small className="field-hint">{prop.description}</small>}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="no-config">
                  <Settings size={48} style={{ opacity: 0.3 }} />
                  <p>{t('plugins.config.noOptions')}</p>
                </div>
              )}
            </div>

            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setShowConfigModal(false)}>
                {t('common.cancel')}
              </button>
              {(configPlugin.type === 'engine' || hasConfigSchema(configPlugin)) && (
                <button className="btn-primary" onClick={handleSaveConfig} disabled={savingConfig}>
                  {savingConfig ? <Loader2 size={16} className="animate-spin" /> : t('plugins.config.save')}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {showDetailsModal && detailsPlugin && (
        <div className="modal-overlay" onClick={() => setShowDetailsModal(false)}>
          <div className="modal details-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{t('plugins.detailsModal.title', { name: detailsPlugin.name })}</h2>
              <button className="btn-icon" onClick={() => setShowDetailsModal(false)}>
                <X size={20} />
              </button>
            </div>

            <div className="modal-body">
              {detailsLoading ? (
                <div style={{ display: 'flex', justifyContent: 'center', padding: '2rem' }}>
                  <Loader2 className="animate-spin" size={28} />
                </div>
              ) : (
                <div className="details-list">
                  <div className="detail-row">
                    <span className="detail-label">{t('plugins.detailsModal.id')}</span>
                    <span className="detail-value">{detailsPlugin.id}</span>
                  </div>
                  <div className="detail-row">
                    <span className="detail-label">{t('plugins.detailsModal.version')}</span>
                    <span className="detail-value">{detailsPlugin.version}</span>
                  </div>
                  <div className="detail-row">
                    <span className="detail-label">{t('plugins.detailsModal.type')}</span>
                    <span className="detail-value">{detailsPlugin.type}</span>
                  </div>
                  <div className="detail-row">
                    <span className="detail-label">{t('plugins.detailsModal.status')}</span>
                    <span className="detail-value">
                      <span className={`status-dot ${detailsPlugin.status}`} /> {detailsPlugin.status}
                    </span>
                  </div>
                  <div className="detail-row">
                    <span className="detail-label">{t('plugins.detailsModal.author')}</span>
                    <span className="detail-value">{detailsPlugin.author || t('plugins.detailsModal.notSet')}</span>
                  </div>
                  <div className="detail-row">
                    <span className="detail-label">{t('plugins.detailsModal.loadedAt')}</span>
                    <span className="detail-value">
                      {detailsPlugin.loadedAt
                        ? new Date(detailsPlugin.loadedAt).toLocaleString()
                        : t('plugins.detailsModal.notSet')}
                    </span>
                  </div>
                  <div className="detail-row">
                    <span className="detail-label">{t('plugins.detailsModal.enabledAt')}</span>
                    <span className="detail-value">
                      {detailsPlugin.enabledAt
                        ? new Date(detailsPlugin.enabledAt).toLocaleString()
                        : t('plugins.detailsModal.notSet')}
                    </span>
                  </div>
                  <div className="detail-row detail-row-block">
                    <span className="detail-label">{t('plugins.detailsModal.provides')}</span>
                    {detailsPlugin.provides && detailsPlugin.provides.length > 0 ? (
                      <div className="plugin-provides">
                        {detailsPlugin.provides.map(item => (
                          <span key={item} className="provides-tag">
                            {item}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="detail-value">{t('plugins.detailsModal.notSet')}</span>
                    )}
                  </div>
                  {detailsPlugin.error && (
                    <div className="detail-row detail-row-block">
                      <span className="detail-label">{t('plugins.detailsModal.error')}</span>
                      <div className="plugin-error">
                        <p className="plugin-error-text">{detailsPlugin.error}</p>
                      </div>
                    </div>
                  )}
                  <div className="detail-row detail-row-block">
                    <span className="detail-label">{t('plugins.detailsModal.config')}</span>
                    <pre className="detail-config">{JSON.stringify(detailsPlugin.config ?? {}, null, 2)}</pre>
                  </div>
                </div>
              )}
            </div>

            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setShowDetailsModal(false)}>
                {t('common.close')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
