import { Module } from '@nestjs/common';
import { RouterModule } from '../router/router.module';
import { GatewayController } from './gateway.controller';

@Module({
  imports: [RouterModule],
  controllers: [GatewayController],
})
export class GatewayModule {}
