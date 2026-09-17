import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiKeyGuard } from './api-key.guard';
import { AuthService } from '../auth.service';
import { SessionAccessService } from '../session-access.service';
import { ApiKey, ApiKeyRole } from '../entities/api-key.entity';

function createMockApiKey(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: 'uuid-1',
    name: 'Test Key',
    keyHash: 'hash',
    keyPrefix: 'owa_k1_xxxx',
    role: ApiKeyRole.OPERATOR,
    ownerUserId: null,
    allowedIps: null,
    allowedSessions: null,
    isActive: true,
    expiresAt: null,
    lastUsedAt: null,
    usageCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function createMockContext(
  headers: Record<string, string> = {},
  params: Record<string, string> = {},
  path = '/api/health',
): ExecutionContext {
  const request = {
    headers,
    params,
    path,
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
  };

  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

describe('ApiKeyGuard', () => {
  let guard: ApiKeyGuard;
  let authService: jest.Mocked<Partial<AuthService>>;
  let sessionAccess: jest.Mocked<Partial<SessionAccessService>>;
  let reflector: jest.Mocked<Reflector>;

  beforeEach(() => {
    authService = {
      validateApiKey: jest.fn(),
      hasPermission: jest.fn(),
    };

    sessionAccess = {
      scopeFor: jest.fn().mockReturnValue(null),
      assertCanAccessSession: jest.fn().mockResolvedValue(undefined),
    };

    reflector = {
      getAllAndOverride: jest.fn(),
    } as unknown as jest.Mocked<Reflector>;

    guard = new ApiKeyGuard(authService as AuthService, sessionAccess as SessionAccessService, reflector);
  });

  it('should allow access to @Public() routes without API key', async () => {
    reflector.getAllAndOverride.mockReturnValueOnce(true); // isPublic = true

    const context = createMockContext();
    const result = await guard.canActivate(context);

    expect(result).toBe(true);
    expect(authService.validateApiKey).not.toHaveBeenCalled();
  });

  it('should reject requests without X-API-Key header', async () => {
    reflector.getAllAndOverride.mockReturnValueOnce(false); // not public

    const context = createMockContext({});

    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    await expect(guard.canActivate(context)).rejects.toThrow('API key is required');
  });

  it('should accept X-API-Key header', async () => {
    reflector.getAllAndOverride
      .mockReturnValueOnce(false) // not public
      .mockReturnValueOnce(undefined); // no required role

    const apiKey = createMockApiKey();
    (authService.validateApiKey as jest.Mock).mockResolvedValue(apiKey);

    const context = createMockContext({ 'x-api-key': 'my-key' });
    const result = await guard.canActivate(context);

    expect(result).toBe(true);
    expect(authService.validateApiKey).toHaveBeenCalledWith('my-key', '127.0.0.1', undefined);
  });

  it('should accept Authorization Bearer header', async () => {
    reflector.getAllAndOverride.mockReturnValueOnce(false).mockReturnValueOnce(undefined);

    const apiKey = createMockApiKey();
    (authService.validateApiKey as jest.Mock).mockResolvedValue(apiKey);

    const context = createMockContext({ authorization: 'Bearer my-bearer-key' });
    const result = await guard.canActivate(context);

    expect(result).toBe(true);
    expect(authService.validateApiKey).toHaveBeenCalledWith('my-bearer-key', '127.0.0.1', undefined);
  });

  it('should reject when API key validation fails', async () => {
    reflector.getAllAndOverride.mockReturnValueOnce(false);

    (authService.validateApiKey as jest.Mock).mockRejectedValue(new UnauthorizedException('Invalid API key'));

    const context = createMockContext({ 'x-api-key': 'bad-key' });

    await expect(guard.canActivate(context)).rejects.toThrow('Invalid API key');
  });

  it('should reject when role permission is insufficient', async () => {
    reflector.getAllAndOverride
      .mockReturnValueOnce(false) // not public
      .mockReturnValueOnce(ApiKeyRole.ADMIN); // required role = ADMIN

    const apiKey = createMockApiKey({ role: ApiKeyRole.VIEWER });
    (authService.validateApiKey as jest.Mock).mockResolvedValue(apiKey);
    (authService.hasPermission as jest.Mock).mockReturnValue(false);

    const context = createMockContext({ 'x-api-key': 'viewer-key' });

    await expect(guard.canActivate(context)).rejects.toThrow('Insufficient permissions');
  });

  it('should pass session ID from route params to validateApiKey', async () => {
    reflector.getAllAndOverride.mockReturnValueOnce(false).mockReturnValueOnce(undefined);

    const apiKey = createMockApiKey();
    (authService.validateApiKey as jest.Mock).mockResolvedValue(apiKey);

    const context = createMockContext({ 'x-api-key': 'key' }, { sessionId: 'sess-123' });
    await guard.canActivate(context);

    expect(authService.validateApiKey).toHaveBeenCalledWith('key', '127.0.0.1', 'sess-123');
  });

  it('should extract client IP from X-Forwarded-For header', async () => {
    reflector.getAllAndOverride.mockReturnValueOnce(false).mockReturnValueOnce(undefined);

    const apiKey = createMockApiKey();
    (authService.validateApiKey as jest.Mock).mockResolvedValue(apiKey);

    const context = createMockContext({
      'x-api-key': 'key',
      'x-forwarded-for': '203.0.113.50, 70.41.3.18',
    });
    await guard.canActivate(context);

    expect(authService.validateApiKey).toHaveBeenCalledWith('key', '203.0.113.50', undefined);
  });

  // ── tenant isolation ──────────────────────────────────────────────

  describe('session ownership', () => {
    beforeEach(() => {
      reflector.getAllAndOverride.mockReturnValue(undefined); // not public, no role required
      (authService.validateApiKey as jest.Mock).mockResolvedValue(createMockApiKey({ ownerUserId: 'user-a' }));
      (authService.hasPermission as jest.Mock).mockReturnValue(true);
    });

    it('should check ownership on a session-scoped route', async () => {
      const context = createMockContext(
        { 'x-api-key': 'key' },
        { sessionId: 'sess-123' },
        '/api/sessions/sess-123/messages/send-text',
      );

      await guard.canActivate(context);

      expect(sessionAccess.assertCanAccessSession).toHaveBeenCalledWith(null, 'sess-123');
      expect(sessionAccess.scopeFor).toHaveBeenCalled();
    });

    it('should reject when the session belongs to another account', async () => {
      (sessionAccess.assertCanAccessSession as jest.Mock).mockRejectedValue(
        new ForbiddenException('This session belongs to another account'),
      );

      const context = createMockContext({ 'x-api-key': 'key' }, { id: 'sess-999' }, '/api/sessions/sess-999');

      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
    });

    it('should NOT treat an :id on a non-session route as a session', async () => {
      // /api/auth/api-keys/:id and /api/admin/users/:id use `id` for their own
      // rows — checking those against the sessions table would 403 wrongly.
      const context = createMockContext({ 'x-api-key': 'key' }, { id: 'key-uuid' }, '/api/auth/api-keys/key-uuid');

      await guard.canActivate(context);

      expect(sessionAccess.assertCanAccessSession).not.toHaveBeenCalled();
    });

    it('should not check ownership on the unparameterised session list', async () => {
      const context = createMockContext({ 'x-api-key': 'key' }, {}, '/api/sessions');

      await guard.canActivate(context);

      expect(sessionAccess.assertCanAccessSession).not.toHaveBeenCalled();
    });
  });
});
