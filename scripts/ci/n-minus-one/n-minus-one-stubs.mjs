import { readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const compatibilityDir = process.env.AIHUB_COMPAT_DIR;
if (!compatibilityDir) throw new Error('AIHUB_COMPAT_DIR is required');

/** @type {unknown} */
const gradeResponse = JSON.parse(
  readFileSync('test/fixtures/ai-writing/grade-task1.response.json', 'utf8'),
);
const emailKey = readFileSync(`${compatibilityDir}/resend.key`);
const emailCertificate = readFileSync(`${compatibilityDir}/resend.crt`);
/** @type {string[]} */
const emailCalls = [];
let writingCalls = 0;
let holdNextWritingRequest = false;
/** @type {(() => void) | undefined} */
let releaseWritingRequest;
/** @type {string | undefined} */
let verificationToken;

const writing = createHttpServer((request, response) => {
  if (request.url === '/__compat/state') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({ writingCalls, emailCalls, verificationToken }),
    );
    return;
  }
  if (request.url === '/__compat/hold') {
    holdNextWritingRequest = true;
    response.writeHead(204).end();
    return;
  }
  if (request.url === '/__compat/release') {
    releaseWritingRequest?.();
    releaseWritingRequest = undefined;
    response.writeHead(204).end();
    return;
  }
  writingCalls += 1;
  const respond = () => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(gradeResponse));
  };
  if (holdNextWritingRequest) {
    holdNextWritingRequest = false;
    releaseWritingRequest = respond;
    return;
  }
  respond();
});

const resend = createHttpsServer(
  { key: emailKey, cert: emailCertificate },
  (request, response) => {
    /** @type {string[]} */
    const chunks = [];
    request.on('data', (chunk) => {
      const value = /** @type {unknown} */ (chunk);
      if (typeof value === 'string') chunks.push(value);
      else if (Buffer.isBuffer(value)) chunks.push(value.toString('utf8'));
    });
    request.on('end', () => {
      try {
        const authorization = request.headers.authorization ?? '';
        const revision = authorization.includes('ci-candidate')
          ? 'candidate'
          : authorization.includes('ci-previous')
            ? 'previous'
            : 'unknown';
        /** @type {unknown} */
        const parsed = JSON.parse(chunks.join(''));
        if (!isRecord(parsed)) throw new Error('invalid provider request');
        const content = `${typeof parsed.html === 'string' ? parsed.html : ''}\n${typeof parsed.text === 'string' ? parsed.text : ''}`;
        const match = /\/verify-email\?token=([^&\s"'<>]+)/u.exec(content);
        if (match?.[1]) {
          verificationToken = decodeURIComponent(match[1]);
        }
        emailCalls.push(revision);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id: 'ci-compatibility-message' }));
      } catch {
        response.writeHead(400).end();
      }
    });
  },
);

await Promise.all([
  new Promise((resolve, reject) => {
    writing.once('error', reject);
    writing.listen(18080, '0.0.0.0', resolve);
  }),
  new Promise((resolve, reject) => {
    resend.once('error', reject);
    resend.listen(18443, '0.0.0.0', resolve);
  }),
]);

process.stdout.write('compatibility stubs ready\n');
