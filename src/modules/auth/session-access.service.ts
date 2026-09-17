import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Session } from '../session/entities/session.entity';
import { ApiKey, ApiKeyRole } from './entities/api-key.entity';

/**
 * Tenant isolation for sessions.
 *
 * A WhatsApp session belongs to one account (`sessions.ownerUserId`). Every
 * session-scoped route and every WebSocket subscription has to check that the
 * caller owns the session it names, otherwise one tenant can read another
 * tenant's chats, messages and live events.
 *
 * Both the REST guard (ApiKeyGuard) and the Socket.IO gateway (EventsGateway)
 * call in here so the two paths can never drift apart.
 *
 * A null/undefined `ownerUserId` means a system or admin key — the bootstrap
 * key in data/.api-key and any key issued before accounts existed — which is
 * deliberately unrestricted.
 */
@Injectable()
export class SessionAccessService {
  constructor(
    @InjectRepository(Session, 'data')
    private readonly sessionRepository: Repository<Session>,
  ) {}

  /**
   * The owner id a key's reads and writes are confined to.
   *
   * Returns null — meaning unrestricted — for the bootstrap/system key (no
   * owner) and for any key with the admin role, so an administrator keeps full
   * visibility over every tenant's sessions. Every other key is pinned to its
   * own account.
   *
   * This is the single place that rule lives; callers must not re-derive it.
   */
  scopeFor(apiKey: Pick<ApiKey, 'role' | 'ownerUserId'> | undefined | null): string | null {
    if (!apiKey?.ownerUserId) return null;
    if (apiKey.role === ApiKeyRole.ADMIN) return null;
    return apiKey.ownerUserId;
  }

  async canAccessSession(ownerUserId: string | null | undefined, sessionRef: string): Promise<boolean> {
    if (!ownerUserId) return true;

    // Routes address a session by id, but some accept its name — match either.
    const session = await this.sessionRepository.findOne({
      where: [{ id: sessionRef }, { name: sessionRef }],
      select: ['id', 'ownerUserId'],
    });

    // Unknown session: let the route answer 404 rather than masking it as 403.
    if (!session) return true;

    // An unowned session predates accounts and belongs to the administrator.
    return session.ownerUserId === ownerUserId;
  }

  async assertCanAccessSession(ownerUserId: string | null | undefined, sessionRef: string): Promise<void> {
    if (!(await this.canAccessSession(ownerUserId, sessionRef))) {
      throw new ForbiddenException('This session belongs to another account');
    }
  }

  /**
   * Session ids the caller may see.
   * @returns null for an unrestricted (system/admin) key — meaning "all".
   */
  async accessibleSessionIds(ownerUserId: string | null | undefined): Promise<string[] | null> {
    if (!ownerUserId) return null;

    const sessions = await this.sessionRepository.find({
      where: { ownerUserId },
      select: ['id'],
    });

    return sessions.map(session => session.id);
  }
}
