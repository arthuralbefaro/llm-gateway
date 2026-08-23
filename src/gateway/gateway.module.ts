import { Module } from '@nestjs/common';
import { MetricsModule } from '../metrics/metrics.module';
import { RouterModule } from '../router/router.module';
import { GatewayController } from './gateway.controller';

@Module({
  imports: [RouterModule, MetricsModule],
  controllers: [GatewayController],
})
export class GatewayModule {}
