import {
  Injectable,
  OnModuleInit,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not, In, IsNull } from 'typeorm';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'crypto';
import { promisify } from 'util';
import { User } from './entities/user.entity';
import { Subscription, SubscriptionPlan, SubscriptionStatus, PLAN_DURATION_DAYS } from './entities/subscription.entity';
import { ApiKey, ApiKeyRole } from './entities/api-key.entity';
import { Session, SessionStatus } from '../session/entities/session.entity';
import { CreateUserDto, UpdateUserDto, AssignSubscriptionDto } from './dto';
import { createLogger } from '../../common/services/logger.service';

// Explicit type arguments: the untyped promisify() overload loses the Buffer
// return, which then trips no-unsafe-return in hashPassword().
const scrypt = promisify<string, string, number, Buffer>(scryptCallback);

/** scrypt output length in bytes, hex-encoded into passwordHash. */
const KEY_LENGTH = 64;

/**
 * Session states that do NOT occupy a slot against a user's session quota.
 * A FAILED session is dead weight; everything else (created, initializing,
 * qr_ready, authenticating, ready, disconnected) is a WhatsApp number the
 * account still owns and can reconnect to, so it counts.
 */
const TERMINAL_SESSION_STATUSES: SessionStatus[] = [SessionStatus.FAILED];

export interface EffectiveSubscription {
  id: string;
  plan: SubscriptionPlan;
  status: SubscriptionStatus;
  startsAt: Date;
  expiresAt: Date | null;
  note: string | null;
  /** null when the subscription never expires. */
  daysRemaining: number | null;
  isExpired: boolean;
}

export interface UserWithUsage {
  id: string;
  email: string;
  fullName: string | null;
  role: ApiKeyRole;
  isActive: boolean;
  maxSessions: number;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  subscription: EffectiveSubscription | null;
  sessionCount: number;
}

export interface CredentialCheck {
  user: User;
  subscription: EffectiveSubscription;
}

@Injectable()
export class UserService implements OnModuleInit {
  private readonly logger = createLogger('UserService');

  constructor(
    @InjectRepository(User, 'main')
    private readonly userRepository: Repository<User>,
    @InjectRepository(Subscription, 'main')
    private readonly subscriptionRepository: Repository<Subscription>,
    // Sessions live on the 'data' connection. Read/backfill only, for quotas.
    @InjectRepository(Session, 'data')
    private readonly sessionRepository: Repository<Session>,
    // Keys issued to accounts, kept in step with the account's role/status.
    @InjectRepository(ApiKey, 'main')
    private readonly apiKeyRepository: Repository<ApiKey>,
  ) {}

  // ==========================================================================
  // Bootstrap
  // ==========================================================================

  /**
   * Seed the administrator account from DASHBOARD_EMAIL/DASHBOARD_PASSWORD.
   * Idempotent: an existing account with that email is left completely
   * untouched, including its password, role and quota.
   */
  async onModuleInit(): Promise<void> {
    const email = (process.env.DASHBOARD_EMAIL || 'admin@rhalla.wa').trim().toLowerCase();
    const password = process.env.DASHBOARD_PASSWORD || 'changeme';

    let admin = await this.userRepository.findOne({ where: { email } });

    if (!admin) {
      admin = await this.persistUser({
        email,
        password,
        fullName: 'Administrator',
        role: ApiKeyRole.ADMIN,
        maxSessions: 0, // 0 = unlimited
      });

      // Unlimited, never-expiring subscription for the administrator.
      await this.assignSubscription(admin.id, {
        plan: SubscriptionPlan.MANUAL,
        note: 'Administrator account',
      });

      this.logger.log(`Administrator account seeded: ${email}`, {
        userId: admin.id,
        action: 'admin_user_seeded',
      });
    }

    await this.backfillSessionOwners(admin.id);
  }

  /**
   * One-time (but safe to repeat) backfill: sessions that predate user accounts
   * are handed to the administrator. Only touches rows with a NULL owner.
   */
  private async backfillSessionOwners(adminId: string): Promise<void> {
    try {
      const result = await this.sessionRepository.update({ ownerUserId: IsNull() }, { ownerUserId: adminId });
      if (result.affected && result.affected > 0) {
        this.logger.log(`Assigned ${result.affected} unowned session(s) to the administrator`, {
          userId: adminId,
          affected: result.affected,
          action: 'session_owner_backfill',
        });
      }
    } catch (error) {
      // A missing column (migration not yet applied on Postgres) must not stop
      // the app from booting — quotas just stay open until it is applied.
      this.logger.warn('Session owner backfill skipped', {
        error: String(error),
        action: 'session_owner_backfill_skipped',
      });
    }
  }

