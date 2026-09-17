import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { UserService } from './user.service';
import { User } from './entities/user.entity';
import { Subscription, SubscriptionPlan, SubscriptionStatus } from './entities/subscription.entity';
import { ApiKey, ApiKeyRole } from './entities/api-key.entity';
import { Session, SessionStatus } from '../session/entities/session.entity';

const DAY_MS = 86_400_000;

function createMockUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    email: 'client@example.com',
    passwordHash: '',
    passwordSalt: '',
    fullName: null,
    role: ApiKeyRole.OPERATOR,
    isActive: true,
    maxSessions: 1,
    lastLoginAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function createMockSubscription(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: 'sub-1',
    userId: 'user-1',
    plan: SubscriptionPlan.MONTH,
    startsAt: new Date(),
    expiresAt: new Date(Date.now() + 30 * DAY_MS),
    status: SubscriptionStatus.ACTIVE,
    note: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function createMockSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    name: 'session',
    status: SessionStatus.READY,
    phone: null,
    pushName: null,
    config: {},
    proxyUrl: null,
    proxyType: null,
    ownerUserId: 'user-1',
    connectedAt: null,
    lastActiveAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('UserService', () => {
  let service: UserService;
  let userRepository: jest.Mocked<Partial<Repository<User>>>;
  let subscriptionRepository: jest.Mocked<Partial<Repository<Subscription>>>;
  let sessionRepository: jest.Mocked<Partial<Repository<Session>>>;
  let apiKeyRepository: jest.Mocked<Partial<Repository<ApiKey>>>;

  /**
   * Route `findOne` by lookup key: creating an account probes by email (must
   * miss, or it is a duplicate) and then re-reads the saved row by id.
   */
  const routeUserLookups = (stored: () => User | undefined) => {
    (userRepository.findOne as jest.Mock).mockImplementation((options: { where: Partial<User> }) => {
      if (options.where.email !== undefined) return Promise.resolve(null);
      return Promise.resolve(stored() ?? null);
    });
  };

  /** Create an account through the service and return the row it saved. */
  const createStoredUser = async (email: string, password: string): Promise<User> => {
    let stored: User | undefined;
    routeUserLookups(() => stored);
    (userRepository.save as jest.Mock).mockImplementation((entity: User) => {
      stored = { ...createMockUser(), ...entity };
      return Promise.resolve(stored);
    });

    await service.create({ email, password });
    return stored!;
  };

  beforeEach(async () => {
    userRepository = {
      find: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn().mockImplementation((entity: unknown) => entity),
      save: jest.fn().mockImplementation((entity: unknown) => Promise.resolve(entity)),
      update: jest.fn().mockResolvedValue({ affected: 0 }),
    };

    subscriptionRepository = {
      find: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn().mockImplementation((entity: unknown) => entity),
      save: jest
        .fn()
        .mockImplementation((entity: unknown) => Promise.resolve({ id: 'sub-new', ...(entity as object) })),
      update: jest.fn().mockResolvedValue({ affected: 0 }),
    };

    sessionRepository = {
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({ affected: 0 }),
    };

    apiKeyRepository = {
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn().mockImplementation((e: unknown) => Promise.resolve(e)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserService,
        { provide: getRepositoryToken(User, 'main'), useValue: userRepository },
        { provide: getRepositoryToken(Subscription, 'main'), useValue: subscriptionRepository },
        { provide: getRepositoryToken(Session, 'data'), useValue: sessionRepository },
        { provide: getRepositoryToken(ApiKey, 'main'), useValue: apiKeyRepository },
      ],
    }).compile();

    service = module.get<UserService>(UserService);
  });

  // ── passwords ─────────────────────────────────────────────────────

  describe('password hashing', () => {
    it('should verify a password against its own scrypt hash', async () => {
      const stored = await createStoredUser('Client@Example.com', 'correct-horse');

      expect(stored.passwordHash).toHaveLength(128); // 64 bytes, hex
      expect(stored.passwordSalt).toHaveLength(32);
      // Email is normalised to lowercase on the way in.
      expect(stored.email).toBe('client@example.com');

      (userRepository.findOne as jest.Mock).mockResolvedValue(stored);
      (subscriptionRepository.findOne as jest.Mock).mockResolvedValue(createMockSubscription());

      await expect(service.validateCredentials('client@example.com', 'correct-horse')).resolves.toMatchObject({
        user: { email: 'client@example.com' },
      });
    });

    it('should reject a wrong password', async () => {
      const stored = await createStoredUser('client@example.com', 'correct-horse');

      (userRepository.findOne as jest.Mock).mockResolvedValue(stored);
      (subscriptionRepository.findOne as jest.Mock).mockResolvedValue(createMockSubscription());

      await expect(service.validateCredentials('client@example.com', 'wrong-horse')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should produce a different hash for the same password under a different salt', async () => {
      const first = await createStoredUser('a@example.com', 'same-password');
      const second = await createStoredUser('b@example.com', 'same-password');

      expect(first.passwordSalt).not.toBe(second.passwordSalt);
      expect(first.passwordHash).not.toBe(second.passwordHash);
    });
  });

  // ── subscription lengths ──────────────────────────────────────────

  describe('assignSubscription', () => {
    beforeEach(() => {
      (userRepository.findOne as jest.Mock).mockResolvedValue(createMockUser());
    });

    const expectDays = (expiresAt: Date | null, days: number) => {
      expect(expiresAt).not.toBeNull();
      const actualDays = (expiresAt!.getTime() - Date.now()) / DAY_MS;
      expect(actualDays).toBeCloseTo(days, 1);
    };

    it('should give a trial 3 days', async () => {
      const result = await service.assignSubscription('user-1', { plan: SubscriptionPlan.TRIAL });
      expectDays(result.expiresAt, 3);
      expect(result.daysRemaining).toBe(3);
    });

    it('should give a week plan 7 days', async () => {
      const result = await service.assignSubscription('user-1', { plan: SubscriptionPlan.WEEK });
      expectDays(result.expiresAt, 7);
    });

    it('should give a month plan 30 days', async () => {
      const result = await service.assignSubscription('user-1', { plan: SubscriptionPlan.MONTH });
      expectDays(result.expiresAt, 30);
    });

    it('should give a year plan 365 days', async () => {
      const result = await service.assignSubscription('user-1', { plan: SubscriptionPlan.YEAR });
      expectDays(result.expiresAt, 365);
    });

    it('should treat a manual plan with no dates as unlimited', async () => {
      const result = await service.assignSubscription('user-1', { plan: SubscriptionPlan.MANUAL });
      expect(result.expiresAt).toBeNull();
      expect(result.daysRemaining).toBeNull();
      expect(result.isExpired).toBe(false);
    });

    it('should let an explicit day count override the plan length', async () => {
      const result = await service.assignSubscription('user-1', { plan: SubscriptionPlan.MONTH, days: 45 });
      expectDays(result.expiresAt, 45);
    });

    it('should accept an explicit expiry date on a manual plan', async () => {
      const expiresAt = new Date(Date.now() + 10 * DAY_MS).toISOString();
      const result = await service.assignSubscription('user-1', {
        plan: SubscriptionPlan.MANUAL,
        expiresAt,
      });
      expectDays(result.expiresAt, 10);
    });

    it('should cancel the previously active subscription', async () => {
      await service.assignSubscription('user-1', { plan: SubscriptionPlan.WEEK });

      expect(subscriptionRepository.update).toHaveBeenCalledWith(
        { userId: 'user-1', status: SubscriptionStatus.ACTIVE },
        { status: SubscriptionStatus.CANCELLED },
      );
    });
  });

  // ── login gating ──────────────────────────────────────────────────

  describe('validateCredentials', () => {
    /** Creates a user whose stored hash matches `password`. */
    const userWithPassword = async (password: string, overrides: Partial<User> = {}): Promise<User> => {
      const stored = await createStoredUser('client@example.com', password);
      return createMockUser({
        passwordHash: stored.passwordHash,
        passwordSalt: stored.passwordSalt,
        ...overrides,
      });
    };

    it('should reject a login when the subscription has expired', async () => {
      const user = await userWithPassword('secret-password');
      (userRepository.findOne as jest.Mock).mockResolvedValue(user);
      (subscriptionRepository.findOne as jest.Mock).mockResolvedValue(
        createMockSubscription({ expiresAt: new Date(Date.now() - DAY_MS) }),
      );

      await expect(service.validateCredentials('client@example.com', 'secret-password')).rejects.toThrow(
        UnauthorizedException,
      );

      // The lapsed row is folded over to 'expired' rather than left 'active'.
      expect(subscriptionRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: SubscriptionStatus.EXPIRED }),
      );
    });

    it('should reject a login when there is no subscription at all', async () => {
      const user = await userWithPassword('secret-password');
      (userRepository.findOne as jest.Mock).mockResolvedValue(user);
      (subscriptionRepository.findOne as jest.Mock).mockResolvedValue(null);

      await expect(service.validateCredentials('client@example.com', 'secret-password')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should reject a login for a disabled account', async () => {
      const user = await userWithPassword('secret-password', { isActive: false });
      (userRepository.findOne as jest.Mock).mockResolvedValue(user);
      (subscriptionRepository.findOne as jest.Mock).mockResolvedValue(createMockSubscription());

      await expect(service.validateCredentials('client@example.com', 'secret-password')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should accept a login on an unlimited subscription and stamp lastLoginAt', async () => {
      const user = await userWithPassword('secret-password');
      (userRepository.findOne as jest.Mock).mockResolvedValue(user);
      (subscriptionRepository.findOne as jest.Mock).mockResolvedValue(
        createMockSubscription({ plan: SubscriptionPlan.MANUAL, expiresAt: null }),
      );

      const result = await service.validateCredentials('client@example.com', 'secret-password');

      expect(result.subscription.daysRemaining).toBeNull();
      expect(result.user.lastLoginAt).toBeInstanceOf(Date);
    });
  });

  // ── session quotas ────────────────────────────────────────────────

  describe('assertCanStartSession', () => {
    const activeSubscription = () =>
      (subscriptionRepository.findOne as jest.Mock).mockResolvedValue(createMockSubscription());

    it('should allow a system/admin key with no owner', async () => {
      await expect(service.assertCanStartSession(null)).resolves.toBeUndefined();
      await expect(service.assertCanStartSession(undefined)).resolves.toBeUndefined();
      expect(userRepository.findOne).not.toHaveBeenCalled();
    });

    it('should allow one below the limit', async () => {
      (userRepository.findOne as jest.Mock).mockResolvedValue(createMockUser({ maxSessions: 3 }));
      activeSubscription();
      (sessionRepository.find as jest.Mock).mockResolvedValue([
        createMockSession({ id: 'sess-1' }),
        createMockSession({ id: 'sess-2' }),
      ]);

      await expect(service.assertCanStartSession('user-1')).resolves.toBeUndefined();
    });

    it('should block at the limit', async () => {
      (userRepository.findOne as jest.Mock).mockResolvedValue(createMockUser({ maxSessions: 2 }));
      activeSubscription();
      (sessionRepository.find as jest.Mock).mockResolvedValue([
        createMockSession({ id: 'sess-1' }),
        createMockSession({ id: 'sess-2' }),
      ]);

      await expect(service.assertCanStartSession('user-1')).rejects.toThrow(ForbiddenException);
    });

    it('should allow unlimited when maxSessions is 0', async () => {
      (userRepository.findOne as jest.Mock).mockResolvedValue(createMockUser({ maxSessions: 0 }));
      activeSubscription();
      (sessionRepository.find as jest.Mock).mockResolvedValue(
        Array.from({ length: 50 }, (_, i) => createMockSession({ id: `sess-${i}` })),
      );

      await expect(service.assertCanStartSession('user-1')).resolves.toBeUndefined();
      // Short-circuits before counting anything.
      expect(sessionRepository.find).not.toHaveBeenCalled();
    });

    it('should not count the session being restarted against its own limit', async () => {
      (userRepository.findOne as jest.Mock).mockResolvedValue(createMockUser({ maxSessions: 1 }));
      activeSubscription();
      (sessionRepository.find as jest.Mock).mockResolvedValue([createMockSession({ id: 'sess-1' })]);

      await expect(service.assertCanStartSession('user-1', 'sess-1')).resolves.toBeUndefined();
      await expect(service.assertCanStartSession('user-1', 'other-session')).rejects.toThrow(ForbiddenException);
    });

    it('should block when the subscription has expired', async () => {
      (userRepository.findOne as jest.Mock).mockResolvedValue(createMockUser({ maxSessions: 0 }));
      (subscriptionRepository.findOne as jest.Mock).mockResolvedValue(
        createMockSubscription({ expiresAt: new Date(Date.now() - DAY_MS) }),
      );

      await expect(service.assertCanStartSession('user-1')).rejects.toThrow(ForbiddenException);
    });

    it('should block a disabled account', async () => {
      (userRepository.findOne as jest.Mock).mockResolvedValue(createMockUser({ isActive: false }));
      activeSubscription();

      await expect(service.assertCanStartSession('user-1')).rejects.toThrow(ForbiddenException);
    });
  });

  // ── administrator lockout guard ───────────────────────────────────

  // ── key/account state sync ────────────────────────────────────────

  describe('API key sync', () => {
    const keyFor = (overrides: Partial<ApiKey> = {}): ApiKey =>
      ({
        id: 'key-1',
        name: 'Dashboard (client@example.com)',
        keyHash: 'hash',
        keyPrefix: 'owa_k1_abcd',
        role: ApiKeyRole.ADMIN,
        ownerUserId: 'user-1',
        allowedIps: null,
        allowedSessions: null,
        isActive: true,
        expiresAt: null,
        lastUsedAt: null,
        usageCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides,
      }) as ApiKey;

    it('should downgrade a live key when the account is demoted', async () => {
      (userRepository.findOne as jest.Mock).mockResolvedValue(createMockUser({ role: ApiKeyRole.ADMIN }));
      (apiKeyRepository.find as jest.Mock).mockResolvedValue([keyFor()]);
      (subscriptionRepository.findOne as jest.Mock).mockResolvedValue(createMockSubscription());

      await service.update('user-1', { role: ApiKeyRole.OPERATOR });

      expect(apiKeyRepository.save).toHaveBeenCalledWith([
        expect.objectContaining({ role: ApiKeyRole.OPERATOR, isActive: true }),
      ]);
    });

    it('should revoke live keys when the account is disabled', async () => {
      (userRepository.findOne as jest.Mock).mockResolvedValue(createMockUser());
      (apiKeyRepository.find as jest.Mock).mockResolvedValue([keyFor({ role: ApiKeyRole.OPERATOR })]);

      await service.deactivate('user-1');

      expect(apiKeyRepository.save).toHaveBeenCalledWith([expect.objectContaining({ isActive: false })]);
    });

    it('should not touch keys when only the session limit changes', async () => {
      (userRepository.findOne as jest.Mock).mockResolvedValue(createMockUser());
      (subscriptionRepository.findOne as jest.Mock).mockResolvedValue(createMockSubscription());

      await service.update('user-1', { maxSessions: 5 });

      expect(apiKeyRepository.save).not.toHaveBeenCalled();
    });
  });

  describe('administrator protection', () => {
    it('should refuse to disable the bootstrap administrator', async () => {
      (userRepository.findOne as jest.Mock).mockResolvedValue(
        createMockUser({ email: 'admin@rhalla.wa', role: ApiKeyRole.ADMIN }),
      );

      await expect(service.deactivate('user-1')).rejects.toThrow(ForbiddenException);
      await expect(service.update('user-1', { role: ApiKeyRole.VIEWER })).rejects.toThrow(ForbiddenException);
    });
  });
});
