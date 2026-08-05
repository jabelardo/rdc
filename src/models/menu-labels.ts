import type { Shell } from "./shell";
import type { RepoType } from "./github-repository";

export type MenuLabelsEvent = {
  readonly selectedShell: Shell | null;
  readonly selectedExternalEditor: string | null;
  readonly askForConfirmationOnForcePush: boolean;
  readonly askForConfirmationOnRepositoryRemoval: boolean;
  readonly contributionTargetDefaultBranch?: string;
  readonly isForcePushForCurrentRepository?: boolean;
  readonly hasCurrentPullRequest?: boolean;
  readonly isStashedChangesVisible?: boolean;
  readonly askForConfirmationWhenStashingAllChanges?: boolean;
  readonly gitHubRepositoryType: RepoType | null;
  readonly isChangesFilterVisible?: boolean;
};
