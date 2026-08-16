import type { ICustomIntegration } from "@/models/custom-integration";

export type {
  ICustomIntegration,
  ICustomIntegrationPathValidation,
} from "@/models/custom-integration";
export { isValidCustomIntegration, validateCustomIntegrationPath } from "@/platform/editors";

type PersistedCustomIntegration = Omit<ICustomIntegration, "arguments"> & {
  readonly arguments: string | ReadonlyArray<string>;
};

/**
 * Convert the first custom-integration storage format to the current one.
 *
 * Returning null means no persisted update is needed. The broader input type is intentional:
 * deserialized legacy settings can contain the old array even though the current domain model cannot.
 */
export function migratedCustomIntegration(
  customIntegration: PersistedCustomIntegration | null,
): ICustomIntegration | null {
  if (customIntegration === null || !Array.isArray(customIntegration.arguments)) {
    return null;
  }

  return {
    ...customIntegration,
    arguments: customIntegration.arguments.join(" "),
  };
}
