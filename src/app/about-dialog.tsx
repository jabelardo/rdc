import type { Architecture } from "@/platform/paths";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ExternalLink } from "@/components/external-link";

type AboutDialogProps = {
  readonly architecture: Architecture | null;
  readonly onDismiss: () => void;
};

export function AboutDialog({ architecture, onDismiss }: AboutDialogProps) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onDismiss();
        }
      }}
    >
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>About RDC</DialogTitle>
          <DialogDescription>A native Git client built with Tauri and Rust.</DialogDescription>
        </DialogHeader>
        <p className="select-text">
          Version {__APP_VERSION__}
          {architecture === null ? "" : ` (${architecture})`}
        </p>
        <p className="flex flex-col gap-1">
          <ExternalLink href="https://github.com/jabelardo/rdc">rdc on GitHub</ExternalLink>
          <ExternalLink href="https://github.com/jabelardo/rdc/blob/main/LICENSE">
            MIT License
          </ExternalLink>
        </p>
        <DialogFooter>
          <Button onClick={onDismiss}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
