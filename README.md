# Markdown Code Checking

A VS Code extension for writing C code inside Markdown-based source documents, with live compiler diagnostics and automatic transpilation.

## Features

- **Live C syntax checking:** Extracts fenced C code blocks and checks them using Clang without compiling or linking a program.
- **Source-mapped diagnostics:** Reports compiler errors and warnings at the corresponding locations in the Markdown document.
- **Automatic checking:** Checks documents when opened, after edits, and when saved. Edit-triggered checks are debounced to reduce unnecessary compiler invocations.
- **MDC transpilation:** Runs the MDC transpiler when an `.mdc` document is saved.
- **Separate error reporting:** Reports C syntax errors and transpilation failures independently.

Both `.mdc` and `.mdh` files support C syntax checking.

## Requirements

- VS Code or a compatible editor, such as VSCodium.
- Clang, available on your system or configured through the extension settings.
- The MDC transpiler, required for `.mdc` transpilation.

## Configuration

The extension provides the following settings.

| Setting | Default | Description |
|---|---|---|
| `mdc.clangPath` | `clang` | Path or executable name of the Clang compiler. |
| `mdc.clangArgs` | `["-std=c11"]` | Additional arguments passed to Clang. |
| `mdc.executable` | `mdc` | Path or executable name of the MDC transpiler. |

You can configure these settings in VS Code's `settings.json`.

For example, on Linux:

```json
{
  "mdc.clangPath": "/usr/bin/clang",
  "mdc.clangArgs": [
    "-std=c11"
  ],
  "mdc.executable": "mdc"
}
```

If both executables are available through your system's `PATH`, their default values are sufficient.

The extension can also use absolute paths when executables are installed outside your `PATH`.

## Usage

Write C code inside fenced Markdown code blocks:

````markdown
# Example

This code is checked by the extension.

```c
#include <stdio.h>

int main(void) {
  printf("Hello, world!\n");
  return 0;
}
```
````

The extension extracts C code blocks and invokes Clang in syntax-checking mode. Compiler diagnostics are displayed directly in the document.

No executable is produced by the syntax checker.

### Manual checking

Run the **MDC: Check C Code** command from the VS Code Command Palette to trigger a C syntax check manually.

### Automatic transpilation

When an `.mdc` document is saved, the extension invokes the configured MDC transpiler. Transpilation errors are reported separately from C compiler diagnostics.

## How it works

The extension uses two independent processes:

1. **C syntax checking:** Extracts fenced C blocks, invokes Clang with `-fsyntax-only`, and maps diagnostics back to the original document.
2. **MDC transpilation:** Invokes the configured MDC executable when an `.mdc` document is saved.

This allows the document to remain the primary source while still providing compiler feedback during editing.

## License

See the repository's `LICENSE` file.
