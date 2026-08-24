import { Module } from '@nestjs/common';
import { CacheModule } from '../cache/cache.module';
import { MetricsModule } from '../metrics/metrics.module';
import { RateLimitModule } from '../rate-limit/rate-limit.module';
import { RouterModule } from '../router/router.module';
import { GatewayController } from './gateway.controller';

@Module({
  imports: [RouterModule, MetricsModule, CacheModule, RateLimitModule],
  controllers: [GatewayController],
})
export class GatewayModule {}
