import {
  type ArgumentMetadata,
  Injectable,
  type PipeTransform,
} from '@nestjs/common';

import { invalidRequest } from '@/common/errors/invalid-request';
import { containsNulCharacter } from './nul-character';

/**
 * Global pipe that refuses a NUL character in a path parameter or query value.
 * Bodies are covered by `parseRequestBody`; path and query values reach
 * repositories without a schema, and Fastify decodes `%00` into them.
 */
@Injectable()
export class RejectNulCharactersPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    if (
      (metadata.type === 'param' || metadata.type === 'query') &&
      containsNulCharacter(value)
    ) {
      throw invalidRequest();
    }
    return value;
  }
}