  // ==========================================================================
  // Passwords (scrypt + per-user salt; no external dependency)
  // ==========================================================================

  private async hashPassword(password: string, salt: string): Promise<string> {
    const derived = await scrypt(password, salt, KEY_LENGTH);
    return derived.toString('hex');
  }

  private async verifyPassword(password: string, user: User): Promise<boolean> {
    const derived = await this.hashPassword(password, user.passwordSalt);
    const candidate = Buffer.from(derived, 'hex');
    const stored = Buffer.from(user.passwordHash, 'hex');
    if (candidate.length !== stored.length) return false;
    return timingSafeEqual(candidate, stored);
  }

  // ==========================================================================
  // CRUD
  // ==========================================================================

  private async persistUser(input: {
    email: string;
    password: string;
    fullName?: string | null;
    role?: ApiKeyRole;
    maxSessions?: number;
  }): Promise<User> {
    const salt = randomBytes(16).toString('hex');
    const passwordHash = await this.hashPassword(input.password, salt);

    const user = this.userRepository.create({
      email: input.email.trim().toLowerCase(),
      passwordHash,
      passwordSalt: salt,
      fullName: input.fullName ?? null,
      role: input.role ?? ApiKeyRole.OPERATOR,
      maxSessions: input.maxSessions ?? 1,
      isActive: true,
    });

    return this.userRepository.save(user);
  }

  async create(dto: CreateUserDto): Promise<UserWithUsage> {
    const email = dto.email.trim().toLowerCase();
    const existing = await this.userRepository.findOne({ where: { email } });
    if (existing) {
      throw new ConflictException(`User with email '${email}' already exists`);
    }

    const user = await this.persistUser({
      email,
      password: dto.password,
      fullName: dto.fullName ?? null,
      role: dto.role,
      maxSessions: dto.maxSessions,
    });

    this.logger.log(`User created: ${user.email}`, {
      userId: user.id,
      role: user.role,
      maxSessions: user.maxSessions,
      action: 'user_created',
    });

    // Give every new account a subscription up front so it can log in: the
    // requested plan, or a 3-day trial when the admin did not choose one.
    await this.assignSubscription(user.id, {
      plan: dto.plan ?? SubscriptionPlan.TRIAL,
      days: dto.days,
      expiresAt: dto.expiresAt,
      note: dto.note,
    });

    return this.findOne(user.id);
  }

  async findAll(): Promise<UserWithUsage[]> {
    const users = await this.userRepository.find({ order: { createdAt: 'DESC' } });
    return Promise.all(users.map(user => this.decorate(user)));
  }

  async findOne(id: string): Promise<UserWithUsage> {
    return this.decorate(await this.getEntity(id));
  }

  /** Raw entity lookup, for internal callers that need the hash/salt. */
  private async getEntity(id: string): Promise<User> {
    const user = await this.userRepository.findOne({ where: { id } });
    if (!user) {
      throw new NotFoundException(`User with id '${id}' not found`);
    }
    return user;
  }

  /**
   * The bootstrap administrator must stay an enabled admin, otherwise a single
   * bad request can lock everyone out of the dashboard with no way back in
   * short of editing the database by hand.
   */
  private assertNotLockingOutAdmin(user: User, next: { role?: ApiKeyRole; isActive?: boolean }): void {
    const bootstrapEmail = (process.env.DASHBOARD_EMAIL || 'admin@rhalla.wa').trim().toLowerCase();
    if (user.email !== bootstrapEmail) return;

    if (next.isActive === false) {
      throw new ForbiddenException('The administrator account cannot be disabled');
    }
    if (next.role !== undefined && next.role !== ApiKeyRole.ADMIN) {
      throw new ForbiddenException('The administrator account cannot be demoted');
    }
  }

  /**
   * Keep the account's already-issued API keys in step with the account.
   *
   * The key carries its own copy of the role and active flag, and the guard
   * reads the key — not the user row. Without this, demoting an admin left
   * their live key with admin rights until their next login, and disabling an
   * account left its key working entirely.
   */
  private async syncApiKeys(user: User): Promise<void> {
    const keys = await this.apiKeyRepository.find({ where: { ownerUserId: user.id } });
    if (keys.length === 0) return;

    for (const key of keys) {
      key.role = user.role;
      // A disabled account's keys are revoked; re-enabling does not silently
      // resurrect them — the account gets a fresh key on its next login.
      if (!user.isActive) key.isActive = false;
    }

    await this.apiKeyRepository.save(keys);
    this.logger.log(`Synced ${keys.length} API key(s) to account state`, {
      userId: user.id,
      role: user.role,
      revoked: !user.isActive,
      action: 'api_keys_synced',
    });
  }

