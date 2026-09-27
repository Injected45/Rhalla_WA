// API Service Layer for OpenWA Dashboard
// Centralized API client with TypeScript types

const API_BASE_URL = '/api';

// =============================================================================
// Types
// =============================================================================

export interface Session {
  id: string;
  name: string;
  status: 'created' | 'idle' | 'initializing' | 'connecting' | 'qr_ready' | 'ready' | 'disconnected';
  phone?: string;
  pushName?: string;
  lastActive?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionStats {
  total: number;
  active: number;
  ready: number;
  disconnected: number;
  byStatus: Record<string, number>;
  memoryUsage: { heapUsed: number; heapTotal: number; rss: number };
}

export interface Webhook {
  id: string;
  sessionId: string;
  url: string;
  events: string[];
  active: boolean;
  secret?: string;
  createdAt: string;
  updatedAt: string;
}

export type UserRoleName = 'admin' | 'operator' | 'viewer';

export type SubscriptionPlan = 'trial' | 'week' | 'month' | 'year' | 'manual';

export type SubscriptionStatus = 'active' | 'expired' | 'cancelled';

export interface Subscription {
  id: string;
  plan: SubscriptionPlan;
  status: SubscriptionStatus;
  startsAt: string;
  /** null = never expires */
  expiresAt: string | null;
  note: string | null;
  /** null = never expires */
  daysRemaining: number | null;
  isExpired: boolean;
}

export interface User {
  id: string;
  email: string;
  fullName: string | null;
  role: UserRoleName;
  isActive: boolean;
  /** 0 = unlimited */
  maxSessions: number;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
  subscription: Subscription | null;
  sessionCount: number;
}

export interface CreateUserPayload {
  email: string;
  password: string;
  fullName?: string;
  role?: UserRoleName;
  maxSessions?: number;
  plan?: SubscriptionPlan;
  days?: number;
  expiresAt?: string;
  note?: string;
}

export interface UpdateUserPayload {
  fullName?: string;
  role?: UserRoleName;
  isActive?: boolean;
  maxSessions?: number;
}

export interface AssignSubscriptionPayload {
  plan: SubscriptionPlan;
  days?: number;
  expiresAt?: string;
  note?: string;
}

/** Response of POST /auth/login. */
export interface LoginResult {
  apiKey: string;
  role: UserRoleName;
  userId: string;
  email: string;
  subscription: {
    plan: SubscriptionPlan;
    expiresAt: string | null;
    daysRemaining: number | null;
  };
}

export interface ApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  role: UserRoleName;
  allowedIps?: string[];
  allowedSessions?: string[];
  isActive: boolean;
  expiresAt?: string;
  lastUsedAt?: string;
  usageCount: number;
  createdAt: string;
  apiKey?: string; // Only returned on creation
}

export interface AuditLog {
  id: string;
  action: string;
  severity: 'info' | 'warn' | 'error';
  apiKeyId?: string;
  apiKeyName?: string;
  sessionId?: string;
  sessionName?: string;
  ipAddress?: string;
  method?: string;
  path?: string;
  statusCode?: number;
  errorMessage?: string;
  createdAt: string;
}

export interface MessageResponse {
  messageId: string;
  timestamp: number;
}

export interface HealthStatus {
  status: 'ok' | 'error';
  timestamp?: string;
  details?: {
    database?: { status: string };
    redis?: { status: string };
    queue?: { status: string };
  };
}

export interface InfraStatus {
  database: { connected: boolean; type: string; host: string };
  redis: { connected: boolean; host: string; port: number };
  queue: {
    enabled: boolean;
    messages: { pending: number; completed: number; failed: number };
    webhooks: { pending: number; completed: number; failed: number };
  };
  storage: { type: 'local' | 's3'; path?: string; bucket?: string };
  engine: { type: string; headless: boolean };
}

