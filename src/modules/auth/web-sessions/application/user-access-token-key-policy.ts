export const USER_ACCESS_TOKEN_MINIMUM_RSA_MODULUS_BITS = 2048;

export function userAccessTokenRsaModulusIsAcceptable(
  modulusLength: number | undefined,
): boolean {
  return (
    modulusLength !== undefined &&
    modulusLength >= USER_ACCESS_TOKEN_MINIMUM_RSA_MODULUS_BITS
  );
}