  async update(id: string, dto: UpdateUserDto): Promise<UserWithUsage> {
    const user = await this.getEntity(id);
    this.assertNotLockingOutAdmin(user, { role: dto.role, isActive: dto.isActive });

    if (dto.fullName !== undefined) user.fullName = dto.fullName;
    if (dto.role !== undefined) user.role = dto.role;
    if (dto.isActive !== undefined) user.isActive = dto.isActive;
    if (dto.maxSessions !== undefined) user.maxSessions = dto.maxSessions;

    await this.userRepository.save(user);
    this.logger.log(`User updated: ${user.email}`, {
      userId: user.id,
      action: 'user_updated',
    });

    // A role change or a disable must take effect immediately, not at next login.
    if (dto.role !== undefined || dto.isActive !== undefined) {
      await this.syncApiKeys(user);
    }

    return this.findOne(id);
  }

  async setPassword(id: string, password: string): Promise<void> {
    const user = await this.getEntity(id);
    const salt = randomBytes(16).toString('hex');
    user.passwordSalt = salt;
    user.passwordHash = await this.hashPassword(password, salt);
    await this.userRepository.save(user);

    this.logger.log(`Password reset for user: ${user.email}`, {
      userId: user.id,
      action: 'user_password_reset',
    });
  }

  /** Soft delete — rows are never removed, so subscription history survives. */
  async deactivate(id: string): Promise<void> {
    const user = await this.getEntity(id);
    this.assertNotLockingOutAdmin(user, { isActive: false });
    user.isActive = false;
    await this.userRepository.save(user);

    // Revoke the account's keys too, otherwise a disabled tenant keeps API
    // access with the key it already holds.
    await this.syncApiKeys(user);

    this.logger.log(`User deactivated: ${user.email}`, {
      userId: user.id,
      action: 'user_deactivated',
    });
  }

  // ==========================================================================
  // Subscriptions
  // ==========================================================================

  /**
   * Insert a new active subscription, cancelling whatever was active before.
   * History is append-only: no existing row is ever rewritten in place.
   */
  async assignSubscription(userId: string, dto: AssignSubscriptionDto): Promise<EffectiveSubscription> {
    const user = await this.getEntity(userId);

    const startsAt = new Date();
    const expiresAt = this.resolveExpiry(dto, startsAt);

    await this.subscriptionRepository.update(
      { userId: user.id, status: SubscriptionStatus.ACTIVE },
      { status: SubscriptionStatus.CANCELLED },
    );

    const subscription = await this.subscriptionRepository.save(
      this.subscriptionRepository.create({
        userId: user.id,
        plan: dto.plan,
        startsAt,
        expiresAt,
        status: SubscriptionStatus.ACTIVE,
        note: dto.note ?? null,
      }),
    );

    this.logger.log(`Subscription assigned: ${dto.plan} for ${user.email}`, {
      userId: user.id,
      plan: dto.plan,
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
      action: 'subscription_assigned',
    });

    return this.toEffective(subscription);
  }

  /**
   * Work out when a subscription ends:
   * - an explicit `days` count wins over the plan's own length
   * - then an explicit `expiresAt`
   * - otherwise the plan length; `manual` with neither means unlimited (null)
   */
  private resolveExpiry(dto: AssignSubscriptionDto, startsAt: Date): Date | null {
    if (dto.days !== undefined) {
      if (dto.days <= 0) {
        throw new BadRequestException('days must be greater than 0');
      }
      return this.addDays(startsAt, dto.days);
    }

    if (dto.expiresAt) {
      const explicit = new Date(dto.expiresAt);
      if (Number.isNaN(explicit.getTime())) {
        throw new BadRequestException('expiresAt is not a valid date');
      }
      return explicit;
    }

    const planDays = PLAN_DURATION_DAYS[dto.plan];
    return planDays === null ? null : this.addDays(startsAt, planDays);
  }

  private addDays(from: Date, days: number): Date {
    return new Date(from.getTime() + days * 86_400_000);
  }

  async cancelSubscription(userId: string): Promise<void> {
    const user = await this.getEntity(userId);
    const active = await this.getActiveSubscription(user.id);
    if (!active) {
      throw new NotFoundException('No active subscription to cancel');
    }

    active.status = SubscriptionStatus.CANCELLED;
    await this.subscriptionRepository.save(active);

    this.logger.log(`Subscription cancelled for ${user.email}`, {
      userId: user.id,
      subscriptionId: active.id,
      action: 'subscription_cancelled',
    });
  }

  /** Newest row still marked active — the effective subscription. */
  private async getActiveSubscription(userId: string): Promise<Subscription | null> {
    return this.subscriptionRepository.findOne({
      where: { userId, status: SubscriptionStatus.ACTIVE },
      order: { createdAt: 'DESC' },
    });
  }

