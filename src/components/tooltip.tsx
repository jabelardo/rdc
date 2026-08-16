import { Children, useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { Tooltip as RadixTooltip } from "radix-ui";

/**
 * Every mounted tooltip's own `hide`, so something outside the component tree can force-close
 * whichever one happens to be open.
 *
 * Exists because `onBlur`/`onMouseLeave` are not reliable close signals once a *native* surface is
 * about to cover the trigger. Concretely: WebKit (both WKWebView on macOS and WebKitGTK on Linux)
 * does not focus a `<button>` on an ordinary mouse click, so the `.blur()` call after
 * `onContextMenu`/`onClick` in the row components is a no-op for the mouse case it was written for
 * — it only helps a keyboard user who reached the button via Tab. And once the native context menu
 * has opened, it owns the pointer, so `mouseleave` never fires on the now-covered trigger either.
 * The result, observed on macOS: hover the row's "more actions" button, open its context menu, and
 * the tooltip is still there, rendered behind the native popup, until some unrelated interaction
 * eventually closes it.
 */
const openTooltips = new Set<() => void>();

/** Force-closes every mounted tooltip. Call before showing any native surface that can cover one. */
export function dismissAllTooltips(): void {
  for (const hide of openTooltips) {
    hide();
  }
}

/**
 * Marks an element a tooltip must clear entirely, not merely its trigger.
 *
 * A control centred in a command bar sits above the bar's own bottom padding, so clearing only the
 * control can leave the bubble inside the bar, abutting or covering its bottom rule. Marking the
 * bar makes the clearance follow the bar's real geometry, rather than a gap constant that is
 * correct only for today's padding.
 */
const boundarySelector = "[data-tooltip-boundary]";

/** Distance between what is being cleared and the bubble. */
const gap = 7;
/** Never position a bubble under the native title bar. */
const titlebarGap = 36;
/** Keep a bubble off the viewport edges. */
const margin = 8;
/** Above this trigger height, the bubble follows the pointer rather than the trigger's edge. */
const pointerTrackingHeight = 100;

type Placement = {
  readonly side: "top" | "bottom";
  readonly sideOffset: number;
  readonly alignOffset: number;
};

/**
 * How far to shift the bubble along the trigger's left edge so it stays inside the viewport.
 *
 * **Measured from the anchor's left edge, not from where a centred bubble would land**, because the
 * result is handed to Radix as `alignOffset` with `align="start"` — and `align="start"` is not a
 * style choice. floating-ui only applies `alignmentAxis` when the placement carries an alignment:
 *
 * ```js
 * if (alignment && typeof alignmentAxis === 'number') { crossAxis = ... }
 * ```
 *
 * With `align="center"` the placement is a bare `"bottom"`, `alignment` is `undefined`, and the
 * offset is silently discarded. That is exactly what happened: this clamp was computed correctly,
 * thrown away, and — with `avoidCollisions` off — nothing constrained the bubble horizontally at
 * all, so a tooltip near the left edge rendered with its first words off-screen.
 *
 * Exported for its own test: jsdom reports every rect as zero, so the arithmetic can only be
 * verified apart from the DOM.
 */
export function horizontalAlignOffset(
  anchorLeft: number,
  anchorWidth: number,
  bubbleWidth: number,
  viewportWidth: number,
): number {
  const centred = anchorLeft + anchorWidth / 2 - bubbleWidth / 2;
  // `max` outermost so an over-wide bubble overflows to the *right*. Clamping the other way round
  // pushes its left edge off-screen, which loses the beginning of the sentence — the one failure
  // that makes a tooltip useless rather than merely awkward.
  const left = Math.max(margin, Math.min(viewportWidth - bubbleWidth - margin, centred));
  return left - anchorLeft;
}

type TooltipProps = {
  readonly label: string;
  readonly children: ReactElement;
};

/**
 * One application-owned tooltip for pointer and keyboard users.
 *
 * Radix owns what a tooltip primitive should own: open/close semantics, `aria-describedby` wiring,
 * Escape dismissal, the portal, and horizontal clamping to the viewport. rdc supplies the vertical
 * offset, because two of its behaviours have no Radix equivalent — and one of them cannot be
 * expressed with Radix's collision props at all.
 *
 * **Boundary clearance is not collision handling.** `collisionBoundary` *contains* content within a
 * boundary; rdc pushes content *past* an ancestor. Measured during `UI_FOUNDATION_PLAN.md`'s
 * sub-slice 3.0 spike, configuring collision against the bar moved the bubble further up *into* the
 * bar (39px where the contract is 75.25px). So the clearance is a computed `sideOffset` instead:
 * one measurement and one subtraction, with Radix still doing the positioning.
 *
 * **Pointer tracking** on a tall row is anchor-incompatible by nature — Radix positions against the
 * trigger's box, and here the bubble must follow `clientY` down a row taller than the bubble. Same
 * mechanism: express the desired top as an offset from the trigger's bottom edge.
 */
export function Tooltip({ label, children }: TooltipProps) {
  const child = Children.only(children) as ReactElement<{ readonly disabled?: boolean }>;
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<Placement | null>(null);
  // Radix types its Trigger ref as a button; the element rdc measures is whatever the caller
  // passed through `asChild`, so the ref is stored as the general element type it really is.
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const pointerY = useRef<number | null>(null);

  const hide = useCallback(() => {
    setOpen(false);
    setPlacement(null);
    pointerY.current = null;
  }, []);

  // Registered for the component's whole lifetime, not just while open: `dismissAllTooltips` must
  // be able to reach a tooltip the instant it opens, and hiding an already-closed one is a
  // harmless no-op.
  useEffect(() => {
    openTooltips.add(hide);
    return () => {
      openTooltips.delete(hide);
    };
  }, [hide]);

  /**
   * Where the bubble should sit, expressed as offsets from Radix's own placement.
   *
   * `null` only before the trigger exists. The bubble's own height refines the result — whether it
   * fits below, where its centre lands — so the first frame renders hidden and the second, once the
   * content ref has fired, positions. Exactly the two passes the hand-rolled implementation made.
   */
  const measure = useCallback((): Placement | null => {
    const trigger = triggerRef.current;
    if (trigger === null) {
      return null;
    }
    const anchor = trigger.getBoundingClientRect();
    // Zero is what an unmeasurable bubble reports, and it has to stay positionable: the offsets
    // that need a height only *refine* the placement, and a bubble that is never positioned is
    // never shown. This is the difference between "not measured yet" and "cannot be measured".
    const bubble = contentRef.current?.getBoundingClientRect() ?? { height: 0, width: 0 };

    // Centring and viewport clamping are both rdc's, because collision handling is off — it cannot
    // be reconciled with boundary clearance, which pushes *past* an ancestor where collision
    // handling contains *within* one.
    const alignOffset = horizontalAlignOffset(
      anchor.left,
      anchor.width,
      bubble.width,
      window.innerWidth,
    );

    if (anchor.height > pointerTrackingHeight) {
      const targetY = pointerY.current ?? anchor.top + anchor.height / 2;
      const top = Math.min(
        window.innerHeight - bubble.height - margin,
        Math.max(titlebarGap, targetY - bubble.height / 2),
      );
      return { side: "bottom", sideOffset: top - anchor.bottom, alignOffset };
    }

    // Clear the whole boundary when the trigger sits inside one, so the bubble never lands on the
    // bar hosting it. Falls back to the trigger's own edges, which is the behaviour for any control
    // outside a bar. Symmetrical: flipping above has to clear the boundary's top for the same
    // reason it has to clear its bottom going down.
    const boundary = trigger.closest(boundarySelector)?.getBoundingClientRect();
    const clearanceBottom = Math.max(anchor.bottom, boundary?.bottom ?? anchor.bottom);
    const clearanceTop = Math.min(anchor.top, boundary?.top ?? anchor.top);
    const below = clearanceBottom + gap;

    if (below + bubble.height <= window.innerHeight - margin) {
      return { side: "bottom", sideOffset: below - anchor.bottom, alignOffset };
    }
    // Above: Radix measures the offset from the trigger's top edge upwards, so convert the desired
    // top into that distance.
    const above = Math.max(titlebarGap, clearanceTop - bubble.height - gap);
    return { side: "top", sideOffset: anchor.top - bubble.height - above, alignOffset };
  }, []);

  const reposition = useCallback(() => {
    setPlacement(measure());
  }, [measure]);

  const trackPointer = useCallback(
    (clientY: number) => {
      const anchor = triggerRef.current?.getBoundingClientRect();
      if (anchor === undefined || anchor.height <= pointerTrackingHeight) {
        return;
      }
      pointerY.current = clientY;
      reposition();
    },
    [reposition],
  );

  const content = (
    <RadixTooltip.Portal>
      <RadixTooltip.Content
        ref={(node) => {
          contentRef.current = node;
          // A tall trigger's offset needs the bubble's height, so the first usable measurement is
          // the one taken once it exists.
          if (node !== null && placement === null) {
            reposition();
          }
        }}
        className="app-tooltip"
        side={placement?.side ?? "bottom"}
        // Not cosmetic: `alignOffset` is ignored unless the placement carries an alignment. The
        // bubble is still centred — `horizontalAlignOffset` does the centring itself.
        align="start"
        sideOffset={placement?.sideOffset ?? gap}
        alignOffset={placement?.alignOffset ?? 0}
        avoidCollisions={false}
        style={placement === null ? { visibility: "hidden" } : undefined}
      >
        {label}
      </RadixTooltip.Content>
    </RadixTooltip.Portal>
  );

  // A disabled control receives no pointer events, so the tooltip has to be anchored to a wrapper
  // that does. `data-tooltip` stays on it for the same reason it stays on an enabled trigger.
  if (child.props.disabled === true) {
    return (
      <RadixTooltip.Provider delayDuration={0}>
        <RadixTooltip.Root
          open={open}
          onOpenChange={(next) => {
            if (next) {
              reposition();
            }
            setOpen(next);
          }}
        >
          <RadixTooltip.Trigger asChild ref={triggerRef}>
            <span className="disabled-tooltip-anchor" data-tooltip={label}>
              {child}
            </span>
          </RadixTooltip.Trigger>
          {content}
        </RadixTooltip.Root>
      </RadixTooltip.Provider>
    );
  }

  return (
    <RadixTooltip.Provider delayDuration={0}>
      <RadixTooltip.Root
        open={open}
        onOpenChange={(next) => {
          if (next) {
            reposition();
          }
          setOpen(next);
        }}
      >
        <RadixTooltip.Trigger
          asChild
          ref={triggerRef}
          data-tooltip={label}
          onMouseMove={(event) => trackPointer(event.clientY)}
        >
          {child}
        </RadixTooltip.Trigger>
        {content}
      </RadixTooltip.Root>
    </RadixTooltip.Provider>
  );
}
