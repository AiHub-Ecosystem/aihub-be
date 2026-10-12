export function getOwnPrototypeMethod<T extends object, K extends keyof T>(
  prototype: T,
  methodName: K,
): T[K] {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, methodName);
  if (typeof descriptor?.value !== 'function') {
    throw new Error(`Prototype method "${String(methodName)}" is missing`);
  }

  return prototype[methodName];
}
