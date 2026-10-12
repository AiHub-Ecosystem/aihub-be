import { getOwnPrototypeMethod } from './own-prototype-method';

describe('getOwnPrototypeMethod', () => {
  it('rejects an inherited method without an own prototype descriptor', () => {
    class Base {
      method(): void {}
    }

    class Derived extends Base {}

    expect(() => getOwnPrototypeMethod(Derived.prototype, 'method')).toThrow(
      'Prototype method "method" is missing',
    );
  });
});
