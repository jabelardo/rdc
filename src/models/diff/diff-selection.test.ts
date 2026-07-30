import { describe, expect, it } from 'vitest'
import {
  DiffSelection,
  DiffSelectionType,
} from './diff-selection'

describe('DiffSelection selected line transport', () => {
  it('returns selected selectable lines in stable numeric order', () => {
    const selection = DiffSelection.fromInitialSelection(
      DiffSelectionType.All
    )
      .withSelectableLines(new Set([8, 2, 5]))
      .withLineSelection(5, false)

    expect(selection.getSelectedLines()).toEqual([2, 8])
  })

  it('requires the diff to define which lines are selectable', () => {
    const selection = DiffSelection.fromInitialSelection(
      DiffSelectionType.All
    )

    expect(() => selection.getSelectedLines()).toThrow(
      'Selectable diff lines have not been loaded.'
    )
  })
})
