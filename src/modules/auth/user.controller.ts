import { Controller, Get, Post, Patch, Delete, Param, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { UserService, UserWithUsage, EffectiveSubscription } from './user.service';
import { CreateUserDto, UpdateUserDto, ResetPasswordDto, AssignSubscriptionDto, UserResponseDto } from './dto';
import { RequireRole } from './decorators/auth.decorators';
import { ApiKeyRole } from './entities/api-key.entity';

/**
 * Administrator-only account management: who exists, what they pay for, and
 * how many WhatsApp sessions they may run.
 *
 * Every route requires an admin API key. Responses never include password
 * hashes or salts (UserService maps entities to a safe shape).
 */
@ApiTags('admin-users')
@Controller('admin/users')
@RequireRole(ApiKeyRole.ADMIN)
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Get()
  @ApiOperation({ summary: 'List all accounts with their subscription and session usage' })
  @ApiResponse({ status: 200, description: 'List of accounts', type: [UserResponseDto] })
  async findAll(): Promise<UserWithUsage[]> {
    return this.userService.findAll();
  }

  @Post()
  @ApiOperation({ summary: 'Create an account (and its initial subscription)' })
  @ApiResponse({ status: 201, description: 'Account created', type: UserResponseDto })
  @ApiResponse({ status: 409, description: 'Email already in use' })
  async create(@Body() dto: CreateUserDto): Promise<UserWithUsage> {
    return this.userService.create(dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one account' })
  @ApiParam({ name: 'id', description: 'User ID' })
  @ApiResponse({ status: 200, description: 'Account details', type: UserResponseDto })
  @ApiResponse({ status: 404, description: 'Account not found' })
  async findOne(@Param('id') id: string): Promise<UserWithUsage> {
    return this.userService.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update name, role, active flag or session quota' })
  @ApiParam({ name: 'id', description: 'User ID' })
  @ApiResponse({ status: 200, description: 'Account updated', type: UserResponseDto })
  @ApiResponse({ status: 403, description: 'Cannot demote or disable the bootstrap administrator' })
  @ApiResponse({ status: 404, description: 'Account not found' })
  async update(@Param('id') id: string, @Body() dto: UpdateUserDto): Promise<UserWithUsage> {
    return this.userService.update(id, dto);
  }

  @Patch(':id/password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Reset an account password' })
  @ApiParam({ name: 'id', description: 'User ID' })
  @ApiResponse({ status: 204, description: 'Password reset' })
  @ApiResponse({ status: 404, description: 'Account not found' })
  async resetPassword(@Param('id') id: string, @Body() dto: ResetPasswordDto): Promise<void> {
    await this.userService.setPassword(id, dto.password);
  }

  @Post(':id/subscription')
  @ApiOperation({
    summary: 'Assign a subscription',
    description:
      'Cancels the current active subscription and inserts a new one. ' +
      'trial = 3 days, week = 7, month = 30, year = 365. Pass `days` to set any ' +
      'custom length, or use plan `manual` with `expiresAt` (or neither, for unlimited).',
  })
  @ApiParam({ name: 'id', description: 'User ID' })
  @ApiResponse({ status: 201, description: 'Subscription assigned' })
  @ApiResponse({ status: 404, description: 'Account not found' })
  async assignSubscription(
    @Param('id') id: string,
    @Body() dto: AssignSubscriptionDto,
  ): Promise<EffectiveSubscription> {
    return this.userService.assignSubscription(id, dto);
  }

  @Delete(':id/subscription')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Cancel the current subscription (blocks login until a new one is assigned)' })
  @ApiParam({ name: 'id', description: 'User ID' })
  @ApiResponse({ status: 204, description: 'Subscription cancelled' })
  @ApiResponse({ status: 404, description: 'No active subscription' })
  async cancelSubscription(@Param('id') id: string): Promise<void> {
    await this.userService.cancelSubscription(id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Disable an account',
    description: 'Soft delete: the row is kept so subscription history and session ownership survive.',
  })
  @ApiParam({ name: 'id', description: 'User ID' })
  @ApiResponse({ status: 204, description: 'Account disabled' })
  @ApiResponse({ status: 403, description: 'Cannot disable the bootstrap administrator' })
  @ApiResponse({ status: 404, description: 'Account not found' })
  async deactivate(@Param('id') id: string): Promise<void> {
    await this.userService.deactivate(id);
  }
}