  private toEffective(subscription: Subscription): EffectiveSubscription {
    const expiresAt = subscription.expiresAt ? new Date(subscription.expiresAt) : null;
    const isExpired = expiresAt !== null && expiresAt.getTime() <= Date.now();
    const msRemaining = expiresAt === null ? null : expiresAt.getTime() - Date.now();

    return {
      id: subscription.id,
      plan: subscription.plan,
      status: isExpired ? SubscriptionStatus.EXPIRED : subscription.status,
      startsAt: subscription.startsAt,
      expiresAt,
      note: subscription.note,
      daysRemaining: msRemaining === null ? null : Math.max(0, Math.ceil(msRemaining / 86_400_000)),
      isExpired,
    };
  }

  // ==========================================================================
  // Quotas
  // ==========================================================================

  /** Count sessions that occupy a slot against the owner's quota. */
  private async countSessions(userId: string, excludeSessionId?: string): Promise<number> {
    const sessions = await this.sessionRepository.find({
      where: { ownerUserId: userId, status: Not(In(TERMINAL_SESSION_STATUSES)) },
      select: ['id'],
    });

    return sessions.filter(session => session.id !== excludeSessionId).length;
  }

  /**
   * Gate for creating and starting a WhatsApp session.
   *
   * A null/undefined userId means a system or admin key with no owner
   * resolved, which is always allowed — that keeps keys issued before user
   * accounts existed, and the boot-time auto-reconnect, working. Otherwise the
   * account must be active, its subscription unexpired, and it must have a free
   * session slot (maxSessions 0 = unlimited).
   *
   * @param excludeSessionId session being (re)started — it already holds a slot
   */
  async assertCanStartSession(userId: string | null | undefined, excludeSessionId?: string): Promise<void> {
    if (!userId) return;

    const user = await this.userRepository.findOne({ where: { id: userId } });
    // Owner row vanished: treat as system-owned rather than locking the session out.
    if (!user) return;

    if (!user.isActive) {
      throw new ForbiddenException('Account is disabled');
    }

    const active = await this.getActiveSubscription(user.id);
    const effective = active ? this.toEffective(active) : null;
    if (!effective || effective.isExpired) {
      throw new ForbiddenException('Subscription has expired. Renew it to start sessions.');
    }

    if (user.maxSessions === 0) return;

    const used = await this.countSessions(user.id, excludeSessionId);
    if (used >= user.maxSessions) {
      throw new ForbiddenException(
        `Session limit reached (${used}/${user.maxSessions}). Delete a session or raise the account limit.`,
      );
    }
  }

  // ==========================================================================
  // Login
  // ==========================================================================

  /**
   * Authenticate dashboard credentials against the users table. Throws for
   * wrong credentials, disabled accounts and expired subscriptions.
   */
  async validateCredentials(email: string, password: string): Promise<CredentialCheck> {
    const normalised = email.trim().toLowerCase();
    const user = await this.userRepository.findOne({ where: { email: normalised } });

    if (!user || !(await this.verifyPassword(password, user))) {
      this.logger.warn('Dashboard login failed', { action: 'dashboard_login_failed' });
      throw new UnauthorizedException('Invalid email or password');
    }

    if (!user.isActive) {
      this.logger.warn('Dashboard login rejected: account disabled', {
        userId: user.id,
        action: 'dashboard_login_disabled',
      });
      throw new UnauthorizedException('Account is disabled');
    }

    const active = await this.getActiveSubscription(user.id);
    const subscription = active ? this.toEffective(active) : null;

    if (!subscription || subscription.isExpired) {
      // Fold the lapsed row over to 'expired' so listings stop calling it active.
      if (active && subscription?.isExpired) {
        active.status = SubscriptionStatus.EXPIRED;
        await this.subscriptionRepository.save(active);
      }
      this.logger.warn('Dashboard login rejected: subscription expired', {
        userId: user.id,
        action: 'dashboard_login_expired',
      });
      throw new UnauthorizedException('Subscription has expired');
    }

    user.lastLoginAt = new Date();
    await this.userRepository.save(user);

    return { user, subscription };
  }

  // ==========================================================================
  // Presentation
  // ==========================================================================

  /** Never returns passwordHash/passwordSalt. */
  private async decorate(user: User): Promise<UserWithUsage> {
    const active = await this.getActiveSubscription(user.id);

    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      isActive: user.isActive,
      maxSessions: user.maxSessions,
      lastLoginAt: user.lastLoginAt,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      subscription: active ? this.toEffective(active) : null,
      sessionCount: await this.countSessions(user.id),
    };
  }
}
