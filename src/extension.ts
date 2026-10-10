import * as vscode from "vscode";
import { spawn } from "node:child_process";
import * as path from "node:path";

const diagnostics = vscode.languages.createDiagnosticCollection("mdc");
const output = vscode.window.createOutputChannel("MDC Transpiler");
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const checkGenerations = new Map<string, number>();

function isMdc(document: vscode.TextDocument): boolean {
  if (document.uri.scheme !== "file") return false;
  const filePath = document.uri.fsPath.toLowerCase();
  return filePath.endsWith(".mdc") || filePath.endsWith(".mdh");
}

/** Extract C fences while preserving source line numbers for diagnostics. */
function reconstructSource(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const result = Array<string>(lines.length).fill("");
  const openingFence = /^ {0,3}(`{3,}|~{3,})(.*)$/;

  for (let i = 0; i < lines.length;) {
    const opening = openingFence.exec(lines[i]);
    if (!opening) {
      i++;
      continue;
    }

    const marker = opening[1];
    const language = opening[2].trim().split(/\s+/)[0].toLowerCase();
    const isC = language === "c";
    const closingFence = new RegExp(
      "^ {0,3}" + (marker[0] === "`" ? "`" : "~") +
      "{" + marker.length + ",}[ \\t]*$"
    );

    let closing = i + 1;
    while (closing < lines.length && !closingFence.test(lines[closing])) closing++;

    if (isC) {
      for (let line = i + 1; line < closing; line++) result[line] = lines[line];
    }
    i = closing < lines.length ? closing + 1 : lines.length;
  }

  return result.join("\n");
}

function parseDiagnostics(stderr: string, document: vscode.TextDocument): vscode.Diagnostic[] {
  const result: vscode.Diagnostic[] = [];
  for (const line of stderr.split(/\r?\n/)) {
    const match = /^(?:-|<stdin>|stdin):(\d+):(\d+): (fatal error|error|warning|note): (.*)$/.exec(line);
    if (!match) continue;

    const lineNumber = Number(match[1]);
    const columnNumber = Number(match[2]);
    const kind = match[3];
    if (lineNumber < 1 || lineNumber > document.lineCount) continue;

    const sourceLine = document.lineAt(lineNumber - 1);
    const character = Math.min(Math.max(columnNumber - 1, 0), sourceLine.text.length);
    const severity = kind === "warning"
      ? vscode.DiagnosticSeverity.Warning
      : kind === "note"
        ? vscode.DiagnosticSeverity.Information
        : vscode.DiagnosticSeverity.Error;

    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(lineNumber - 1, character, lineNumber - 1,
        Math.min(character + 1, sourceLine.text.length)),
      match[4], severity
    );
    diagnostic.source = "clang";
    result.push(diagnostic);
  }
  return result;
}

async function checkDocument(document: vscode.TextDocument): Promise<void> {
  if (!isMdc(document)) return;

  const key = document.uri.toString();
  const version = document.version;
  const generation = (checkGenerations.get(key) ?? 0) + 1;
  checkGenerations.set(key, generation);

  const source = reconstructSource(document.getText());
  const config = vscode.workspace.getConfiguration("mdc", document.uri);
  const clangPath = config.get<string>("clangPath", "clang");
  const clangArgs = config.get<string[]>("clangArgs", ["-std=c11"]);
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  const documentDirectory = path.dirname(document.uri.fsPath);
  const args = [
    ...clangArgs, "-x", "c", "-fsyntax-only", "-fno-color-diagnostics",
    "-iquote", documentDirectory,
    ...(workspaceFolder ? ["-I", workspaceFolder.uri.fsPath] : []), "-"
  ];
  const cwd = workspaceFolder?.uri.fsPath ?? documentDirectory;

  const result = await new Promise<{ stderr: string; error?: Error }>((resolve) => {
    let stderr = "";
    let settled = false;
    const finish = (value: { stderr: string; error?: Error }) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const child = spawn(clangPath, args, {
      cwd, stdio: ["pipe", "ignore", "pipe"]
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => finish({ stderr, error }));
    child.on("close", () => finish({ stderr }));
    child.stdin.on("error", () => { /* Clang may exit before reading all input. */ });
    child.stdin.end(source);
  });

  if (document.version !== version || checkGenerations.get(key) !== generation) return;

  if (result.error) {
    diagnostics.set(document.uri, [new vscode.Diagnostic(
      new vscode.Range(0, 0, 0, 0),
      `Could not start Clang ("${clangPath}"): ${result.error.message}`,
      vscode.DiagnosticSeverity.Error
    )]);
    return;
  }

  const parsed = parseDiagnostics(result.stderr, document);
  if (parsed.length === 0 && result.stderr.trim() !== "") {
    parsed.push(new vscode.Diagnostic(
      new vscode.Range(0, 0, 0, 0), result.stderr.trim(), vscode.DiagnosticSeverity.Error
    ));
  }
  diagnostics.set(document.uri, parsed);
}

function scheduleCheck(document: vscode.TextDocument): void {
  if (!isMdc(document)) return;
  const key = document.uri.toString();
  const previous = debounceTimers.get(key);
  if (previous) clearTimeout(previous);

  debounceTimers.set(key, setTimeout(() => {
    debounceTimers.delete(key);
    void checkDocument(document);
  }, 300));
}

async function translateDocument(document: vscode.TextDocument): Promise<void> {
  if (!isMdc(document) || document.isUntitled) return;

  const config = vscode.workspace.getConfiguration("mdc", document.uri);
  const executable = config.get<string>("executable", "mdc");
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  const documentDirectory = path.dirname(document.uri.fsPath);
  const cwd = workspaceFolder?.uri.fsPath ?? documentDirectory;

  const result = await new Promise<{
    code: number | null; stdout: string; stderr: string; error?: Error;
  }>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (value: { code: number | null; stdout: string; stderr: string; error?: Error }) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const child = spawn(executable, [document.uri.fsPath], {
      cwd, stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => finish({ code: null, stdout, stderr, error }));
    child.on("close", (code) => finish({ code, stdout, stderr }));
  });

  if (!result.error && result.code === 0) {
    if (result.stdout.trim() || result.stderr.trim()) {
      output.appendLine(`[${document.uri.fsPath}]`);
      if (result.stdout.trim()) output.appendLine(result.stdout.trimEnd());
      if (result.stderr.trim()) output.appendLine(result.stderr.trimEnd());
    }
    return;
  }

  const details = [
    result.error
      ? `Could not start the MDC transpiler ("${executable}"): ${result.error.message}`
      : `MDC transpiler exited with code ${result.code}.`,
    result.stdout.trim(), result.stderr.trim()
  ].filter(Boolean).join("\n");
  output.appendLine(`[${document.uri.fsPath}]`);
  output.appendLine(details);
  output.show(true);
  void vscode.window.showErrorMessage(
    `MDC translation failed for ${path.basename(document.uri.fsPath)}. See the MDC Transpiler output for details.`
  );
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(diagnostics, output);
  context.subscriptions.push(vscode.commands.registerCommand("mdc.check", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isMdc(editor.document)) {
      vscode.window.showInformationMessage("Open an .mdc or .mdh file to check its C code.");
      return;
    }
    await checkDocument(editor.document);
  }));
  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(scheduleCheck));
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((event) => {
    scheduleCheck(event.document);
  }));
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument((document) => {
    if (!isMdc(document)) return;
    void checkDocument(document);
    void translateDocument(document);
  }));
  context.subscriptions.push(vscode.workspace.onDidCloseTextDocument((document) => {
    const key = document.uri.toString();
    const timer = debounceTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      debounceTimers.delete(key);
    }
    checkGenerations.delete(key);
    diagnostics.delete(document.uri);
  }));

  for (const document of vscode.workspace.textDocuments) scheduleCheck(document);
}

export function deactivate(): void {
  for (const timer of debounceTimers.values()) clearTimeout(timer);
  debounceTimers.clear();
  checkGenerations.clear();
  diagnostics.clear();
  diagnostics.dispose();
  output.dispose();
}