export interface SaveConfigPayload {
  database?: {
    type: 'sqlite' | 'postgres';
    builtIn?: boolean;
    host?: string;
    port?: string;
    username?: string;
    password?: string;
    database?: string;
    poolSize?: number;
    sslEnabled?: boolean;
  };
  redis?: {
    enabled?: boolean;
    builtIn?: boolean;
    host?: string;
    port?: string;
    password?: string;
  };
  queue?: {
    enabled?: boolean;
  };
  storage?: {
    type: 'local' | 's3';
    builtIn?: boolean;
    localPath?: string;
    s3Bucket?: string;
    s3Region?: string;
    s3AccessKey?: string;
    s3SecretKey?: string;
    s3Endpoint?: string;
  };
  engine?: {
    headless?: boolean;
    sessionDataPath?: string;
    browserArgs?: string;
  };
}

export interface Settings {
  general: { apiBaseUrl: string; sessionTimeout: number; autoReconnect: boolean; debugMode: boolean };
  api: { rateLimit: number; rateLimitWindow: number; enableDocs: boolean };
  notifications: { emailEnabled: boolean; notificationEmail: string; webhookAlerts: boolean };
}

// =============================================================================
// API Client
// =============================================================================

async function request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const url = `${API_BASE_URL}${endpoint}`;

  // Get API key from localStorage for authentication
  const apiKey = localStorage.getItem('openwa_api_key');

  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...(apiKey ? { 'X-API-Key': apiKey } : {}),
    ...options.headers,
  };

  const response = await fetch(url, { ...options, headers });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: response.statusText }));

    // A key that the server no longer accepts — revoked, expired, or rotated by
    // a login elsewhere — otherwise dead-ends the UI: every request 401s and
    // nothing offers a way back. Drop it and return to the login screen so the
    // user can get a fresh one.
    if (response.status === 401 && apiKey) {
      localStorage.removeItem('openwa_api_key');
      localStorage.removeItem('openwa_user_role');
      window.location.reload();
    }

    throw new Error(error.message || `HTTP ${response.status}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json();
}

// =============================================================================
// Session API
// =============================================================================

export const sessionApi = {
  list: () => request<Session[]>('/sessions'),
  get: (id: string) => request<Session>(`/sessions/${id}`),
  create: (name: string) =>
    request<Session>('/sessions', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  delete: (id: string) => request<void>(`/sessions/${id}`, { method: 'DELETE' }),
  start: (id: string) => request<Session>(`/sessions/${id}/start`, { method: 'POST' }),
  stop: (id: string) => request<Session>(`/sessions/${id}/stop`, { method: 'POST' }),
  getQR: (id: string) => request<{ qrCode: string; status: string }>(`/sessions/${id}/qr`),
  getStats: () => request<SessionStats>('/sessions/stats/overview'),
  getGroups: (id: string) => request<{ id: string; name: string }[]>(`/sessions/${id}/groups`),
};

// =============================================================================
// Webhook API
// =============================================================================

export const webhookApi = {
  listBySession: (sessionId: string) => request<Webhook[]>(`/sessions/${sessionId}/webhooks`),
  listAll: () => request<Webhook[]>('/webhooks'),
  get: (sessionId: string, id: string) => request<Webhook>(`/sessions/${sessionId}/webhooks/${id}`),
  create: (sessionId: string, data: { url: string; events: string[] }) =>
    request<Webhook>(`/sessions/${sessionId}/webhooks`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  update: (sessionId: string, id: string, data: Partial<Webhook>) =>
    request<Webhook>(`/sessions/${sessionId}/webhooks/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  delete: (sessionId: string, id: string) =>
    request<void>(`/sessions/${sessionId}/webhooks/${id}`, { method: 'DELETE' }),
  test: (sessionId: string, id: string) =>
    request<{ success: boolean; statusCode?: number; error?: string }>(`/sessions/${sessionId}/webhooks/${id}/test`, {
      method: 'POST',
    }),
};

// =============================================================================
// API Key API
// =============================================================================

