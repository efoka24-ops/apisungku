import { Module } from '@nestjs/common';

import { PrismaService } from '../common/prisma.service';
import { ProjectsController } from './projects.controller';

@Module({
  controllers: [ProjectsController],
  providers: [PrismaService],
})
export class ProjectsModule {}
