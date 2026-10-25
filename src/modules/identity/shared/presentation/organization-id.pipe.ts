import type { PipeTransform } from '@nestjs/common';
import { Value } from '@sinclair/typebox/value';

import { invalidRequest } from '@/common/errors/invalid-request';
import {
  type OrganizationId,
  OrganizationIdSchema,
} from '@/contracts/organization/organization-id';

export class OrganizationIdPipe
  implements PipeTransform<string, OrganizationId>
{
  transform(value: string): OrganizationId {
    if (!Value.Check(OrganizationIdSchema, value)) {
      // arch-check: validates an Organization path parameter, not a request body
      throw invalidRequest();
    }
    return value;
  }
}
