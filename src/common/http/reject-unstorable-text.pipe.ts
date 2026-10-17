import {
  type ArgumentMetadata,
  Injectable,
  type PipeTransform,
} from '@nestjs/common';

import { invalidRequest } from '@/common/errors/invalid-request';
import { containsUnstorableText } from './unstorable-text';

/**
 * Global pipe that refuses text PostgreSQL cannot store, a NUL or a lone
 * surrogate, in a path parameter or query value. Bodies are covered by
 * `parseRequestBody`; path and query values reach repositories without a
 * schema, and Fastify decodes `%00` into them.
 */
@Injectable()
export class RejectUnstorableTextPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    if (
      (metadata.type === 'param' || metadata.type === 'query') &&
      containsUnstorableText(value)
    ) {
      throw invalidRequest();
    }
    return value;
  }
}
