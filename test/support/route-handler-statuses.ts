import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { RequestMethod } from '@nestjs/common';
import {
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import ts from 'typescript';

import { AppModule } from '@/app.module';
import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import { PUBLIC_ROUTES, type PublicRouteDef } from '@/catalog/public-routes';
import { isRecord } from '@/common/is-record';

/**
 * The statuses a route's handler really answers (#1998). A declaration and the
 * handler serving it are independent statements today, so this walk reads both
 * and a spec compares them.
 */

const SOURCE_ROOT = join(__dirname, '../../src');

type Controller = new (...args: never[]) => object;
type Handler = (...args: never[]) => unknown;

export interface DeclaredRoute {
  readonly routeId: string;
  readonly method: string;
  readonly path: string;
  /** Every status the route declares as a success. */
  readonly statuses: readonly number[];
}

export interface AnsweredStatuses {
  readonly handler: string;
  readonly statuses: readonly number[];
}

function metadataList(key: string, target: object): readonly unknown[] {
  const list: unknown = Reflect.getMetadata(key, target);
  return Array.isArray(list) ? list : [];
}

/** Every controller reachable from `AppModule` through module imports. */
function registeredControllers(): Set<Controller> {
  const controllers = new Set<Controller>();
  const seen = new Set<unknown>();
  const pending: unknown[] = [AppModule];

  while (pending.length > 0) {
    const entry = pending.pop();
    const target =
      isRecord(entry) && 'module' in entry ? entry['module'] : entry;
    if (typeof target !== 'function' || seen.has(target)) continue;
    seen.add(target);

    for (const controller of metadataList(
      MODULE_METADATA.CONTROLLERS,
      target,
    )) {
      controllers.add(controller as Controller);
    }
    pending.push(...metadataList(MODULE_METADATA.IMPORTS, target));
  }

  return controllers;
}

function isControllerClass(value: unknown): value is Controller {
  return (
    typeof value === 'function' &&
    Reflect.getMetadata(PATH_METADATA, value) !== undefined
  );
}

let controllerSources: Promise<Map<Controller, string>> | undefined;

/** Where each controller class is declared, found by importing every file. */
function controllersBySource(): Promise<Map<Controller, string>> {
  controllerSources ??= (async () => {
    const sources = new Map<Controller, string>();
    const files = readdirSync(SOURCE_ROOT, {
      recursive: true,
      encoding: 'utf8',
    })
      .filter((file) => file.endsWith('.controller.ts'))
      .sort();

    for (const file of files) {
      const path = join(SOURCE_ROOT, file);
      const loaded: unknown = await import(path);
      for (const value of Object.values(loaded as Record<string, unknown>)) {
        if (isControllerClass(value)) sources.set(value, path);
      }
    }
    return sources;
  })();
  return controllerSources;
}

function joinPath(prefix: string, path: string): string {
  return `/${[prefix, path]
    .join('/')
    .split('/')
    .filter((segment) => segment !== '')
    .join('/')}`;
}

/** The catalog writes a path parameter as `{name}`; Nest wants `:name`. */
function routeShape(path: string): string {
  return joinPath('', path.replace(/\{([^}]+)\}/g, ':$1'));
}

interface ServedHandler {
  readonly controller: Controller;
  readonly name: string;
  readonly handler: Handler;
}

function servedHandlers(
  controllers: Iterable<Controller>,
): Map<string, ServedHandler> {
  const served = new Map<string, ServedHandler>();

  for (const controller of controllers) {
    const prefix = Reflect.getMetadata(PATH_METADATA, controller) as string;
    const prototype = controller.prototype as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(prototype)) {
      const handler = prototype[name];
      if (typeof handler !== 'function') continue;
      const method: unknown = Reflect.getMetadata(METHOD_METADATA, handler);
      const path: unknown = Reflect.getMetadata(PATH_METADATA, handler);
      if (typeof method !== 'number' || typeof path !== 'string') continue;
      served.set(`${RequestMethod[method]} ${joinPath(prefix, path)}`, {
        controller,
        name,
        handler: handler as Handler,
      });
    }
  }

  return served;
}

