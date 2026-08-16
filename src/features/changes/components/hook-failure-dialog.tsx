import { CircleAlert } from "lucide-react";
import type { HookFailureState } from "@/features/changes/stores/working-tree-store";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { TerminalOutput } from "@/components/terminal-output";

type HookFailureDialogProps = {
  readonly failure: HookFailureState;
  readonly onResolve: (resolution: "abort" | "ignore") => void;
};

/**
 * The decision a failed Git hook forces: abort the commit, or commit anyway.
 *
 * Extracted from `app-dialogs.tsx`, where it was written inline against the working-tree store
 * directly. It takes a callback instead, so the decision can be exercised without a store — and so
 * the dialog can be previewed, which an inline branch of a switchboard cannot.
 *
 * **Abort is the cancel action, not the affirmative one** (Convention 1): Radix focuses
 * `AlertDialogCancel` on open, and the safe choice when a hook has just refused a commit is to let
 * it stand. "Ignore and Continue" is the destructive action and is tinted as one.
 */
export function HookFailureDialog({ failure, onResolve }: HookFailureDialogProps) {
  const abort = <AlertDialogCancel onClick={() => onResolve("abort")}>Abort</AlertDialogCancel>;
  const ignore = (
    <AlertDialogAction variant="destructive" onClick={() => onResolve("ignore")}>
      Ignore and Continue
    </AlertDialogAction>
  );

  return (
    <AlertDialog open>
      <AlertDialogContent className="sm:max-w-[600px]">
        <AlertDialogHeader className="place-items-start text-left">
          <AlertDialogTitle className="flex items-center gap-2">
            <CircleAlert className="text-[var(--warning-text)]" aria-hidden />
            The {failure.hook} hook failed
          </AlertDialogTitle>
          <AlertDialogDescription>What would you like to do?</AlertDialogDescription>
        </AlertDialogHeader>
        <TerminalOutput output={failure.terminalOutput} />
        <AlertDialogFooter>
          {/* Convention 2: the platform decides which side the affirmative action sits on. */}
          {__DARWIN__ ? (
            <>
              {abort}
              {ignore}
            </>
          ) : (
            <>
              {ignore}
              {abort}
            </>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
