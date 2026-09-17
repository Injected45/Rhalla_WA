import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ForbiddenException } from '@nestjs/common';
import { SessionAccessService } from './session-access.service';
import { ApiKey, ApiKeyRole } from './entities/api-key.entity';
import { Session, SessionStatus } from '../session/entities/session.entity';

function createMockSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    name: 'tenant-session',
    status: SessionStatus.READY,
    phone: null,
    pushName: null,
    config: {},
    proxyUrl: null,
    proxyType: null,
    ownerUserId: 'user-a',
    connectedAt: null,
    lastActiveAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function createMockKey(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: 'key-1',
    name: 'Dashboard (a@example.com)',
    keyHash: 'hash',
    keyPrefix: 'owa_k1_abcd',
    role: ApiKeyRole.OPERATOR,
    ownerUserId: 'user-a',
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

describe('SessionAccessService', () => {
  let service: SessionAccessService;
  let sessionRepository: jest.Mocked<Partial<Repository<Session>>>;

  beforeEach(async () => {
    sessionRepository = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [SessionAccessService, { provide: getRepositoryToken(Session, 'data'), useValue: sessionRepository }],
    }).compile();

    service = module.get<SessionAccessService>(SessionAccessService);
  });

  // ── scopeFor: the single rule every caller shares ─────────────────

  describe('scopeFor', () => {
    it('should leave the bootstrap/system key unrestricted', () => {
      expect(service.scopeFor(createMockKey({ ownerUserId: null }))).toBeNull();
      expect(service.scopeFor(undefined)).toBeNull();
      expect(service.scopeFor(null)).toBeNull();
    });

    it('should leave an admin key unrestricted so admins see every tenant', () => {
      expect(service.scopeFor(createMockKey({ role: ApiKeyRole.ADMIN, ownerUserId: 'admin-1' }))).toBeNull();
    });

    it('should pin an operator key to its own account', () => {
      expect(service.scopeFor(createMockKey({ role: ApiKeyRole.OPERATOR }))).toBe('user-a');
    });

    it('should pin a viewer key to its own account', () => {
      expect(service.scopeFor(createMockKey({ role: ApiKeyRole.VIEWER }))).toBe('user-a');
    });
  });

  // ── per-session access ────────────────────────────────────────────

  describe('canAccessSession', () => {
    it('should allow an unrestricted key without even querying', async () => {
      await expect(service.canAccessSession(null, 'any-session')).resolves.toBe(true);
      expect(sessionRepository.findOne).not.toHaveBeenCalled();
    });

    it('should allow a tenant to reach its own session', async () => {
      (sessionRepository.findOne as jest.Mock).mockResolvedValue(createMockSession({ ownerUserId: 'user-a' }));
      await expect(service.canAccessSession('user-a', 'sess-1')).resolves.toBe(true);
    });

    it("should deny a tenant another tenant's session", async () => {
      (sessionRepository.findOne as jest.Mock).mockResolvedValue(createMockSession({ ownerUserId: 'user-b' }));
      await expect(service.canAccessSession('user-a', 'sess-1')).resolves.toBe(false);
    });

    it('should deny a tenant an unowned (administrator) session', async () => {
      (sessionRepository.findOne as jest.Mock).mockResolvedValue(createMockSession({ ownerUserId: null }));
      await expect(service.canAccessSession('user-a', 'sess-1')).resolves.toBe(false);
    });

    it('should let an unknown session fall through to a 404 rather than masking it', async () => {
      (sessionRepository.findOne as jest.Mock).mockResolvedValue(null);
      await expect(service.canAccessSession('user-a', 'does-not-exist')).resolves.toBe(true);
    });

    it('should match by name as well as id, since some routes address sessions by name', async () => {
      (sessionRepository.findOne as jest.Mock).mockResolvedValue(createMockSession({ ownerUserId: 'user-b' }));

      await expect(service.canAccessSession('user-a', 'tenant-session')).resolves.toBe(false);

      expect(sessionRepository.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ where: [{ id: 'tenant-session' }, { name: 'tenant-session' }] }),
      );
    });
  });

  describe('assertCanAccessSession', () => {
    it('should throw ForbiddenException when access is denied', async () => {
      (sessionRepository.findOne as jest.Mock).mockResolvedValue(createMockSession({ ownerUserId: 'user-b' }));
      await expect(service.assertCanAccessSession('user-a', 'sess-1')).rejects.toThrow(ForbiddenException);
    });

    it('should resolve silently when access is allowed', async () => {
      (sessionRepository.findOne as jest.Mock).mockResolvedValue(createMockSession({ ownerUserId: 'user-a' }));
      await expect(service.assertCanAccessSession('user-a', 'sess-1')).resolves.toBeUndefined();
    });
  });

  // ── list scoping ──────────────────────────────────────────────────

  describe('accessibleSessionIds', () => {
    it('should return null (meaning all) for an unrestricted key', async () => {
      await expect(service.accessibleSessionIds(null)).resolves.toBeNull();
      expect(sessionRepository.find).not.toHaveBeenCalled();
    });

    it("should return only the account's own session ids", async () => {
      (sessionRepository.find as jest.Mock).mockResolvedValue([
        createMockSession({ id: 'sess-1' }),
        createMockSession({ id: 'sess-2' }),
      ]);

      await expect(service.accessibleSessionIds('user-a')).resolves.toEqual(['sess-1', 'sess-2']);
      expect(sessionRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: { ownerUserId: 'user-a' } }),
      );
    });

    it('should return an empty list for an account with no sessions', async () => {
      (sessionRepository.find as jest.Mock).mockResolvedValue([]);
      await expect(service.accessibleSessionIds('user-a')).resolves.toEqual([]);
    });
  });
});
