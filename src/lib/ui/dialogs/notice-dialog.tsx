import { CircleAlert } from "lucide-react";
import type { ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../../components/ui/alert-dialog";

type NoticeDialogProps = {
  readonly title: string;
  readonly children: ReactNode;
  readonly dismissLabel?: string;
  readonly onDismiss: () => void;
};

/**
 * A dialog that reports something and offers only a way out — no action to confirm.
 *
 * The single button is solid rather than outline (Convention 7): with nothing to differentiate
 * against, an outline just looks recessive. Convention 1 does not apply because there is no
 * destructive choice to make safe, and Convention 2's ordering is moot at one button.
 */
export function NoticeDialog({
  title,
  children,
  dismissLabel = "Close",
  onDismiss,
}: NoticeDialogProps) {
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onDismiss();
        }
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader className="place-items-start text-left">
          <AlertDialogTitle className="flex items-center gap-2">
            <CircleAlert className="text-[var(--warning-text)]" aria-hidden />
            {title}
          </AlertDialogTitle>
          <AlertDialogDescription>{children}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction>{dismissLabel}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
