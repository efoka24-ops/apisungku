import { Module } from '@nestjs/common';

import { ToolkitController } from './toolkit.controller';

@Module({
  controllers: [ToolkitController],
})
export class ToolkitModule {}
