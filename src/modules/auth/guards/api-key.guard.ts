import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { AuthService } from '../auth.service';
import { SessionAccessService } from '../session-access.service';
import { ApiKeyRole } from '../entities/api-key.entity';
import { REQUIRED_ROLE_KEY, PUBLIC_KEY } from '../decorators/auth.decorators';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly authService: AuthService,
    private readonly sessionAccess: SessionAccessService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Check if route is marked as public
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [context.getHandler(), context.getClass()]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const apiKeyHeader = this.extractApiKey(request);

    if (!apiKeyHeader) {
      throw new UnauthorizedException('API key is required');
    }

    // Get session ID from route params if present
    const sessionId = (request.params['sessionId'] || request.params['id']) as string | undefined;
    const clientIp = this.getClientIp(request);

    // Validate API key
    const apiKey = await this.authService.validateApiKey(apiKeyHeader, clientIp, sessionId);

    // Check role permission
    const requiredRole = this.reflector.getAllAndOverride<ApiKeyRole>(REQUIRED_ROLE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (requiredRole && !this.authService.hasPermission(apiKey, requiredRole)) {
      throw new UnauthorizedException(`Insufficient permissions. Required: ${requiredRole}`);
    }

    // Tenant isolation: a key bound to an account may only touch that account's
    // sessions. Enforced here rather than per-controller so it covers every
    // session-scoped route at once — messages, contacts, groups, labels,
    // channels, status, catalog and webhooks are all nested under a session.
    if (sessionId && this.isSessionScopedRoute(request)) {
      await this.sessionAccess.assertCanAccessSession(this.sessionAccess.scopeFor(apiKey), sessionId);
    }

    // Attach API key to request for use in controllers
    (request as Request & { apiKey: typeof apiKey }).apiKey = apiKey;

    return true;
  }

  /**
   * True for routes under /api/sessions/... — the only place where a
   * `sessionId`/`id` param actually names a session. Other resources
   * (api-keys, users) use `id` for their own rows and must not be checked
   * against the sessions table.
   */
  private isSessionScopedRoute(request: Request): boolean {
    const path = (request.path || request.url || '').split('?')[0];
    return /^\/api\/sessions\/[^/]+/.test(path);
  }

  private extractApiKey(request: Request): string | undefined {
    // Support both X-API-Key header and Authorization Bearer
    const xApiKey = request.headers['x-api-key'] as string;
    if (xApiKey) return xApiKey;

    const authHeader = request.headers['authorization'];
    if (authHeader?.startsWith('Bearer ')) {
      return authHeader.substring(7);
    }

    return undefined;
  }

  private getClientIp(request: Request): string {
    const forwarded = request.headers['x-forwarded-for'];
    if (forwarded) {
      const ips = (forwarded as string).split(',');
      return ips[0].trim();
    }
    return request.ip || request.socket.remoteAddress || '';
  }
}
