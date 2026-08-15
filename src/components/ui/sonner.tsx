import type { CSSProperties } from "react";
import { Toaster as Sonner, type ToasterProps } from "sonner";
import {
  CircleCheckIcon,
  InfoIcon,
  TriangleAlertIcon,
  OctagonXIcon,
  Loader2Icon,
} from "lucide-react";

// shadcn's own generated wrapper reads next-themes here, which assumes a Next.js ThemeProvider
// this app does not have; without one, `useTheme()` always falls back to "system" and silently
// ignores a user's explicit light/dark preference. rdc already tracks the active theme in
// preferences-store.ts (the same ThemeSource type sonner's own `theme` prop expects), so the
// caller passes it straight through instead.
const Toaster = ({ theme = "system", ...props }: ToasterProps) => {
  return (
    <Sonner
      theme={theme}
      richColors
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      // `richColors` is what makes sonner style a toast by severity at all. Without it every
      // severity renders with the `--normal-*` trio below and only the icon differs, which is how
      // an error toast ended up looking identical to an info one.
      //
      // Sonner's per-severity variables are `--{severity}-bg|text|border`, and for text and border
      // those names are exactly rdc's own tokens — so `--error-text` and `--error-border` are
      // inherited from `:root` and already correct, in both themes. Only the background needs
      // mapping, because rdc calls that one `--error-surface`. Do not "fix" this by writing
      // `--error-text: var(--error-text)`: that is a self-reference, and the property drops out.
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--error-bg": "var(--error-surface)",
          "--warning-bg": "var(--warning-surface)",
          // rdc has no info palette, and sonner's default is a blue that appears nowhere else in
          // the app. An info message is a confirmation, so the neutral surface is right for it.
          "--info-bg": "var(--popover)",
          "--info-text": "var(--popover-foreground)",
          "--info-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
