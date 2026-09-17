import { Module, Global } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard } from '@nestjs/throttler';
import { ApiKey } from './entities/api-key.entity';
import { User } from './entities/user.entity';
import { Subscription } from './entities/subscription.entity';
import { Session } from '../session/entities/session.entity';
import { AuthService } from './auth.service';
import { UserService } from './user.service';
import { SessionAccessService } from './session-access.service';
import { AuthController } from './auth.controller';
import { AuthValidateController } from './auth-validate.controller';
import { UserController } from './user.controller';
import { ApiKeyGuard } from './guards/api-key.guard';

@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([ApiKey, User, Subscription], 'main'),
    // Session lives on the pluggable 'data' connection. Registered here only
    // so UserService can count/backfill session ownership for quotas — this
    // module deliberately does not import SessionModule, which would be circular.
    TypeOrmModule.forFeature([Session], 'data'),
  ],
  controllers: [AuthController, AuthValidateController, UserController],
  providers: [
    AuthService,
    UserService,
    SessionAccessService,
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    {
      provide: APP_GUARD,
      useClass: ApiKeyGuard,
    },
  ],
  exports: [AuthService, UserService, SessionAccessService],
})
export class AuthModule {}
