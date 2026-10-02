import type { SpeakingGradeInput } from '@/contracts/speaking/grading';

export const SPEAKING_MULTIPART_PARSER = Symbol('SPEAKING_MULTIPART_PARSER');

export interface SpeakingMultipartLimits {
  readonly fileSize: number;
  readonly fieldSize: number;
  readonly files: number;
  readonly fields: number;
  readonly parts: number;
}

export interface SpeakingMultipartFilePart {
  readonly type: 'file';
  readonly fieldname: string;
  readonly filename: string;
  readonly contentType: string;
  readonly bytes: AsyncIterable<Uint8Array>;
  readonly truncated: () => boolean;
}

export interface SpeakingMultipartFieldPart {
  readonly type: 'field';
  readonly fieldname: string;
  readonly value: unknown;
  readonly truncated: boolean;
}

export type SpeakingMultipartPart =
  | SpeakingMultipartFilePart
  | SpeakingMultipartFieldPart;

export interface SpeakingMultipartSource {
  parts(
    options: SpeakingMultipartLimits,
  ): AsyncIterableIterator<SpeakingMultipartPart>;
  abort(): void;
}

export interface SpeakingMultipartParserPort {
  parse(
    source: SpeakingMultipartSource,
    signal: AbortSignal,
  ): Promise<SpeakingGradeInput>;
}
