import * as vscode from "vscode";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const diagnostics = vscode.languages.createDiagnosticCollection("mdc");
const output = vscode.window.createOutputChannel("MDC Transpiler");
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const checkGenerations = new Map<string, number>();

interface CompileCommand {
  directory: string;
  file: string;
  arguments?: string[];
  command?: string;
}

interface LoadedCompileDatabase {
  mtimeMs: number;
  size: number;
  entries: CompileCommand[];
}

const compileDatabaseCache = new Map<string, LoadedCompileDatabase>();

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

/** Split a POSIX compile command into arguments without invoking a shell. */
function splitCommand(command: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let tokenStarted = false;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];

    if (escaped) {
      current += char;
      escaped = false;
      tokenStarted = true;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escaped = true;
      tokenStarted = true;
      continue;
    }

    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      tokenStarted = true;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      tokenStarted = true;
      continue;
    }

    if (/\s/.test(char)) {
      if (tokenStarted) {
        args.push(current);
        current = "";
        tokenStarted = false;
      }
      continue;
    }

    current += char;
    tokenStarted = true;
  }

  if (escaped) current += "\\";
  if (tokenStarted) args.push(current);
  return args;
}

function resolveCompileDatabasePath(
  configuredPath: string,
  workspaceFolder: vscode.WorkspaceFolder | undefined
): string | undefined {
  if (configuredPath.trim()) {
    let resolved = configuredPath.trim();
    if (workspaceFolder) {
      resolved = resolved.replace(/\$\{workspaceFolder\}/g, workspaceFolder.uri.fsPath);
    }
    if (!path.isAbsolute(resolved)) {
      resolved = path.resolve(workspaceFolder?.uri.fsPath ?? process.cwd(), resolved);
    }
    return resolved;
  }
  return undefined;
}

async function findCompileDatabase(
  workspaceFolder: vscode.WorkspaceFolder | undefined
): Promise<string | undefined> {
  if (!workspaceFolder) return undefined;

  const root = workspaceFolder.uri.fsPath;
  const preferred = [
    path.join(root, "compile_commands.json"),
    path.join(root, "build", "compile_commands.json"),
    path.join(root, "cmake-build-debug", "compile_commands.json"),
    path.join(root, "cmake-build-release", "compile_commands.json")
  ];

  for (const candidate of preferred) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // Continue looking in other common locations.
    }
  }

  const ignoredDirectories = new Set([
    ".git", ".hg", ".svn", "node_modules", "vendor", "out", "dist"
  ]);
  const maxDepth = 4;

  async function searchDirectory(directory: string, depth: number): Promise<string | undefined> {
    if (depth > maxDepth) return undefined;

    let children;
    try {
      children = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return undefined;
    }

    for (const child of children) {
      if (child.isFile() && child.name === "compile_commands.json") {
        return path.join(directory, child.name);
      }
    }

    if (depth === maxDepth) return undefined;

    for (const child of children) {
      if (!child.isDirectory() || ignoredDirectories.has(child.name)) continue;
      const found = await searchDirectory(path.join(directory, child.name), depth + 1);
      if (found) return found;
    }

    return undefined;
  }

  return searchDirectory(root, 1);
}

async function loadCompileDatabase(databasePath: string): Promise<CompileCommand[]> {
  let stat;
  try {
    stat = await fs.stat(databasePath);
  } catch {
    compileDatabaseCache.delete(databasePath);
    return [];
  }

  const cached = compileDatabaseCache.get(databasePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.entries;
  }

  try {
    const parsed: unknown = JSON.parse(await fs.readFile(databasePath, "utf8"));
    if (!Array.isArray(parsed)) throw new Error("The JSON root must be an array.");

    const entries = parsed.filter((entry): entry is CompileCommand => {
      if (!entry || typeof entry !== "object") return false;
      const candidate = entry as Partial<CompileCommand>;
      return typeof candidate.directory === "string"
        && typeof candidate.file === "string"
        && (Array.isArray(candidate.arguments) || typeof candidate.command === "string");
    });

    compileDatabaseCache.set(databasePath, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      entries
    });
    return entries;
  } catch (error) {
    output.appendLine(`Could not read compile database "${databasePath}": ${String(error)}`);
    compileDatabaseCache.delete(databasePath);
    return [];
  }
}

function commandSourcePath(entry: CompileCommand): string {
  return path.resolve(entry.directory, entry.file);
}

function documentSourceCandidates(document: vscode.TextDocument): string[] {
  const filePath = document.uri.fsPath;
  const candidates: string[] = [];

  if (filePath.toLowerCase().endsWith(".mdh")) {
    candidates.push(filePath.slice(0, -4) + ".c");
    candidates.push(filePath.slice(0, -4) + ".mdc");
  } else {
    candidates.push(filePath.slice(0, -4) + ".c");
  }

  return candidates.map(candidate =>
    candidate.toLowerCase().endsWith(".mdc")
      ? candidate.slice(0, -4) + ".c"
      : candidate
  );
}

