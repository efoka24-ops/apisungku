import { Global, Module } from '@nestjs/common';

import { PrismaService } from '../common/prisma.service';
import { ApiKeyGuard } from './api-key.guard';

@Global()
@Module({
  providers: [PrismaService, ApiKeyGuard],
  exports: [PrismaService, ApiKeyGuard],
})
export class AuthModule {}
