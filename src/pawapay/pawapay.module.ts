import { Global, Module } from '@nestjs/common';

import { PawaPayService } from './pawapay.service';

@Global()
@Module({
  providers: [PawaPayService],
  exports: [PawaPayService],
})
export class PawaPayModule {}
