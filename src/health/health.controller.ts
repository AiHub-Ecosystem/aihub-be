import {
  Controller,
  Get,
  HttpStatus,
  Inject,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  HealthIndicatorService,
} from '@nestjs/terminus';
import type { FastifyReply } from 'fastify';
import { READINESS_PROBES, type ReadinessProbe } from './readiness-probes';

const READINESS_TIMEOUT_MS = 1_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeDependencies(
  details: Readonly<Record<string, unknown>>,
): Readonly<Record<string, 'up' | 'down'>> {
  return Object.fromEntries(
    Object.entries(details).map(([name, value]) => [
      name,
      isRecord(value) && value.status === 'up' ? 'up' : 'down',
    ]),
  );
}

@Controller()
export class HealthController {
  constructor(
    private readonly healthCheck: HealthCheckService,
    private readonly healthIndicator: HealthIndicatorService,
    @Inject(READINESS_PROBES)
    private readonly readinessProbes: readonly ReadinessProbe[],
  ) {}

  @Get('health')
  getHealth(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  @HealthCheck({ swaggerDocumentation: false })
  async getReadiness(@Res({ passthrough: true }) reply: FastifyReply): Promise<{
    readonly status: 'ok' | 'error';
    readonly dependencies: Readonly<Record<string, 'up' | 'down'>>;
  }> {
    const checks = this.readinessProbes.map((probe) =>
      this.healthIndicator
        .check(probe.name)
        .attempt(() => probe.check(READINESS_TIMEOUT_MS))
        .withTimeout(READINESS_TIMEOUT_MS),
    );

    try {
      const result = await this.healthCheck.check(checks);
      return {
        status: 'ok',
        dependencies: safeDependencies(result.details),
      };
    } catch (error) {
      if (!(error instanceof ServiceUnavailableException)) {
        throw error;
      }

      reply.status(HttpStatus.SERVICE_UNAVAILABLE);
      const response = error.getResponse();
      const details =
        isRecord(response) && isRecord(response.details)
          ? response.details
          : {};
      return {
        status: 'error',
        dependencies: safeDependencies(details),
      };
    }
  }
}
