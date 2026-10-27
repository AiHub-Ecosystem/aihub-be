import { Controller, Get, Header, Query } from '@nestjs/common';
import { Type } from '@sinclair/typebox';

import { parseRequestQuery } from '@/common/http/parse-request-query';
import { buildOpenApiDocument } from './build-openapi-document';
import {
  PUBLIC_API_CONTRACT_VERSION,
  PUBLIC_API_MAJOR_PATH,
} from './public-api-contract-version';

const DOCS_QUERY_SCHEMA = Type.Object(
  { version: Type.Optional(Type.Literal(PUBLIC_API_MAJOR_PATH)) },
  { additionalProperties: false },
);

function docsPage(version: string): string {
  return `<!doctype html>
<html>
<head>
  <title>AIHUB API Reference</title>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body>
  <form action="/docs" method="get">
    <label for="api-version">API version</label>
    <select id="api-version" name="version">
      <option value="${version}" selected>${version} (current)</option>
    </select>
    <button type="submit">View</button>
  </form>
  <script id="api-reference" data-url="/openapi/${version}.json"></script>
  <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.72.1" integrity="sha384-JezfTaoGe2t8F2YRYUQosjM0S21blpE8j3yOUgTEiTKCyLWx9K4lfwjKPd8Dp7WY" crossorigin="anonymous"></script>
</body>
</html>
`;
}

const DOCS_CONTENT_SECURITY_POLICY =
  "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'sha384-JezfTaoGe2t8F2YRYUQosjM0S21blpE8j3yOUgTEiTKCyLWx9K4lfwjKPd8Dp7WY'; style-src 'unsafe-inline'; connect-src 'self'; font-src https://fonts.scalar.com";

/**
 * No `@UseGuards` here, deliberately: this is public reference material, not
 * a Writing operation, and a prospective customer generating a client has no
 * API key yet. Every route in this app is authenticated per-controller (see
 * `src/modules/writing/presentation/`), never through a global guard, so
 * omitting one here is enough to keep this open.
 */
@Controller()
export class OpenApiController {
  @Get('openapi.json')
  getSpec(): unknown {
    // Built fresh from the running catalog on every call rather than reading
    // the committed `openapi.json` off disk — the AC requires the served
    // spec to always match the running build with no regeneration step
    // anyone can forget. The committed file exists for git diffing and for
    // `pnpm generate:postman`'s input, not as this endpoint's source.
    return buildOpenApiDocument(PUBLIC_API_CONTRACT_VERSION);
  }

  @Get('openapi/v1.json')
  getVersionOneSpec(): unknown {
    return buildOpenApiDocument(PUBLIC_API_CONTRACT_VERSION);
  }

  @Get('docs')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Content-Security-Policy', DOCS_CONTENT_SECURITY_POLICY)
  getDocsPage(@Query() rawQuery: unknown): string {
    const { version = PUBLIC_API_MAJOR_PATH } = parseRequestQuery(
      DOCS_QUERY_SCHEMA,
      rawQuery,
    );
    return docsPage(version);
  }
}
