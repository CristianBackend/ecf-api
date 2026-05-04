import { Global, Module } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { ApiKeyGuard } from '../common/guards/api-key.guard';

@Global()
@Module({
  controllers: [AuthController],
  // Reflector must be explicitly provided here because ApiKeyGuard injects it
  // as a module-level provider (not via @UseGuards at controller level).
  // NestJS makes Reflector globally available at runtime but TestingModule
  // requires it to be declared in the provider scope that uses it.
  providers: [AuthService, ApiKeyGuard, Reflector],
  exports: [AuthService, ApiKeyGuard],
})
export class AuthModule {}