function findCompileCommand(
  entries: CompileCommand[],
  document: vscode.TextDocument
): CompileCommand | undefined {
  const candidates = documentSourceCandidates(document).map(candidate => path.resolve(candidate));
  const exact = entries.find(entry => candidates.includes(commandSourcePath(entry)));
  if (exact) return exact;

  // Generated C may live in a build directory. A unique basename match is safe;
  // ambiguous matches are deliberately rejected rather than selecting the wrong target.
  const expectedNames = new Set(candidates.map(candidate => path.basename(candidate)));
  const basenameMatches = entries.filter(entry =>
    expectedNames.has(path.basename(commandSourcePath(entry)))
  );
  return basenameMatches.length === 1 ? basenameMatches[0] : undefined;
}

function compileArguments(entry: CompileCommand): string[] {
  const original = entry.arguments ? [...entry.arguments] : splitCommand(entry.command ?? "");
  if (original.length === 0) return [];

  const args = original.slice(1);
  const sourcePath = commandSourcePath(entry);
  const result: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "-c" || arg === "-MD" || arg === "-MMD" || arg === "-MP"
      || arg === "-MG" || arg === "-fcolor-diagnostics" || arg === "-fdiagnostics-color"
      || arg.startsWith("-fdiagnostics-color=")) {
      continue;
    }

    if (["-o", "-MF", "-MT", "-MQ", "--serialize-diagnostics"].includes(arg)) {
      i++;
      continue;
    }

    if (arg.startsWith("--output=") || arg.startsWith("-o") && arg.length > 2) continue;

    if (path.isAbsolute(arg) || arg.includes("/") || arg.includes("\\")) {
      const resolved = path.resolve(entry.directory, arg);
      if (resolved === sourcePath) continue;
    }

    if (arg === entry.file || path.resolve(entry.directory, arg) === sourcePath) continue;
    result.push(arg);
  }

  return result;
}

async function getClangInvocation(
  document: vscode.TextDocument,
  config: vscode.WorkspaceConfiguration,
  clangArgs: string[]
): Promise<{ args: string[]; cwd: string }> {
  output.appendLine("getClangInvocation reached");
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  const documentDirectory = path.dirname(document.uri.fsPath);
  const fallbackCwd = workspaceFolder?.uri.fsPath ?? documentDirectory;
  const configuredPath = config.get<string>("compileCommandsPath", "");
  let databasePath = resolveCompileDatabasePath(configuredPath, workspaceFolder);

  if (!databasePath) databasePath = await findCompileDatabase(workspaceFolder);

  output.appendLine(`Workspace: ${workspaceFolder?.uri.fsPath ?? "NONE"}`);
  output.appendLine(`Database: ${databasePath ?? "NONE"}`);

  if (databasePath) {
    const entries = await loadCompileDatabase(databasePath);
    const entry = findCompileCommand(entries, document);

    output.appendLine(`Entries: ${entries.length}`);
    output.appendLine(`MDC file: ${document.uri.fsPath}`);
    output.appendLine(`Candidates: ${documentSourceCandidates(document).join(", ")}`);
    output.appendLine(`Matched C file: ${entry ? commandSourcePath(entry) : "NONE"}`);
    
    if (entry) {
      const args = compileArguments(entry);
      // The package default is -std=c11. Do not let that default override the
      // standard already selected by CMake; explicit non-default flags remain
      // available through mdc.clangArgs.
      const additionalArgs = args.some(arg => arg.startsWith("-std="))
        ? clangArgs.filter(arg => arg !== "-std=c11")
        : clangArgs;
      return {
        args: [
          ...args,
          ...additionalArgs,
          "-x", "c", "-fsyntax-only", "-fno-color-diagnostics",
          "-iquote", documentDirectory,
          "-"
        ],
        cwd: entry.directory
      };
    }
  }

  return {
    args: [
      ...clangArgs, "-x", "c", "-fsyntax-only", "-fno-color-diagnostics",
      "-iquote", documentDirectory,
      ...(workspaceFolder ? ["-I", workspaceFolder.uri.fsPath] : []), "-"
    ],
    cwd: fallbackCwd
  };
}

async function checkDocument(document: vscode.TextDocument): Promise<void> {
  output.appendLine(`checkDocument called: ${document.uri.fsPath}`);
  
  if (!isMdc(document)) return;

  const key = document.uri.toString();
  const version = document.version;
  const generation = (checkGenerations.get(key) ?? 0) + 1;
  checkGenerations.set(key, generation);

  const source = reconstructSource(document.getText());
  const config = vscode.workspace.getConfiguration("mdc", document.uri);
  const clangPath = config.get<string>("clangPath", "clang");
  const clangArgs = config.get<string[]>("clangArgs", ["-std=c11"]);
  const invocation = await getClangInvocation(document, config, clangArgs);

  const result = await new Promise<{ stderr: string; error?: Error }>((resolve) => {
    let stderr = "";
    let settled = false;
    const finish = (value: { stderr: string; error?: Error }) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const child = spawn(clangPath, invocation.args, {
      cwd: invocation.cwd, stdio: ["pipe", "ignore", "pipe"]
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
