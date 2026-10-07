# Ryn for Visual Studio Code

Language support for [Ryn](https://ryn-lang.xyz) and the Rynix library.

## Features

- **Syntax highlighting** for keywords (`fun`, `when`, `choose`, `extend`, ...),
  primitive and built-in types, nested `/* */` comments, `#[...]` attributes,
  string interpolation (`"{player.health}"`), `0x`/`0b` literals, duration
  suffixes (`250ms`, `2s`), and `::` paths.
- **Completion**
  - after `use` and `module::`: std modules, project modules, and path
    dependencies from `ryn.yaml` (for example `rynix::window`);
  - after `Type::`: constructors, constants, and enum variants;
  - after `value.`: fields and methods of the inferred type. Types are inferred
    from `x := Type::new(..)`, `x: Type`, `x := y.method(..)`, field chains such
    as `camera.eye.`, and `self` inside `extend`;
  - keywords, types, built-ins, and local names everywhere else.
- **Signature help** inside calls, **hover** with the declaration and its `//`
  comment, **go to definition** for project and dependency symbols, and an
  **outline** of functions, types, and `extend` blocks.
- **Diagnostics**: `ryn check` runs on the project when a `.ryn` file is opened
  or saved, and its errors appear in the editor and the Problems panel.
- **Commands**: `Ryn: Run Project`, `Ryn: Build Project`, `Ryn: Check Current
  File`, `Ryn: Re-index Workspace`; the run button in the editor title runs the
  project.
- **Snippets**: `main`, `fun`, `struct`, `type`, `extend`, `when`, `choose`,
  `dropstruct`, `rynixwindow`, and more.

## Install

Download `ryn-lang-<version>.vsix` from the releases page, then:

```powershell
code --install-extension ryn-lang-0.1.0.vsix
```

or use **Extensions → … → Install from VSIX…** in VS Code.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `ryn.path` | `ryn` | The compiler used for diagnostics and the run/build commands. |
| `ryn.check.onSave` | `true` | Run `ryn check` when a file is opened or saved. |
| `ryn.completion.insertParentheses` | `true` | Insert `()` after completed functions. |

## Development

```powershell
npm test                                  # indexer, resolver, diagnostics, grammar
node tools/gen-std.js ../Ryn/stdlib/std/src  # refresh data/std.json from a Ryn checkout
npm run package                           # build the .vsix
```

## License

Mozilla Public License 2.0. See [LICENSE](LICENSE).
