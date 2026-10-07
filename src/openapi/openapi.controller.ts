import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Controller, Get, Header } from '@nestjs/common';

import { buildOpenApiDocument } from './build-openapi-document';

function readPackageVersion(): string {
  // `../../package.json` from the compiled `dist/openapi/`, matching the
  // repo root the same way `scripts/generate-openapi.ts` does from `scripts/`.
  const packageJson = JSON.parse(
    readFileSync(join(__dirname, '../../package.json'), 'utf8'),
  ) as { version: string };
  return packageJson.version;
}

const DOCS_PAGE = `<!doctype html>
<html>
<head>
  <title>AIHUB API Reference</title>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body>
  <script id="api-reference" data-url="/openapi.json"></script>
  <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.72.1" integrity="sha384-JezfTaoGe2t8F2YRYUQosjM0S21blpE8j3yOUgTEiTKCyLWx9K4lfwjKPd8Dp7WY" crossorigin="anonymous"></script>
</body>
</html>
`;

const DOCS_CONTENT_SECURITY_POLICY =
  "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; script-src 'sha384-JezfTaoGe2t8F2YRYUQosjM0S21blpE8j3yOUgTEiTKCyLWx9K4lfwjKPd8Dp7WY'; style-src 'unsafe-inline'; connect-src 'self'; font-src https://fonts.scalar.com";

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
    return buildOpenApiDocument(readPackageVersion());
  }

  @Get('docs')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Content-Security-Policy', DOCS_CONTENT_SECURITY_POLICY)
  getDocsPage(): string {
    return DOCS_PAGE;
  }
}
