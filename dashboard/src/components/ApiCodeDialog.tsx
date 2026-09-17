import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Copy, Check } from 'lucide-react';
import { codeLangs, genCode, apiUrlFor, type CodeLang } from '../lib/apiCode';
import './ApiCodeDialog.css';

export interface ApiRequestDescriptor {
  method: string;
  path: string;
  body?: Record<string, unknown>;
  title?: string;
}

interface ApiCodeDialogProps {
  request: ApiRequestDescriptor | null;
  onClose: () => void;
}

export function ApiCodeDialog({ request, onClose }: ApiCodeDialogProps) {
  const { t } = useTranslation();
  const [lang, setLang] = useState<CodeLang>('curl');
  const [copied, setCopied] = useState(false);

  if (!request) return null;

  const url = apiUrlFor(request.path);
  const code = genCode(lang, request.method, url, request.body) ?? '';

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal api-code-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{request.title || t('apiCode.title')}</h2>
          <button className="btn-icon" onClick={onClose}>
            <X size={20} />
          </button>
        </div>

        <div className="modal-body">
          <p className="api-code-hint">{t('apiCode.hint')}</p>

          <div className="lang-tabs">
            {codeLangs.map(l => (
              <button key={l.id} className={lang === l.id ? 'active' : ''} onClick={() => setLang(l.id)}>
                {l.label}
              </button>
            ))}
          </div>

          <div className="api-endpoint">
            <span className={`api-method ${request.method.toLowerCase()}`}>{request.method.toUpperCase()}</span>
            <span className="api-path mono">{url}</span>
          </div>

          <pre className="code-block">
            <code>{code}</code>
          </pre>
        </div>

        <div className="modal-footer">
          <button className="copy-code-btn" onClick={() => void copy()}>
            {copied ? <Check size={16} /> : <Copy size={16} />}
            {copied ? t('apiCode.copied') : t('apiCode.copy')}
          </button>
        </div>
      </div>
    </div>
  );
}
