import { Module } from '@nestjs/common';
import { ProvidersModule } from '../providers/providers.module';
import { RouterService } from './router.service';

@Module({
  imports: [ProvidersModule],
  providers: [RouterService],
  exports: [RouterService],
})
export class RouterModule {}
