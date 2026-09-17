import {
  IsString,
  IsOptional,
  IsEnum,
  IsEmail,
  IsBoolean,
  IsInt,
  IsDateString,
  Min,
  Max,
  MinLength,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ApiKeyRole } from '../entities/api-key.entity';
import { SubscriptionPlan, SubscriptionStatus } from '../entities/subscription.entity';

export class CreateUserDto {
  @ApiProperty({ description: 'Login email', example: 'client@example.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ description: 'Login password', minLength: 8 })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password: string;

  @ApiPropertyOptional({ description: 'Display name', example: 'Acme Trading' })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  fullName?: string;

  @ApiPropertyOptional({ enum: ApiKeyRole, default: ApiKeyRole.OPERATOR })
  @IsOptional()
  @IsEnum(ApiKeyRole)
  role?: ApiKeyRole;

  @ApiPropertyOptional({
    description: 'Concurrent WhatsApp session quota. 0 = unlimited.',
    default: 1,
    example: 2,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  maxSessions?: number;

  @ApiPropertyOptional({
    description: 'Initial subscription plan. Defaults to a 3-day trial.',
    enum: SubscriptionPlan,
    default: SubscriptionPlan.TRIAL,
  })
  @IsOptional()
  @IsEnum(SubscriptionPlan)
  plan?: SubscriptionPlan;

  @ApiPropertyOptional({
    description: 'Override the plan length, in days.',
    example: 45,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(36500)
  days?: number;

  @ApiPropertyOptional({
    description: 'Exact expiry (ISO 8601). Used when no `days` is given; omit both on a manual plan for unlimited.',
    example: '2027-01-31T23:59:59Z',
  })
  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  @ApiPropertyOptional({ description: 'Free-text note on the subscription' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  note?: string;
}

export class UpdateUserDto {
  @ApiPropertyOptional({ example: 'Acme Trading' })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  fullName?: string;

  @ApiPropertyOptional({ enum: ApiKeyRole })
  @IsOptional()
  @IsEnum(ApiKeyRole)
  role?: ApiKeyRole;

  @ApiPropertyOptional({ description: 'Disable the account without deleting it' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ description: 'Concurrent session quota. 0 = unlimited.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  maxSessions?: number;
}

export class ResetPasswordDto {
  @ApiProperty({ description: 'New password', minLength: 8 })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password: string;
}

export class AssignSubscriptionDto {
  @ApiProperty({
    description: 'trial = 3 days, week = 7, month = 30, year = 365, manual = use `days`/`expiresAt`',
    enum: SubscriptionPlan,
  })
  @IsEnum(SubscriptionPlan)
  plan: SubscriptionPlan;

  @ApiPropertyOptional({
    description: 'Override the plan length, in days. Wins over `expiresAt`.',
    example: 3,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(36500)
  days?: number;

  @ApiPropertyOptional({
    description: 'Exact expiry (ISO 8601). On a manual plan, omit both this and `days` for unlimited.',
    example: '2027-01-31T23:59:59Z',
  })
  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  @ApiPropertyOptional({ description: 'Free-text note, e.g. payment reference' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  note?: string;
}

export class SubscriptionResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ enum: SubscriptionPlan })
  plan: SubscriptionPlan;

  @ApiProperty({ enum: SubscriptionStatus })
  status: SubscriptionStatus;

  @ApiProperty()
  startsAt: Date;

  @ApiPropertyOptional({ description: 'null = never expires', nullable: true })
  expiresAt: Date | null;

  @ApiPropertyOptional({ nullable: true })
  note: string | null;

  @ApiPropertyOptional({ description: 'null = never expires', nullable: true })
  daysRemaining: number | null;

  @ApiProperty()
  isExpired: boolean;
}

export class UserResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  email: string;

  @ApiPropertyOptional({ nullable: true })
  fullName: string | null;

  @ApiProperty({ enum: ApiKeyRole })
  role: ApiKeyRole;

  @ApiProperty()
  isActive: boolean;

  @ApiProperty({ description: '0 = unlimited' })
  maxSessions: number;

  @ApiPropertyOptional({ nullable: true })
  lastLoginAt: Date | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;

  @ApiPropertyOptional({ type: SubscriptionResponseDto, nullable: true })
  subscription: SubscriptionResponseDto | null;

  @ApiProperty({ description: 'Sessions currently counting against the quota' })
  sessionCount: number;
}
