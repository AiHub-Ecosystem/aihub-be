import type { MeteringEvidence } from '@/modules/metering/application/metering-evidence';

declare module 'fastify' {
  interface FastifyRequest {
    aihubMetering?: MeteringEvidence;
  }
}

export {
  getMeteringEvidence,
  openMeteringEvidence,
  addMeteringEvidence,
} from '@/modules/metering/application/metering-evidence';
