import type { ReactNode } from "react";
import { openExternal } from "../platform/files";
import { cn } from "../utils";

type ExternalLinkProps = {
  readonly href: string;
  readonly children: ReactNode;
  readonly className?: string;
};

/**
 * A link that opens in the user's browser rather than inside the app.
 *
 * A webview has no chrome to get back from, so letting a normal anchor navigate would strand the
 * user in a page with no way out. The `href` is kept on the element so the URL still shows in a
 * hover/status context and the accessible role stays `link`, but navigation is cancelled and handed
 * to the OS. `openExternal` guards the URL scheme, so an unexpected scheme is refused there.
 */
export function ExternalLink({ href, children, className }: ExternalLinkProps) {
  return (
    <a
      className={cn("text-primary w-fit underline-offset-4 hover:underline", className)}
      href={href}
      onClick={(event) => {
        event.preventDefault();
        void openExternal(href);
      }}
    >
      {children}
    </a>
  );
}
