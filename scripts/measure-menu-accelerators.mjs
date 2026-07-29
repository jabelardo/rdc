// Verifies that Phase 4's extracted keybinding defaults still match every accelerator declaration
// in desktop-plus, before the two platform-conditional preference duplicates are folded into the
// 50-key runtime map.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const EXPECTED = [
  'preferences=CmdOrCtrl+,',
  'repository-preferences=CmdOrCtrl+Shift+,',
  'new-repository=CmdOrCtrl+N',
  'new-window=CmdOrCtrl+Alt+N',
  'add-local-repository=CmdOrCtrl+O',
  'clone-repository=CmdOrCtrl+Shift+O',
  'preferences=CmdOrCtrl+,',
  'repository-preferences=CmdOrCtrl+Shift+,',
  'quit=macos:Command+Q|windows:Alt+F4|other:CmdOrCtrl+Q',
  'select-all=CmdOrCtrl+A',
  'find=CmdOrCtrl+F',
  'show-changes=CmdOrCtrl+1',
  'show-history=CmdOrCtrl+2',
  'show-compare=CmdOrCtrl+3',
  'show-repository-list=CmdOrCtrl+T',
  'show-branches-list=CmdOrCtrl+B',
  'show-worktrees-list=CmdOrCtrl+Alt+W',
  'go-to-commit-message=CmdOrCtrl+G',
  'toggle-stashed-changes=Ctrl+H',
  'toggle-changes-filter=CmdOrCtrl+L',
  'reset-zoom=CmdOrCtrl+0',
  'zoom-in=CmdOrCtrl+=',
  'zoom-out=CmdOrCtrl+-',
  'increase-active-resizable-width=CmdOrCtrl+9',
  'decrease-active-resizable-width=CmdOrCtrl+8',
  'reload-window=CmdOrCtrl+Alt+R',
  'show-devtools=macos:Alt+Command+I|other:Ctrl+Shift+I',
  'push=CmdOrCtrl+P',
  'pull=CmdOrCtrl+Shift+P',
  'fetch=CmdOrCtrl+Shift+T',
  'remove-repository=CmdOrCtrl+Backspace',
  'view-repository-on-github=CmdOrCtrl+Shift+G',
  'open-in-shell=Ctrl+`',
  'open-working-directory=CmdOrCtrl+Shift+F',
  'open-external-editor=CmdOrCtrl+Shift+A',
  'open-with-external-editor=CmdOrCtrl+Shift+Alt+A',
  'create-issue-in-repository-on-github=CmdOrCtrl+I',
  'create-worktree=CmdOrCtrl+Shift+W',
  'create-branch=CmdOrCtrl+Shift+N',
  'rename-branch=CmdOrCtrl+Shift+R',
  'delete-branch=CmdOrCtrl+Shift+D',
  'discard-all-changes=CmdOrCtrl+Shift+Backspace',
  'stash-all-changes=CmdOrCtrl+Shift+S',
  'update-branch-with-contribution-target-branch=CmdOrCtrl+Shift+U',
  'compare-to-branch=CmdOrCtrl+Shift+B',
  'merge-branch=CmdOrCtrl+Shift+M',
  'squash-and-merge-branch=CmdOrCtrl+Shift+H',
  'rebase-branch=CmdOrCtrl+Shift+E',
  'compare-on-github=CmdOrCtrl+Shift+C',
  'branch-on-github=CmdOrCtrl+Alt+B',
  'preview-pull-request=CmdOrCtrl+Alt+P',
  'create-pull-request=CmdOrCtrl+R',
]

function nodeText(source, file, node) {
  return node === undefined ? undefined : source.slice(node.getStart(file), node.getEnd())
}

export function acceleratorDeclarations(source, fileName = 'build-default-menu.ts') {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const declarations = []

  function visit(node) {
    if (ts.isPropertyAssignment(node) && nodeText(source, file, node.name) === 'accelerator') {
      const properties = node.parent.properties.filter(ts.isPropertyAssignment)
      const property = name =>
        properties.find(candidate => nodeText(source, file, candidate.name) === name)
      const literal = name => {
        const initializer = property(name)?.initializer
        return initializer !== undefined && ts.isStringLiteral(initializer)
          ? initializer.text
          : undefined
      }

      const label = nodeText(source, file, property('label')?.initializer) ?? ''
      const id =
        literal('id') ??
        literal('role') ??
        (label.includes('Select All')
          ? 'select-all'
          : label.includes('Reset Zoom')
            ? 'reset-zoom'
            : label.includes('Zoom In')
              ? 'zoom-in'
              : label.includes('Zoom Out')
                ? 'zoom-out'
                : undefined)
      assert.ok(id, `accelerated menu item has no stable id: ${label}`)

      const initializer = node.initializer
      const accelerator = ts.isStringLiteral(initializer)
        ? initializer.text
        : ts.isIdentifier(initializer) && initializer.text === 'exitAccelerator'
          ? 'macos:Command+Q|windows:Alt+F4|other:CmdOrCtrl+Q'
          : 'macos:Alt+Command+I|other:Ctrl+Shift+I'
      declarations.push(`${id}=${accelerator}`)
    }
    ts.forEachChild(node, visit)
  }

  visit(file)
  return declarations
}

export function explicitMenuIds(source, fileName = 'default-menu.ts') {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const ids = new Set()

  function visit(node) {
    if (
      ts.isPropertyAssignment(node) &&
      nodeText(source, file, node.name) === 'id' &&
      ts.isStringLiteral(node.initializer)
    ) {
      ids.add(node.initializer.text)
    }
    ts.forEachChild(node, visit)
  }

  visit(file)
  return ids
}

if (process.argv[1]?.endsWith('measure-menu-accelerators.mjs')) {
  const upstream = process.argv[2] ?? '../desktop-plus'
  const path = `${upstream}/app/src/main-process/menu/build-default-menu.ts`
  const actual = acceleratorDeclarations(readFileSync(path, 'utf8'), path)
  assert.deepEqual(actual, EXPECTED)
  const bindingIds = new Set(
    actual.map(entry => entry.slice(0, entry.indexOf('=')))
  )
  assert.equal(bindingIds.size, 50)

  const localPath = 'src/lib/menu/default-menu.ts'
  const localIds = explicitMenuIds(readFileSync(localPath, 'utf8'), localPath)
  assert.deepEqual(
    [...bindingIds].filter(id => !localIds.has(id)),
    [],
    'the TypeScript menu structure is missing keybinding IDs'
  )
  console.log(
    '52 upstream accelerator declarations match 50 logical bindings and TypeScript menu IDs'
  )
}
