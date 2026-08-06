import { Checkbox } from "../../../components/ui/checkbox";

type ConfirmOptOutProps = {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
};

/**
 * "Do not show this message again", for a confirmation the user can switch off.
 *
 * Ported from desktop-plus, including the part that is easy to miss: the preference is written when
 * the user *confirms*, not when the box is ticked. Ticking it and then cancelling leaves the
 * confirmation in place, so the guard on an irreversible action is never removed by a click that
 * was itself a change of mind.
 */
export function ConfirmOptOut({ checked, onChange }: ConfirmOptOutProps) {
  return (
    <label className="flex w-fit items-center gap-2">
      <Checkbox checked={checked} onCheckedChange={(value) => onChange(value === true)} />
      Do not show this message again
    </label>
  );
}