/** Every `PublicRouteDef` and catalog operation, with the statuses it declares. */
export function declaredRoutes(): readonly DeclaredRoute[] {
  const publicRoutes = Object.entries(PUBLIC_ROUTES) as [
    string,
    PublicRouteDef,
  ][];

  return [
    ...publicRoutes.map(([routeId, route]) => ({
      routeId,
      method: route.method,
      path: route.path,
      statuses: [
        route.successStatus,
        ...(route.alternateSuccesses ?? []).map(({ status }) => status),
      ],
    })),
    ...Object.entries(OPERATION_CATALOG).map(([routeId, operation]) => ({
      routeId,
      method: operation.method,
      path: operation.path,
      /* A graded operation answers 200, which is what the document publishes. */
      statuses: [200],
    })),
  ];
}

/**
 * The integer literals a handler passes to `reply.status(...)` or
 * `reply.code(...)`. shortcut: a status held in a constant is invisible here,
 * read it from the declaration instead when that stops being enough.
 */
function statusLiteralsIn(
  sourceText: string,
  className: string,
  methodName: string,
): number[] {
  const source = ts.createSourceFile(
    `${className}.ts`,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
  );
  const statuses: number[] = [];

  const collectNumbers = (node: ts.Node): void => {
    if (ts.isNumericLiteral(node)) statuses.push(Number(node.text));
    ts.forEachChild(node, collectNumbers);
  };

  const classDeclaration = source.statements.find(
    (statement): statement is ts.ClassDeclaration =>
      ts.isClassDeclaration(statement) && statement.name?.text === className,
  );
  const method = classDeclaration?.members.find(
    (member): member is ts.MethodDeclaration =>
      ts.isMethodDeclaration(member) &&
      ts.isIdentifier(member.name) &&
      member.name.text === methodName,
  );
  if (method === undefined) {
    throw new Error(`${className}.${methodName} is not declared in its source`);
  }

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ['status', 'code'].includes(node.expression.name.text)
    ) {
      for (const argument of node.arguments) collectNumbers(argument);
    }
    ts.forEachChild(node, visit);
  };
  visit(method);

  return [...new Set(statuses)].sort((left, right) => left - right);
}

/**
 * The statuses one handler can answer: its `@HttpCode` metadata plus every
 * integer literal in its body, both read from the handler itself.
 */
export function answeredStatusesOf(
  controller: Controller,
  methodName: string,
  sourceText: string,
): number[] {
  const handler = (controller.prototype as Record<string, unknown>)[methodName];
  if (typeof handler !== 'function') {
    throw new Error(`${controller.name}.${methodName} is not a handler`);
  }
  const httpCode: unknown = Reflect.getMetadata(HTTP_CODE_METADATA, handler);

  return [
    ...new Set([
      ...(typeof httpCode === 'number' ? [httpCode] : []),
      ...statusLiteralsIn(sourceText, controller.name, methodName),
    ]),
  ].sort((left, right) => left - right);
}

/**
 * The statuses each declared route's handler can answer: its `@HttpCode`
 * metadata plus every integer literal it passes to `reply.status(...)` or
 * `reply.code(...)`. A route whose handler is not found is absent.
 */
export async function answeredStatusesByRoute(): Promise<
  Map<string, AnsweredStatuses>
> {
  const sources = await controllersBySource();
  const served = servedHandlers(registeredControllers());
  const sourceTexts = new Map<string, string>();
  const answered = new Map<string, AnsweredStatuses>();

  for (const route of declaredRoutes()) {
    const entry = served.get(`${route.method} ${routeShape(route.path)}`);
    if (entry === undefined) continue;

    const file = sources.get(entry.controller);
    if (file === undefined) {
      throw new Error(
        `${entry.controller.name} is registered but no controller file declares it`,
      );
    }
    const sourceText = sourceTexts.get(file) ?? readFileSync(file, 'utf8');
    sourceTexts.set(file, sourceText);

    answered.set(route.routeId, {
      handler: entry.name,
      statuses: answeredStatusesOf(entry.controller, entry.name, sourceText),
    });
  }

  return answered;
}

/** Every way a declaration and its handler disagree about a success status. */
export function statusViolations(
  routes: readonly DeclaredRoute[],
  answered: ReadonlyMap<string, AnsweredStatuses>,
): string[] {
  return routes.flatMap((route) => {
    const entry = answered.get(route.routeId);
    if (entry === undefined) {
      return [
        `${route.routeId}: no handler serves ${route.method} ${route.path}`,
      ];
    }
    return entry.statuses
      .filter((status) => !route.statuses.includes(status))
      .map(
        (status) =>
          `${route.routeId}: ${entry.handler} answers ${status}, but the route declares ${route.statuses.join('/')}`,
      );
  });
}
