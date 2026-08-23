import { Module } from '@nestjs/common';
import { CacheModule } from '../cache/cache.module';
import { MetricsModule } from '../metrics/metrics.module';
import { RouterModule } from '../router/router.module';
import { GatewayController } from './gateway.controller';

@Module({
  imports: [RouterModule, MetricsModule, CacheModule],
  controllers: [GatewayController],
})
export class GatewayModule {}
