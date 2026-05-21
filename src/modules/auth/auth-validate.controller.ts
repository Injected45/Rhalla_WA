import { Controller, Post, Body, Headers, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiHeader } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { Public } from './decorators/auth.decorators';
import { createLogger } from '../../common/services/logger.service';

@ApiTags('auth')
@Controller('auth')
export class AuthValidateController {
  private readonly logger = createLogger('AuthValidateController');

  constructor(private readonly authService: AuthService) {}

  @Post('validate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Validate an API key' })
  @ApiHeader({ name: 'X-API-Key', description: 'API key to validate' })
  @ApiResponse({ status: 200, description: 'API key is valid' })
  @ApiResponse({ status: 401, description: 'Invalid or missing API key' })
  async validate(@Headers('x-api-key') apiKey?: string): Promise<{ valid: boolean; role?: string }> {
    if (!apiKey) {
      return { valid: false };
    }

    try {
      const keyEntity = await this.authService.validateApiKey(apiKey);
      if (keyEntity && keyEntity.isActive) {
        return { valid: true, role: keyEntity.role };
      }
      return { valid: false };
    } catch (error) {
      this.logger.warn('API key validation error', { error: error instanceof Error ? error.message : String(error) });
      return { valid: false };
    }
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Log in to the dashboard with email and password' })
  @ApiResponse({ status: 200, description: 'Login successful; returns the dashboard API key' })
  @ApiResponse({ status: 401, description: 'Invalid email or password' })
  async login(@Body() dto: LoginDto): Promise<{ apiKey: string; role?: string }> {
    const { apiKey } = this.authService.loginWithCredentials(dto.email, dto.password);
    const keyEntity = await this.authService.validateApiKey(apiKey);
    return { apiKey, role: keyEntity.role };
  }
}
