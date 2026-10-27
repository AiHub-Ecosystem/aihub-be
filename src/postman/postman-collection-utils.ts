import { isRecord } from '@/common/is-record';
/**
 * Removes converter-generated response examples with unstable schema-faked
 * values; intentional examples live in the D1 handover scenarios.
 */
export function stripKey<T>(value: T, key: string): T {
  if (Array.isArray(value)) {
    const entries: readonly unknown[] = value;
    return entries.map((entry) => stripKey(entry, key)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([k]) => k !== key,
    );
    return Object.fromEntries(
      entries.map(([k, v]) => [k, stripKey(v, key)]),
    ) as T;
  }
  return value;
}

function itemIdentity(item: unknown): string | undefined {
  if (!isRecord(item)) {
    return undefined;
  }

  if (isRecord(item.request)) {
    const { method, url } = item.request;
    if (typeof method !== 'string' || !isRecord(url)) {
      return undefined;
    }

    const path = Array.isArray(url.path)
      ? url.path.every((part) => typeof part === 'string')
        ? url.path.join('/')
        : undefined
      : typeof url.raw === 'string'
        ? url.raw
        : undefined;
    return path === undefined
      ? undefined
      : JSON.stringify(['request', method.toUpperCase(), path]);
  }

  return typeof item.name === 'string' && Array.isArray(item.item)
    ? JSON.stringify(['folder', item.name])
    : undefined;
}

function preserveItemIds(
  generatedItems: readonly unknown[],
  previousItems: readonly unknown[],
): readonly unknown[] {
  const previousByIdentity = new Map<string, Record<string, unknown>>();
  for (const item of previousItems) {
    const identity = itemIdentity(item);
    if (identity !== undefined && isRecord(item)) {
      previousByIdentity.set(identity, item);
    }
  }

  return generatedItems.map((item) => {
    if (!isRecord(item)) {
      return item;
    }

    const identity = itemIdentity(item);
    const previous =
      identity === undefined ? undefined : previousByIdentity.get(identity);
    const result = { ...item };
    if (typeof previous?.id === 'string') {
      result.id = previous.id;
    }

    if (Array.isArray(item.item)) {
      result.item = preserveItemIds(
        item.item,
        Array.isArray(previous?.item) ? previous.item : [],
      );
    }

    return result;
  });
}

/** Retains Postman identities for unchanged items while adding new operations. */
export function preservePostmanIds(
  generated: unknown,
  previous: unknown,
): unknown {
  if (!isRecord(generated) || !isRecord(previous)) {
    return generated;
  }

  const result = { ...generated };
  if (
    isRecord(generated.info) &&
    isRecord(previous.info) &&
    typeof previous.info._postman_id === 'string'
  ) {
    result.info = { ...generated.info, _postman_id: previous.info._postman_id };
  }

  if (Array.isArray(generated.item) && Array.isArray(previous.item)) {
    result.item = preserveItemIds(generated.item, previous.item);
  }

  return result;
}