export const apiKeyApi = {
  list: () => request<ApiKey[]>('/auth/api-keys'),
  get: (id: string) => request<ApiKey>(`/auth/api-keys/${id}`),
  create: (data: {
    name: string;
    role: string;
    allowedIps?: string[];
    allowedSessions?: string[];
    expiresAt?: string;
  }) =>
    request<ApiKey>('/auth/api-keys', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  update: (id: string, data: Partial<ApiKey>) =>
    request<ApiKey>(`/auth/api-keys/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  delete: (id: string) => request<void>(`/auth/api-keys/${id}`, { method: 'DELETE' }),
  revoke: (id: string) => request<ApiKey>(`/auth/api-keys/${id}/revoke`, { method: 'POST' }),
  /** Returns the new secret once; the old one stops working immediately. */
  regenerate: (id: string) => request<ApiKey>(`/auth/api-keys/${id}/regenerate`, { method: 'POST' }),
};

// =============================================================================
// Users API (admin only)
// =============================================================================

export const userApi = {
  list: () => request<User[]>('/admin/users'),
  get: (id: string) => request<User>(`/admin/users/${id}`),
  create: (data: CreateUserPayload) =>
    request<User>('/admin/users', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  update: (id: string, data: UpdateUserPayload) =>
    request<User>(`/admin/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  resetPassword: (id: string, password: string) =>
    request<void>(`/admin/users/${id}/password`, {
      method: 'PATCH',
      body: JSON.stringify({ password }),
    }),
  assignSubscription: (id: string, data: AssignSubscriptionPayload) =>
    request<Subscription>(`/admin/users/${id}/subscription`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  cancelSubscription: (id: string) => request<void>(`/admin/users/${id}/subscription`, { method: 'DELETE' }),
  deactivate: (id: string) => request<void>(`/admin/users/${id}`, { method: 'DELETE' }),
};

// =============================================================================
// Audit/Logs API
// =============================================================================

export const auditApi = {
  list: (params?: { action?: string; severity?: string; limit?: number; offset?: number }) => {
    const query = new URLSearchParams();
    if (params?.action) query.set('action', params.action);
    if (params?.severity) query.set('severity', params.severity);
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.offset) query.set('offset', String(params.offset));
    const queryStr = query.toString();
    return request<{ data: AuditLog[]; total: number }>(`/audit${queryStr ? `?${queryStr}` : ''}`);
  },
};

// =============================================================================
// Message API
// =============================================================================

// Media input for image/video/audio/document. Either `url` (http/https) or
// `base64` (raw base64, no data-URI prefix; requires `mimetype`) — never both.
export interface SendMediaInput {
  url?: string;
  base64?: string;
  mimetype?: string;
  filename?: string;
  caption?: string;
}

export const messageApi = {
  sendText: (sessionId: string, chatId: string, text: string) =>
    request<MessageResponse>(`/sessions/${sessionId}/messages/send-text`, {
      method: 'POST',
      body: JSON.stringify({ chatId, text }),
    }),
  sendImage: (sessionId: string, chatId: string, media: SendMediaInput) =>
    request<MessageResponse>(`/sessions/${sessionId}/messages/send-image`, {
      method: 'POST',
      body: JSON.stringify({ chatId, ...media }),
    }),
  sendVideo: (sessionId: string, chatId: string, media: SendMediaInput) =>
    request<MessageResponse>(`/sessions/${sessionId}/messages/send-video`, {
      method: 'POST',
      body: JSON.stringify({ chatId, ...media }),
    }),
  sendAudio: (sessionId: string, chatId: string, media: SendMediaInput) =>
    request<MessageResponse>(`/sessions/${sessionId}/messages/send-audio`, {
      method: 'POST',
      body: JSON.stringify({ chatId, ...media }),
    }),
  sendDocument: (sessionId: string, chatId: string, media: SendMediaInput) =>
    request<MessageResponse>(`/sessions/${sessionId}/messages/send-document`, {
      method: 'POST',
      body: JSON.stringify({ chatId, ...media }),
    }),
  sendLocation: (
    sessionId: string,
    chatId: string,
    latitude: number,
    longitude: number,
    description?: string,
    address?: string,
  ) =>
    request<MessageResponse>(`/sessions/${sessionId}/messages/send-location`, {
      method: 'POST',
      body: JSON.stringify({ chatId, latitude, longitude, description, address }),
    }),
  sendContact: (sessionId: string, chatId: string, contactName: string, contactNumber: string) =>
    request<MessageResponse>(`/sessions/${sessionId}/messages/send-contact`, {
      method: 'POST',
      body: JSON.stringify({ chatId, contactName, contactNumber }),
    }),
  history: (sessionId: string, params: { limit?: number; offset?: number; chatId?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.limit != null) qs.set('limit', String(params.limit));
    if (params.offset != null) qs.set('offset', String(params.offset));
    if (params.chatId) qs.set('chatId', params.chatId);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request<{ messages: MessageRecord[]; total: number }>(`/sessions/${sessionId}/messages${suffix}`);
  },
  reply: (sessionId: string, chatId: string, quotedMessageId: string, text: string) =>
    request<MessageResponse>(`/sessions/${sessionId}/messages/reply`, {
      method: 'POST',
      body: JSON.stringify({ chatId, quotedMessageId, text }),
    }),
  forward: (sessionId: string, fromChatId: string, toChatId: string, messageId: string) =>
    request<MessageResponse>(`/sessions/${sessionId}/messages/forward`, {
      method: 'POST',
      body: JSON.stringify({ fromChatId, toChatId, messageId }),
    }),
  react: (sessionId: string, chatId: string, messageId: string, emoji: string) =>
    request<{ success: boolean }>(`/sessions/${sessionId}/messages/react`, {
      method: 'POST',
      body: JSON.stringify({ chatId, messageId, emoji }),
    }),
  getReactions: (sessionId: string, chatId: string, messageId: string) =>
    request<MessageReaction[]>(
      `/sessions/${sessionId}/messages/${encodeURIComponent(chatId)}/${encodeURIComponent(messageId)}/reactions`,
    ),
  deleteMessage: (sessionId: string, chatId: string, messageId: string, forEveryone = false) =>
    request<{ success: boolean }>(`/sessions/${sessionId}/messages/delete`, {
      method: 'POST',
      body: JSON.stringify({ chatId, messageId, forEveryone }),
    }),
};

export interface MessageReactionSender {
  senderId: string;
  emoji: string;
  timestamp: number;
}

export interface MessageReaction {
  emoji: string;
  senders: MessageReactionSender[];
}

export interface MessageMediaInfo {
  mimetype?: string;
  filename?: string;
  url?: string;
}

export interface MessageRecord {
  id: string;
  sessionId: string;
  waMessageId?: string;
  chatId: string;
  from: string;
  to: string;
  body: string;
  type: string;
  direction: 'incoming' | 'outgoing';
  status: string;
  timestamp?: number;
  createdAt: string;
  metadata?: { media?: MessageMediaInfo } | null;
}

// =============================================================================
// Group API
// =============================================================================

export interface GroupSummary {
  id: string;
  name: string;
  participantsCount?: number;
  isAdmin?: boolean;
}

export interface GroupParticipantInfo {
  id: string;
  number: string;
  name?: string;
  isAdmin: boolean;
  isSuperAdmin: boolean;
}

export interface GroupInfo {
  id: string;
  name: string;
  description?: string;
  owner?: string;
  createdAt?: number;
  participants: GroupParticipantInfo[];
  isReadOnly?: boolean;
  isAnnounce?: boolean;
}

export interface GroupInviteInfo {
  inviteCode: string;
  inviteLink: string;
  message?: string;
}

const groupBase = (sessionId: string, groupId: string) =>
  `/sessions/${sessionId}/groups/${encodeURIComponent(groupId)}`;

export const groupApi = {
  list: (sessionId: string) => request<GroupSummary[]>(`/sessions/${sessionId}/groups`),
  get: (sessionId: string, groupId: string) => request<GroupInfo>(groupBase(sessionId, groupId)),
  create: (sessionId: string, name: string, participants: string[]) =>
    request<GroupSummary>(`/sessions/${sessionId}/groups`, {
      method: 'POST',
      body: JSON.stringify({ name, participants }),
    }),
  addParticipants: (sessionId: string, groupId: string, participants: string[]) =>
    request<{ success: boolean; message: string }>(`${groupBase(sessionId, groupId)}/participants`, {
      method: 'POST',
      body: JSON.stringify({ participants }),
    }),
  removeParticipants: (sessionId: string, groupId: string, participants: string[]) =>
    request<{ success: boolean; message: string }>(`${groupBase(sessionId, groupId)}/participants`, {
      method: 'DELETE',
      body: JSON.stringify({ participants }),
    }),
  promoteParticipants: (sessionId: string, groupId: string, participants: string[]) =>
    request<{ success: boolean; message: string }>(`${groupBase(sessionId, groupId)}/participants/promote`, {
      method: 'POST',
      body: JSON.stringify({ participants }),
    }),
  demoteParticipants: (sessionId: string, groupId: string, participants: string[]) =>
    request<{ success: boolean; message: string }>(`${groupBase(sessionId, groupId)}/participants/demote`, {
      method: 'POST',
      body: JSON.stringify({ participants }),
    }),
  setSubject: (sessionId: string, groupId: string, subject: string) =>
    request<{ success: boolean; message: string }>(`${groupBase(sessionId, groupId)}/subject`, {
      method: 'PUT',
      body: JSON.stringify({ subject }),
    }),
  setDescription: (sessionId: string, groupId: string, description: string) =>
    request<{ success: boolean; message: string }>(`${groupBase(sessionId, groupId)}/description`, {
      method: 'PUT',
      body: JSON.stringify({ description }),
    }),
  leave: (sessionId: string, groupId: string) =>
    request<{ success: boolean; message: string }>(`${groupBase(sessionId, groupId)}/leave`, {
      method: 'POST',
    }),
  getInviteCode: (sessionId: string, groupId: string) =>
    request<GroupInviteInfo>(`${groupBase(sessionId, groupId)}/invite-code`),
  revokeInviteCode: (sessionId: string, groupId: string) =>
    request<GroupInviteInfo>(`${groupBase(sessionId, groupId)}/invite-code/revoke`, {
      method: 'POST',
    }),
};

// =============================================================================
// Contact API
// =============================================================================

export interface Contact {
  id: string;
  name?: string;
  pushName?: string;
  number: string;
  isMyContact: boolean;
  isBlocked: boolean;
}

export const contactApi = {
  list: (sessionId: string) => request<Contact[]>(`/sessions/${sessionId}/contacts`),
  check: (sessionId: string, number: string) =>
    request<{ number: string; exists: boolean; whatsappId: string | null }>(
      `/sessions/${sessionId}/contacts/check/${encodeURIComponent(number)}`,
    ),
  getProfilePicture: (sessionId: string, contactId: string) =>
    request<{ url: string | null }>(`/sessions/${sessionId}/contacts/${encodeURIComponent(contactId)}/profile-picture`),
};

// =============================================================================
// Label API (WhatsApp Business)
// =============================================================================

export interface Label {
  id: string;
  name: string;
  hexColor: string;
}

export const labelApi = {
  list: (sessionId: string) => request<Label[]>(`/sessions/${sessionId}/labels`),
  get: (sessionId: string, labelId: string) =>
    request<Label>(`/sessions/${sessionId}/labels/${encodeURIComponent(labelId)}`),
  chatLabels: (sessionId: string, chatId: string) =>
    request<Label[]>(`/sessions/${sessionId}/labels/chat/${encodeURIComponent(chatId)}`),
  addToChat: (sessionId: string, chatId: string, labelId: string) =>
    request<{ success: boolean }>(`/sessions/${sessionId}/labels/chat/${encodeURIComponent(chatId)}`, {
      method: 'POST',
      body: JSON.stringify({ labelId }),
    }),
  removeFromChat: (sessionId: string, chatId: string, labelId: string) =>
    request<{ success: boolean }>(
      `/sessions/${sessionId}/labels/chat/${encodeURIComponent(chatId)}/${encodeURIComponent(labelId)}`,
      { method: 'DELETE' },
    ),
};

// =============================================================================
// Channel API (Newsletters)
// =============================================================================

export interface Channel {
  id: string;
  name: string;
  description?: string;
  inviteCode?: string;
  subscriberCount?: number;
  picture?: string;
  verified?: boolean;
  createdAt?: number;
}

export interface ChannelMessage {
  id: string;
  body: string;
  timestamp: number;
  hasMedia: boolean;
  mediaUrl?: string;
}

export const channelApi = {
  list: (sessionId: string) => request<Channel[]>(`/sessions/${sessionId}/channels`),
  get: (sessionId: string, channelId: string) =>
    request<Channel>(`/sessions/${sessionId}/channels/${encodeURIComponent(channelId)}`),
  messages: (sessionId: string, channelId: string, limit?: number) =>
    request<ChannelMessage[]>(
      `/sessions/${sessionId}/channels/${encodeURIComponent(channelId)}/messages${limit ? `?limit=${limit}` : ''}`,
    ),
  subscribe: (sessionId: string, inviteCode: string) =>
    request<Channel>(`/sessions/${sessionId}/channels/subscribe`, {
      method: 'POST',
      body: JSON.stringify({ inviteCode }),
    }),
  unsubscribe: (sessionId: string, channelId: string) =>
    request<{ success: boolean }>(`/sessions/${sessionId}/channels/${encodeURIComponent(channelId)}`, {
      method: 'DELETE',
    }),
};

// =============================================================================
// Status API (Stories)
// =============================================================================

export interface ContactStatus {
  id: string;
  contact: { id: string; name?: string; pushName?: string };
  type: 'text' | 'image' | 'video';
  caption?: string;
  mediaUrl?: string;
  backgroundColor?: string;
  font?: number;
  timestamp: string;
  expiresAt: string;
}

export interface StatusResult {
  statusId: string;
  timestamp: string;
  expiresAt: string;
}

export const statusApi = {
  list: (sessionId: string) => request<{ statuses: ContactStatus[] }>(`/sessions/${sessionId}/status`),
  getContact: (sessionId: string, contactId: string) =>
    request<{ statuses: ContactStatus[] }>(`/sessions/${sessionId}/status/${encodeURIComponent(contactId)}`),
  sendText: (sessionId: string, text: string, backgroundColor?: string, font?: number) =>
    request<StatusResult>(`/sessions/${sessionId}/status/send-text`, {
      method: 'POST',
      body: JSON.stringify({ text, backgroundColor, font }),
    }),
  sendImage: (sessionId: string, image: string, caption?: string) =>
    request<StatusResult>(`/sessions/${sessionId}/status/send-image`, {
      method: 'POST',
      body: JSON.stringify({ image, caption }),
    }),
  sendVideo: (sessionId: string, video: string, caption?: string) =>
    request<StatusResult>(`/sessions/${sessionId}/status/send-video`, {
      method: 'POST',
      body: JSON.stringify({ video, caption }),
    }),
  remove: (sessionId: string, statusId: string) =>
    request<{ message: string }>(`/sessions/${sessionId}/status/${encodeURIComponent(statusId)}`, {
      method: 'DELETE',
    }),
};

// =============================================================================
// Catalog API (WhatsApp Business)
// =============================================================================

export interface Catalog {
  id: string;
  name: string;
  description?: string;
  productCount: number;
  url: string;
}

export interface Product {
  id: string;
  name: string;
  description?: string;
  price: number;
  currency: string;
  priceFormatted: string;
  imageUrl?: string;
  url: string;
  isAvailable: boolean;
  retailerId?: string;
}

export interface PaginatedProducts {
  products: Product[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

export const catalogApi = {
  get: (sessionId: string) => request<Catalog>(`/sessions/${sessionId}/catalog`),
  products: (sessionId: string, page = 1, limit = 20) =>
    request<PaginatedProducts>(`/sessions/${sessionId}/catalog/products?page=${page}&limit=${limit}`),
  product: (sessionId: string, productId: string) =>
    request<Product>(`/sessions/${sessionId}/catalog/products/${encodeURIComponent(productId)}`),
  sendProduct: (sessionId: string, chatId: string, productId: string, body?: string) =>
    request<MessageResponse>(`/sessions/${sessionId}/messages/send-product`, {
      method: 'POST',
      body: JSON.stringify({ chatId, productId, body }),
    }),
  sendCatalog: (sessionId: string, chatId: string, body?: string) =>
    request<MessageResponse>(`/sessions/${sessionId}/messages/send-catalog`, {
      method: 'POST',
      body: JSON.stringify({ chatId, body }),
    }),
};

// =============================================================================
// Health & Infrastructure API
// =============================================================================

export const healthApi = {
  check: () => request<HealthStatus>('/health'),
  ready: () => request<HealthStatus>('/health/ready'),
};

export const infraApi = {
  getStatus: () => request<InfraStatus>('/infra/status'),
  updateConfig: (config: Partial<InfraStatus>) =>
    request<InfraStatus>('/infra/config', {
      method: 'PUT',
      body: JSON.stringify(config),
    }),
  saveConfig: (config: SaveConfigPayload) =>
    request<{ message: string; saved: boolean; envPath: string; profiles: string[] }>('/infra/config', {
      method: 'PUT',
      body: JSON.stringify(config),
    }),
  restart: (profiles?: string[], profilesToRemove?: string[]) =>
    request<{
      message: string;
      restarting: boolean;
      profiles: string[];
      profilesToRemove: string[];
      estimatedTime: number;
    }>('/infra/restart', {
      method: 'POST',
      body: JSON.stringify({ profiles: profiles || [], profilesToRemove: profilesToRemove || [] }),
    }),
  healthCheck: () => request<{ status: string; timestamp: string }>('/infra/health'),
};

// =============================================================================
// Settings API
// =============================================================================

export const settingsApi = {
  get: () => request<Settings>('/settings'),
  update: (settings: Partial<Settings>) =>
    request<Settings>('/settings', {
      method: 'PUT',
      body: JSON.stringify(settings),
    }),
};

// =============================================================================
// Plugin Types
// =============================================================================

export interface PluginConfigSchemaProperty {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  required?: boolean;
  secret?: boolean;
}

export interface PluginConfigSchema {
  type: 'object';
  properties: Record<string, PluginConfigSchemaProperty>;
}

export interface Plugin {
  id: string;
  name: string;
  version: string;
  type: 'engine' | 'storage' | 'queue' | 'auth' | 'extension';
  description?: string;
  author?: string;
  status: 'installed' | 'enabled' | 'disabled' | 'error';
  config: Record<string, unknown>;
  builtIn: boolean;
  provides: string[];
  configSchema?: PluginConfigSchema;
  loadedAt?: string;
  enabledAt?: string;
  error?: string;
}

export interface Engine {
  id: string;
  name: string;
  enabled: boolean;
  features: string[];
}

// =============================================================================
// Plugins API
// =============================================================================

export const pluginsApi = {
  list: () => request<Plugin[]>('/plugins'),
  get: (id: string) => request<Plugin>(`/plugins/${id}`),
  enable: (id: string) =>
    request<{ success: boolean; message: string }>(`/plugins/${id}/enable`, {
      method: 'POST',
    }),
  disable: (id: string) =>
    request<{ success: boolean; message: string }>(`/plugins/${id}/disable`, {
      method: 'POST',
    }),
  updateConfig: (id: string, config: Record<string, unknown>) =>
    request<{ success: boolean; message: string }>(`/plugins/${id}/config`, {
      method: 'PUT',
      body: JSON.stringify({ config }),
    }),
  healthCheck: (id: string) => request<{ healthy: boolean; message?: string }>(`/plugins/${id}/health`),
  getEngines: () => request<Engine[]>('/infra/engines'),
  getCurrentEngine: () => request<{ engineType: string }>('/infra/engines/current'),
};
