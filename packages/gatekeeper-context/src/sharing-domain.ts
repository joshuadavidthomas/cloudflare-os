import { DEFAULT_SHARING_DOMAIN } from "./domain.js";

/** Resolve the Context data-isolation domain across supported deployment mechanisms. */
export function resolveSharingDomain(
  bindingDomain: string | undefined,
  environmentDomain: string | undefined,
): string {
  return bindingDomain ?? environmentDomain ?? DEFAULT_SHARING_DOMAIN;
}
