import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Send, CheckCircle, XCircle, AlertTriangle, Loader2, Copy, Check, Upload, X } from 'lucide-react';
import { messageApi, type SendMediaInput } from '../services/api';
import { codeLangs, genCode, type CodeLang } from '../lib/apiCode';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useRole } from '../hooks/useRole';
import { useSessionsQuery, useSessionGroupsQuery } from '../hooks/queries';
import { PageHeader } from '../components/PageHeader';
import './MessageTester.css';

// 'ok'          → backend returned an id, message correlated
// 'unconfirmed' → backend returned no error but no id either. Happens when
//                 whatsapp-web.js delivers the send frame but throws while
//                 serializing the confirmation (see adapter.runSend). The
//                 message DID arrive on WhatsApp — the API just couldn't
//                 return an id to correlate it. Not a failure.
// 'error'       → backend threw / network error
type ResponseState = 'ok' | 'unconfirmed' | 'error';

interface ApiResponse {
  state: ResponseState;
  messageId?: string;
  timestamp: string;
  error?: string;
}

const messageTypes = ['text', 'image', 'video', 'audio', 'document', 'location', 'contact'] as const;

export function MessageTester() {
  const { t } = useTranslation();
  useDocumentTitle(t('messageTester.title'));
  const { canWrite } = useRole();
  const { data: allSessions = [], isLoading: loadingSessions } = useSessionsQuery();
  const sessions = allSessions.filter(s => s.status === 'ready');
  const [session, setSession] = useState('');
  const [recipient, setRecipient] = useState('');
  const [recipientType, setRecipientType] = useState<'personal' | 'group'>('personal');
  const [selectedGroup, setSelectedGroup] = useState('');
  const [messageType, setMessageType] = useState<typeof messageTypes[number]>('text');
  const [content, setContent] = useState('');
  const [mediaUrl, setMediaUrl] = useState('');
  // Media input source (URL from web, or file from PC)
  const [mediaSource, setMediaSource] = useState<'url' | 'file'>('url');
  const [fileBase64, setFileBase64] = useState('');
  const [fileMimetype, setFileMimetype] = useState('');
  const [fileName, setFileName] = useState('');
  const [fileSize, setFileSize] = useState(0);
  // Location fields
  const [latitude, setLatitude] = useState('');
  const [longitude, setLongitude] = useState('');
  const [locationDescription, setLocationDescription] = useState('');
  const [locationAddress, setLocationAddress] = useState('');
  // Contact card fields
  const [contactName, setContactName] = useState('');
  const [contactNumber, setContactNumber] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [response, setResponse] = useState<ApiResponse | null>(null);
  const [codeLang, setCodeLang] = useState<CodeLang>('curl');
  const [copied, setCopied] = useState(false);

  const { data: groups = [], isLoading: loadingGroups } = useSessionGroupsQuery(
    session,
    recipientType === 'group',
  );

  useEffect(() => {
    if (sessions.length > 0 && !session) {
      setSession(sessions[0].id);
    }
  }, [sessions, session]);

  useEffect(() => {
    if (groups.length > 0 && !selectedGroup) {
      setSelectedGroup(groups[0].id);
    }
    if (recipientType !== 'group') {
      setSelectedGroup('');
    }
  }, [groups, selectedGroup, recipientType]);

  const handleSend = async () => {
    const targetId = recipientType === 'group' ? selectedGroup : recipient;
    if (!session || !targetId) return;
    setIsLoading(true);
    setResponse(null);

    const chatId = recipientType === 'group' ? targetId : targetId.replace(/[^0-9]/g, '') + '@c.us';

    // Build the media payload for image/video/audio/document based on selected source.
    // Optional fields (caption/filename) are only attached where the backend endpoint uses them.
    const buildMedia = (): SendMediaInput => {
      const media: SendMediaInput =
        mediaSource === 'file'
          ? { base64: fileBase64, mimetype: fileMimetype, filename: fileName || undefined }
          : { url: mediaUrl };
      if (messageType === 'document') {
        // For document, `content` overrides the auto-picked filename from the file
        if (content) media.filename = content;
      } else if (messageType !== 'audio') {
        if (content) media.caption = content;
      }
      return media;
    };

    try {
      let result;
      if (messageType === 'text') {
        result = await messageApi.sendText(session, chatId, content);
      } else if (messageType === 'image') {
        result = await messageApi.sendImage(session, chatId, buildMedia());
      } else if (messageType === 'video') {
        result = await messageApi.sendVideo(session, chatId, buildMedia());
      } else if (messageType === 'audio') {
        result = await messageApi.sendAudio(session, chatId, buildMedia());
      } else if (messageType === 'location') {
        result = await messageApi.sendLocation(
          session,
          chatId,
          Number(latitude),
          Number(longitude),
          locationDescription || undefined,
          locationAddress || undefined,
        );
      } else if (messageType === 'contact') {
        result = await messageApi.sendContact(session, chatId, contactName, contactNumber);
      } else {
        result = await messageApi.sendDocument(session, chatId, buildMedia());
      }

      setResponse({
        state: result.messageId ? 'ok' : 'unconfirmed',
        messageId: result.messageId,
        timestamp: result.timestamp ? new Date(result.timestamp * 1000).toISOString() : new Date().toISOString(),
      });
    } catch (err) {
      setResponse({
        state: 'error',
        timestamp: new Date().toISOString(),
        error: err instanceof Error ? err.message : t('messageTester.sendFailed'),
      });
    } finally {
      setIsLoading(false);
    }
  };

  const onPickFile = (file: File | null) => {
    if (!file) {
      setFileBase64('');
      setFileMimetype('');
      setFileName('');
      setFileSize(0);
      return;
    }
    setFileName(file.name);
    setFileMimetype(file.type || 'application/octet-stream');
    setFileSize(file.size);
    const reader = new FileReader();
    reader.onload = () => {
      const dataUri = reader.result as string;
      // Strip "data:...;base64," prefix — backend wants raw base64
      const comma = dataUri.indexOf(',');
      setFileBase64(comma >= 0 ? dataUri.slice(comma + 1) : '');
    };
    reader.onerror = () => setFileBase64('');
    reader.readAsDataURL(file);
  };

  const clearFile = () => onPickFile(null);

  const formatBytes = (b: number) => {
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / 1024 / 1024).toFixed(2)} MB`;
  };

  const buildApiRequest = (): { path: string; body: Record<string, unknown> } => {
    const targetId = recipientType === 'group' ? selectedGroup : recipient;
    const chatId = recipientType === 'group' ? targetId : `${targetId.replace(/[^0-9]/g, '')}@c.us`;
    const base = `/sessions/${session || 'SESSION_ID'}/messages`;
    // For code samples, we do NOT inline the actual base64 (megabytes of noise).
    // Show a placeholder so the reader knows where their file bytes go.
    const media = (extra: Record<string, unknown>): Record<string, unknown> =>
      mediaSource === 'file'
        ? { chatId, base64: '<BASE64_FILE_CONTENT>', mimetype: fileMimetype || 'application/octet-stream', filename: fileName, ...extra }
        : { chatId, url: mediaUrl, ...extra };
    switch (messageType) {
      case 'image':
        return { path: `${base}/send-image`, body: media({ caption: content }) };
      case 'video':
        return { path: `${base}/send-video`, body: media({ caption: content }) };
      case 'audio':
        return { path: `${base}/send-audio`, body: media({}) };
      case 'document':
        return {
          path: `${base}/send-document`,
          body: media(content ? { filename: content } : {}),
        };
      case 'location':
        return {
          path: `${base}/send-location`,
          body: {
            chatId,
            latitude: Number(latitude) || 0,
            longitude: Number(longitude) || 0,
            description: locationDescription,
            address: locationAddress,
          },
        };
      case 'contact':
        return { path: `${base}/send-contact`, body: { chatId, contactName, contactNumber } };
      default:
        return { path: `${base}/send-text`, body: { chatId, text: content } };
    }
  };

  const apiReq = buildApiRequest();
  const apiUrl = `${window.location.origin}/api${apiReq.path}`;
  const codeSnippet = genCode(codeLang, 'POST', apiUrl, apiReq.body) ?? '';

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(codeSnippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  if (loadingSessions) {
    return (
      <div
        className="message-tester"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '400px' }}
      >
        <Loader2 className="animate-spin" size={32} />
      </div>
    );
  }

  return (
    <div className="message-tester">
      <PageHeader title={t('messageTester.title')} subtitle={t('messageTester.subtitle')} />

      <div className="api-code-card">
        <div className="api-code-header">
          <div>
            <h2>{t('messageTester.api.title')}</h2>
            <p className="hint">{t('messageTester.api.hint')}</p>
          </div>
          <button className="copy-code-btn" onClick={() => void copyCode()}>
            {copied ? <Check size={16} /> : <Copy size={16} />}
            {copied ? t('messageTester.api.copied') : t('messageTester.api.copy')}
          </button>
        </div>

        <div className="lang-tabs">
          {codeLangs.map(l => (
            <button key={l.id} className={codeLang === l.id ? 'active' : ''} onClick={() => setCodeLang(l.id)}>
              {l.label}
            </button>
          ))}
        </div>

        <div className="api-endpoint">
          <span className="api-method">POST</span>
          <span className="api-path mono">{apiUrl}</span>
        </div>

        <pre className="code-block">
          <code>{codeSnippet}</code>
        </pre>
      </div>

      <div className="tester-panels">
        <div className="compose-panel">
          <h2>{t('messageTester.compose')}</h2>

          <div className="form-group">
            <label>{t('messageTester.session')}</label>
            <select value={session} onChange={e => setSession(e.target.value)}>
              {sessions.length === 0 && <option value="">{t('messageTester.noReadySessions')}</option>}
              {sessions.map(s => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.phone || t('messageTester.sessionOptionPhoneNone')})
                </option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label>{t('messageTester.recipientType')}</label>
            <div className="toggle-group">
              <button
                className={recipientType === 'personal' ? 'active' : ''}
                onClick={() => setRecipientType('personal')}
              >
                {t('messageTester.personal')}
              </button>
              <button className={recipientType === 'group' ? 'active' : ''} onClick={() => setRecipientType('group')}>
                {t('messageTester.group')}
              </button>
            </div>
          </div>

          <div className="form-group">
            <label>{recipientType === 'group' ? t('messageTester.selectGroup') : t('messageTester.recipientPhone')}</label>
            {recipientType === 'group' ? (
              <>
                <select
                  value={selectedGroup}
                  onChange={e => setSelectedGroup(e.target.value)}
                  disabled={loadingGroups || groups.length === 0}
                >
                  {loadingGroups && <option value="">{t('messageTester.loadingGroups')}</option>}
                  {!loadingGroups && groups.length === 0 && <option value="">{t('messageTester.noGroupsFound')}</option>}
                  {groups.map(g => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
                <span className="hint">{t('messageTester.selectGroupHint')}</span>
              </>
            ) : (
              <>
                <input
                  type="text"
                  value={recipient}
                  onChange={e => setRecipient(e.target.value)}
                  placeholder="+62812345678"
                />
                <span className="hint">{t('messageTester.phoneHint')}</span>
              </>
            )}
          </div>

          <div className="form-group">
            <label>{t('messageTester.messageType')}</label>
            <div className="toggle-group">
              {messageTypes.map(type => (
                <button
                  key={type}
                  className={messageType === type ? 'active' : ''}
                  onClick={() => setMessageType(type)}
                >
                  {t(`messageTester.types.${type}`)}
                </button>
              ))}
            </div>
          </div>

          {messageType === 'text' ? (
            <div className="form-group">
              <label>{t('messageTester.messageContent')}</label>
              <textarea
                value={content}
                onChange={e => setContent(e.target.value)}
                placeholder={t('messageTester.messagePlaceholder')}
                rows={5}
              />
            </div>
          ) : messageType === 'location' ? (
            <>
              <div className="form-row">
                <div className="form-group">
                  <label>{t('messageTester.location.latitude')}</label>
                  <input
                    type="number"
                    value={latitude}
                    onChange={e => setLatitude(e.target.value)}
                    placeholder="-6.200000"
                  />
                </div>
                <div className="form-group">
                  <label>{t('messageTester.location.longitude')}</label>
                  <input
                    type="number"
                    value={longitude}
                    onChange={e => setLongitude(e.target.value)}
                    placeholder="106.816666"
                  />
                </div>
              </div>
              <div className="form-group">
                <label>
                  {t('messageTester.location.description')} ({t('common.optional')})
                </label>
                <input
                  type="text"
                  value={locationDescription}
                  onChange={e => setLocationDescription(e.target.value)}
                  placeholder={t('messageTester.location.descriptionPlaceholder')}
                />
              </div>
              <div className="form-group">
                <label>
                  {t('messageTester.location.address')} ({t('common.optional')})
                </label>
                <input
                  type="text"
                  value={locationAddress}
                  onChange={e => setLocationAddress(e.target.value)}
                  placeholder={t('messageTester.location.addressPlaceholder')}
                />
              </div>
            </>
          ) : messageType === 'contact' ? (
            <>
              <div className="form-group">
                <label>{t('messageTester.contact.name')}</label>
                <input
                  type="text"
                  value={contactName}
                  onChange={e => setContactName(e.target.value)}
                  placeholder={t('messageTester.contact.namePlaceholder')}
                />
              </div>
              <div className="form-group">
                <label>{t('messageTester.contact.number')}</label>
                <input
                  type="text"
                  value={contactNumber}
                  onChange={e => setContactNumber(e.target.value)}
                  placeholder="+62812345678"
                />
                <span className="hint">{t('messageTester.contact.numberHint')}</span>
              </div>
            </>
          ) : (
            <>
              <div className="form-group">
                <label>{t('messageTester.mediaSource.label')}</label>
                <div className="toggle-group">
                  <button
                    className={mediaSource === 'url' ? 'active' : ''}
                    onClick={() => setMediaSource('url')}
                  >
                    {t('messageTester.mediaSource.url')}
                  </button>
                  <button
                    className={mediaSource === 'file' ? 'active' : ''}
                    onClick={() => setMediaSource('file')}
                  >
                    {t('messageTester.mediaSource.file')}
                  </button>
                </div>
              </div>

              {mediaSource === 'url' ? (
                <div className="form-group">
                  <label>{t('messageTester.mediaUrl')}</label>
                  <input
                    type="text"
                    value={mediaUrl}
                    onChange={e => setMediaUrl(e.target.value)}
                    placeholder="https://example.com/file.jpg"
                  />
                </div>
              ) : (
                <div className="form-group">
                  <label>{t('messageTester.file.label')}</label>
                  {!fileBase64 ? (
                    <label className="file-drop">
                      <Upload size={20} />
                      <span>{t('messageTester.file.pick')}</span>
                      <input
                        type="file"
                        onChange={e => onPickFile(e.target.files?.[0] ?? null)}
                        style={{ display: 'none' }}
                      />
                    </label>
                  ) : (
                    <div className="file-selected">
                      <div className="file-selected-meta">
                        <span className="file-selected-name">{fileName}</span>
                        <span className="file-selected-info">
                          {fileMimetype} · {formatBytes(fileSize)}
                        </span>
                      </div>
                      <button
                        type="button"
                        className="file-clear-btn"
                        onClick={clearFile}
                        title={t('messageTester.file.clear')}
                      >
                        <X size={16} />
                      </button>
                    </div>
                  )}
                  <span className="hint">{t('messageTester.file.hint')}</span>
                </div>
              )}

              {messageType !== 'audio' && (
                <div className="form-group">
                  <label>
                    {messageType === 'document' ? t('messageTester.filename') : t('messageTester.caption')} ({t('common.optional')})
                  </label>
                  <input
                    type="text"
                    value={content}
                    onChange={e => setContent(e.target.value)}
                    placeholder={messageType === 'document' ? t('messageTester.filenamePlaceholder') : t('messageTester.captionPlaceholder')}
                  />
                </div>
              )}
            </>
          )}

          <button
            className="send-btn"
            onClick={handleSend}
            disabled={
              !canWrite ||
              isLoading ||
              !session ||
              (recipientType === 'group' ? !selectedGroup : !recipient) ||
              (messageType === 'location' && (!latitude.trim() || !longitude.trim())) ||
              (messageType === 'contact' && (!contactName.trim() || !contactNumber.trim())) ||
              (['image', 'video', 'audio', 'document'].includes(messageType) &&
                (mediaSource === 'file' ? !fileBase64 : !mediaUrl.trim()))
            }
          >
            {isLoading ? <Loader2 className="animate-spin" size={18} /> : <Send size={18} />}
            {isLoading ? t('messageTester.sending') : canWrite ? t('messageTester.send') : t('messageTester.viewOnly')}
          </button>
        </div>

        <div className="response-panel">
          <h2>{t('messageTester.responseTitle')}</h2>

          {response ? (
            <>
              <div className={`response-status ${response.state}`}>
                {response.state === 'ok' && (
                  <>
                    <CheckCircle size={20} />
                    <span>{t('messageTester.successLabel')}</span>
                  </>
                )}
                {response.state === 'unconfirmed' && (
                  <>
                    <AlertTriangle size={20} />
                    <span>{t('messageTester.unconfirmedLabel')}</span>
                  </>
                )}
                {response.state === 'error' && (
                  <>
                    <XCircle size={20} />
                    <span>{t('messageTester.failedLabel')}</span>
                  </>
                )}
              </div>
              {response.state === 'unconfirmed' && (
                <div className="response-hint">{t('messageTester.unconfirmedHint')}</div>
              )}

              <div className="response-details">
                <div className="detail-row">
                  <span className="detail-label">{t('messageTester.response.timestamp')}</span>
                  <span className="detail-value">{response.timestamp}</span>
                </div>
                {response.messageId && (
                  <div className="detail-row">
                    <span className="detail-label">{t('messageTester.response.messageId')}</span>
                    <span className="detail-value mono">{response.messageId}</span>
                  </div>
                )}
                {response.error && (
                  <div className="detail-row">
                    <span className="detail-label">{t('messageTester.response.error')}</span>
                    <span className="detail-value" style={{ color: '#DC2626' }}>
                      {response.error}
                    </span>
                  </div>
                )}
              </div>

              <div className="response-json">
                <pre>{JSON.stringify(response, null, 2)}</pre>
              </div>
            </>
          ) : (
            <div className="response-empty">
              <p>{t('messageTester.responseEmpty')}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
