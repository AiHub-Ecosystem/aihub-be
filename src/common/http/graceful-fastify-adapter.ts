import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { FastifyServerOptions } from 'fastify';

import { waitForBackgroundWork } from './background-work-drain';

export class GracefulFastifyAdapter extends FastifyAdapter {
  constructor(
    options?: FastifyServerOptions,
    private readonly flushTelemetry: () => Promise<void> = async () =>
      undefined,
  ) {
    super(options);
    this.getInstance().addHook('onClose', waitForBackgroundWork);
  }

  // Nest awaits this at runtime before module destroy hooks, despite the base
  // adapter's declaration returning void.
  override beforeClose(): void {
    return this.close().then(() => this.flushTelemetry()) as unknown as void;
  }
}
