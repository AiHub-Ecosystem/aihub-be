import {
  Controller,
  Get,
  Header,
  NotFoundException,
  Param,
  Query,
} from '@nestjs/common';
import { Type } from '@sinclair/typebox';

import {
  type PublicApiMajorDef,
  findPublicApiMajor,
  latestPublicApiMajor,
  supportedPublicApiMajors,
} from '@/catalog/public-api-majors';
import { parseRequestQuery } from '@/common/http/parse-request-query';
import { buildOpenApiDocument } from './build-openapi-document';

const VERSIONED_DOCUMENT = /^v([1-9][0-9]*)\.json$/u;

const DOCS_QUERY_SCHEMA = Type.Object(
  {
    version: Type.Optional(
      Type.Union(
        supportedPublicApiMajors().map(({ major }) =>
          Type.Literal(`v${major}`),
        ),
      ),
    ),
  },
  { additionalProperties: false },
);

/** The supported major a `/openapi/vN.json` file name names, if any. */
export function versionedDocumentMajor(
  file: string,
  majors?: readonly PublicApiMajorDef[],
): PublicApiMajorDef | undefined {
  const match = VERSIONED_DOCUMENT.exec(file);
  const major =
    match?.[1] === undefined
      ? undefined
      : findPublicApiMajor(Number(match[1]), majors);
  return major?.status === 'supported' ? major : undefined;
}

export function docsPage(
  version: string,
  majors?: readonly PublicApiMajorDef[],
): string {
  const latest = latestPublicApiMajor(majors).major;
  const options = supportedPublicApiMajors(majors)
    .map(({ major }) => major)
    .sort((left, right) => right - left)
    .map((major) => {
      const value = `v${major}`;
      const selected = value === version ? ' selected' : '';
      const current = major === latest ? ' (current)' : '';
      return `      <option value="${value}"${selected}>${value}${current}</option>`;
    })
    .join('\n');
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
${options}
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
    return buildOpenApiDocument(latestPublicApiMajor());
  }

  /** Each supported major's contract; a retired major's is no longer served. */
  @Get('openapi/:document')
  getVersionedSpec(@Param('document') document: string): unknown {
    const major = versionedDocumentMajor(document);
    if (major === undefined) {
      throw new NotFoundException();
    }
    return buildOpenApiDocument(major);
  }

  @Get('docs')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Content-Security-Policy', DOCS_CONTENT_SECURITY_POLICY)
  getDocsPage(@Query() rawQuery: unknown): string {
    const { version = `v${latestPublicApiMajor().major}` } = parseRequestQuery(
      DOCS_QUERY_SCHEMA,
      rawQuery,
    );
    return docsPage(version);
  }
}
