import { Controller, Get } from '@nestjs/common';
import { RouterService } from '../router/router.service';

@Controller('health')
export class HealthController {
  constructor(private readonly router: RouterService) {}

  @Get()
  health(): Record<string, unknown> {
    const providers = this.router.breakerSnapshots();

    return {
      // the gateway is up even with every provider tripped, and that state has
      // to be visible rather than inferred from a failing request
      status: 'ok',
      providers: providers.map((provider) => ({
        provider: provider.provider,
        state: provider.state,
        failures: provider.failures,
        successes: provider.successes,
        openedAt:
          provider.openedAt === undefined
            ? null
            : new Date(provider.openedAt).toISOString(),
      })),
    };
  }
}
