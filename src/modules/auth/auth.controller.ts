import { Controller, Get, Post, Put, Delete, Body, Param, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { CreateApiKeyDto, UpdateApiKeyDto, ApiKeyResponseDto, ApiKeyCreatedResponseDto } from './dto';
import { RequireRole, CurrentApiKey } from './decorators/auth.decorators';
import { ApiKey, ApiKeyRole } from './entities/api-key.entity';
import { SessionAccessService } from './session-access.service';

@ApiTags('auth')
@ApiBearerAuth()
@Controller('auth/api-keys')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly sessionAccess: SessionAccessService,
  ) {}

  @Post()
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Create a new API key (scoped to your account)' })
  @ApiResponse({
    status: 201,
    description: 'API key created',
    type: ApiKeyCreatedResponseDto,
  })
  async create(@Body() dto: CreateApiKeyDto, @CurrentApiKey() caller?: ApiKey): Promise<ApiKeyCreatedResponseDto> {
    // The new key inherits the caller account, so a normal account issues
    // keys that reach only its own sessions.
    const { apiKey, rawKey } = await this.authService.createApiKey(dto, caller);
    return {
      id: apiKey.id,
      name: apiKey.name,
      keyPrefix: apiKey.keyPrefix,
      role: apiKey.role,
      allowedIps: apiKey.allowedIps || undefined,
      allowedSessions: apiKey.allowedSessions || undefined,
      isActive: apiKey.isActive,
      expiresAt: apiKey.expiresAt || undefined,
      lastUsedAt: apiKey.lastUsedAt || undefined,
      usageCount: apiKey.usageCount,
      createdAt: apiKey.createdAt,
      apiKey: rawKey,
    };
  }

  @Get()
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'List all API keys (scoped to your account)' })
  @ApiResponse({ status: 200, type: [ApiKeyResponseDto] })
  async findAll(@CurrentApiKey() caller?: ApiKey): Promise<ApiKeyResponseDto[]> {
    const keys = await this.authService.findAll(this.sessionAccess.scopeFor(caller));
    return keys.map(k => ({
      id: k.id,
      name: k.name,
      keyPrefix: k.keyPrefix,
      role: k.role,
      allowedIps: k.allowedIps || undefined,
      allowedSessions: k.allowedSessions || undefined,
      isActive: k.isActive,
      expiresAt: k.expiresAt || undefined,
      lastUsedAt: k.lastUsedAt || undefined,
      usageCount: k.usageCount,
      createdAt: k.createdAt,
    }));
  }

  @Get(':id')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Get API key details (scoped to your account)' })
  @ApiResponse({ status: 200, type: ApiKeyResponseDto })
  async findOne(@Param('id') id: string, @CurrentApiKey() caller?: ApiKey): Promise<ApiKeyResponseDto> {
    const k = await this.authService.findOne(id, this.sessionAccess.scopeFor(caller));
    return {
      id: k.id,
      name: k.name,
      keyPrefix: k.keyPrefix,
      role: k.role,
      allowedIps: k.allowedIps || undefined,
      allowedSessions: k.allowedSessions || undefined,
      isActive: k.isActive,
      expiresAt: k.expiresAt || undefined,
      lastUsedAt: k.lastUsedAt || undefined,
      usageCount: k.usageCount,
      createdAt: k.createdAt,
    };
  }

  @Put(':id')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Update API key (scoped to your account)' })
  @ApiResponse({ status: 200, type: ApiKeyResponseDto })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateApiKeyDto,
    @CurrentApiKey() caller?: ApiKey,
  ): Promise<ApiKeyResponseDto> {
    const k = await this.authService.update(id, dto, this.sessionAccess.scopeFor(caller));
    return {
      id: k.id,
      name: k.name,
      keyPrefix: k.keyPrefix,
      role: k.role,
      allowedIps: k.allowedIps || undefined,
      allowedSessions: k.allowedSessions || undefined,
      isActive: k.isActive,
      expiresAt: k.expiresAt || undefined,
      lastUsedAt: k.lastUsedAt || undefined,
      usageCount: k.usageCount,
      createdAt: k.createdAt,
    };
  }

  @Delete(':id')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete API key (scoped to your account)' })
  @ApiResponse({ status: 204, description: 'API key deleted' })
  async delete(@Param('id') id: string, @CurrentApiKey() caller?: ApiKey): Promise<void> {
    await this.authService.delete(id, this.sessionAccess.scopeFor(caller), caller);
  }

  @Post(':id/regenerate')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({
    summary: 'Issue a fresh secret for an existing key (scoped to your account)',
    description:
      'Only the hash of a key is stored, so a lost key cannot be read back. This rotates the secret and ' +
      'returns the new one once; the old secret stops working immediately.',
  })
  @ApiResponse({ status: 201, description: 'New secret issued', type: ApiKeyCreatedResponseDto })
  @ApiResponse({ status: 403, description: 'Cannot regenerate the key you are currently using' })
  async regenerate(@Param('id') id: string, @CurrentApiKey() caller?: ApiKey): Promise<ApiKeyCreatedResponseDto> {
    const { apiKey, rawKey } = await this.authService.regenerateApiKey(id, this.sessionAccess.scopeFor(caller), caller);
    return {
      id: apiKey.id,
      name: apiKey.name,
      keyPrefix: apiKey.keyPrefix,
      role: apiKey.role,
      allowedIps: apiKey.allowedIps || undefined,
      allowedSessions: apiKey.allowedSessions || undefined,
      isActive: apiKey.isActive,
      expiresAt: apiKey.expiresAt || undefined,
      lastUsedAt: apiKey.lastUsedAt || undefined,
      usageCount: apiKey.usageCount,
      createdAt: apiKey.createdAt,
      apiKey: rawKey,
    };
  }

  @Post(':id/revoke')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Revoke API key (scoped to your account)' })
  @ApiResponse({ status: 200, type: ApiKeyResponseDto })
  async revoke(@Param('id') id: string, @CurrentApiKey() caller?: ApiKey): Promise<ApiKeyResponseDto> {
    const k = await this.authService.revoke(id, this.sessionAccess.scopeFor(caller), caller);
    return {
      id: k.id,
      name: k.name,
      keyPrefix: k.keyPrefix,
      role: k.role,
      allowedIps: k.allowedIps || undefined,
      allowedSessions: k.allowedSessions || undefined,
      isActive: k.isActive,
      expiresAt: k.expiresAt || undefined,
      lastUsedAt: k.lastUsedAt || undefined,
      usageCount: k.usageCount,
      createdAt: k.createdAt,
    };
  }
}
