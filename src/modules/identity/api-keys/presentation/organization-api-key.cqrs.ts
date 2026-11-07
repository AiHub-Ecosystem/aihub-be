import { Inject } from '@nestjs/common';
import {
  Command,
  CommandHandler,
  type ICommandHandler,
  type IQueryHandler,
  Query,
  QueryHandler,
} from '@nestjs/cqrs';

import {
  type CreateOrganizationApiKeyInput,
  type CreatedOrganizationApiKey,
} from '@/modules/identity/api-keys/application/create-organization-api-key';
import {
  CREATE_ORGANIZATION_API_KEY,
  type CreateOrganizationApiKeyPort,
} from '@/modules/identity/api-keys/application/create-organization-api-key.port';
import { type ListOrganizationApiKeysCommand } from '@/modules/identity/api-keys/application/list-organization-api-keys';
import {
  LIST_ORGANIZATION_API_KEYS,
  type ListOrganizationApiKeysPort,
} from '@/modules/identity/api-keys/application/list-organization-api-keys.port';
import { type OrganizationApiKeyView } from '@/modules/identity/api-keys/application/organization-api-key-view';
import type { RevokeOrganizationApiKeyCommand } from '@/modules/identity/api-keys/application/revoke-organization-api-key';
import {
  REVOKE_ORGANIZATION_API_KEY,
  type RevokeOrganizationApiKeyPort,
} from '@/modules/identity/api-keys/application/revoke-organization-api-key.port';
import {
  type RotateOrganizationApiKeyInput,
  type RotatedOrganizationApiKey,
} from '@/modules/identity/api-keys/application/rotate-organization-api-key';
import {
  ROTATE_ORGANIZATION_API_KEY,
  type RotateOrganizationApiKeyPort,
} from '@/modules/identity/api-keys/application/rotate-organization-api-key.port';

export class CreateOrganizationApiKeyMessage extends Command<CreatedOrganizationApiKey> {
  constructor(readonly input: CreateOrganizationApiKeyInput) {
    super();
  }
}

@CommandHandler(CreateOrganizationApiKeyMessage)
export class CreateOrganizationApiKeyHandler
  implements ICommandHandler<CreateOrganizationApiKeyMessage>
{
  constructor(
    @Inject(CREATE_ORGANIZATION_API_KEY)
    private readonly useCase: CreateOrganizationApiKeyPort,
  ) {}

  execute(command: CreateOrganizationApiKeyMessage) {
    return this.useCase.create(command.input);
  }
}

export class RotateOrganizationApiKeyMessage extends Command<RotatedOrganizationApiKey> {
  constructor(readonly input: RotateOrganizationApiKeyInput) {
    super();
  }
}

@CommandHandler(RotateOrganizationApiKeyMessage)
export class RotateOrganizationApiKeyHandler
  implements ICommandHandler<RotateOrganizationApiKeyMessage>
{
  constructor(
    @Inject(ROTATE_ORGANIZATION_API_KEY)
    private readonly useCase: RotateOrganizationApiKeyPort,
  ) {}

  execute(command: RotateOrganizationApiKeyMessage) {
    return this.useCase.rotate(command.input);
  }
}

export class RevokeOrganizationApiKeyMessage extends Command<OrganizationApiKeyView> {
  constructor(readonly input: RevokeOrganizationApiKeyCommand) {
    super();
  }
}

@CommandHandler(RevokeOrganizationApiKeyMessage)
export class RevokeOrganizationApiKeyHandler
  implements ICommandHandler<RevokeOrganizationApiKeyMessage>
{
  constructor(
    @Inject(REVOKE_ORGANIZATION_API_KEY)
    private readonly useCase: RevokeOrganizationApiKeyPort,
  ) {}

  execute(command: RevokeOrganizationApiKeyMessage) {
    return this.useCase.revoke(command.input);
  }
}

export class ListOrganizationApiKeysQuery extends Query<
  readonly OrganizationApiKeyView[]
> {
  constructor(readonly input: ListOrganizationApiKeysCommand) {
    super();
  }
}

@QueryHandler(ListOrganizationApiKeysQuery)
export class ListOrganizationApiKeysHandler
  implements IQueryHandler<ListOrganizationApiKeysQuery>
{
  constructor(
    @Inject(LIST_ORGANIZATION_API_KEYS)
    private readonly useCase: ListOrganizationApiKeysPort,
  ) {}

  execute(query: ListOrganizationApiKeysQuery) {
    return this.useCase.list(query.input);
  }
}
