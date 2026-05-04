import { Global, Module } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { ApiKeyGuard } from '../common/guards/api-key.guard';

@Global()
@Module({
  controllers: [AuthController],
  providers: [AuthService, ApiKeyGuard, Reflector],
  exports: [AuthService, ApiKeyGuard],
})
export class AuthModule {}
