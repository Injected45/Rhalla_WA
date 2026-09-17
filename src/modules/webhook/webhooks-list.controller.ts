import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { WebhookService } from './webhook.service';
import { Webhook } from './entities/webhook.entity';
import { CurrentApiKey } from '../auth/decorators/auth.decorators';
import { ApiKey } from '../auth/entities/api-key.entity';
import { SessionAccessService } from '../auth/session-access.service';

@ApiTags('webhooks')
@Controller('webhooks')
export class WebhooksListController {
  constructor(
    private readonly webhookService: WebhookService,
    private readonly sessionAccess: SessionAccessService,
  ) {}

  @Get()
  @ApiOperation({ summary: "List webhooks across the caller's sessions" })
  @ApiResponse({
    status: 200,
    description: 'List of webhooks. Scoped to the calling account; admin/system keys see all.',
  })
  async findAll(@CurrentApiKey() apiKey?: ApiKey): Promise<Webhook[]> {
    // This route is not nested under a session, so the guard cannot scope it —
    // resolve the caller's sessions and filter here instead.
    const sessionIds = await this.sessionAccess.accessibleSessionIds(this.sessionAccess.scopeFor(apiKey));
    return this.webhookService.findAll(sessionIds);
  }
}
