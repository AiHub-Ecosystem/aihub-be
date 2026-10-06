import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';

@Module({
  imports: [TerminusModule.forRoot({ logger: false })],
  exports: [TerminusModule],
})
export class ReadinessTerminusModule {}
