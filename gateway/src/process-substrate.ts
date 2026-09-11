import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, lstat, open, realpath } from "node:fs/promises";
import { posix } from "node:path";

const MAX_REGISTRY_BYTES = 64 * 1024;
const MAX_COMMANDS = 64;
const MAX_ARGUMENTS = 16;
const MAX_ARGUMENT_BYTES = 1_024;
const MAX_OUTPUT_BYTES_LIMIT = 256 * 1024;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 30_000;
const COMMAND_NAME = /^[a-z][a-z0-9._-]{0,63}$/;
const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);

export interface RegisteredProcessDescriptor {
  name: string;
  binary: string;
  args: string[];
  cwd: string;
  timeout_ms: number;
  max_output_bytes: number;
}

export interface RegisteredProcessRegistry {
  version: 1;
  commands: Map<string, RegisteredProcessDescriptor>;
  source: string;
}

export interface RegisteredProcessExecutionOptions {
  helperBin: string;
  signal?: AbortSignal;
}

export interface RegisteredProcessResult {
  ok: boolean;
  exit_code?: number;
  stdout?: string;
  stderr?: string;
  error?:
    | "unregistered_process"
    | "process_unavailable"
    | "process_timeout"
    | "process_cancelled"
    | "process_output_too_large"
    | "process_failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function validateAbsolutePath(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096) {
    throw new Error(`${name} must be a bounded absolute POSIX path`);
  }
  if (value.includes("\0") || !posix.isAbsolute(value)) {
    throw new Error(`${name} must be a bounded absolute POSIX path`);
  }
  const normalized = posix.normalize(value);
  if (normalized === "/") throw new Error(`${name} must not identify /`);
  return normalized;
}

function pathIsSameOrWithin(root: string, candidate: string): boolean {
  const relative = posix.relative(root, candidate);
  return relative === ""
    || (relative !== ".." && !relative.startsWith("../") && !posix.isAbsolute(relative));
}

async function validateCanonicalNativeExecutable(path: string, label: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isFile()) throw new Error(`${label} must be a regular file`);
  await access(path, fsConstants.X_OK);
  if (posix.normalize(await realpath(path)) !== path) {
    throw new Error(`${label} must be canonical and non-symlink`);
  }

  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const magic = Buffer.alloc(ELF_MAGIC.byteLength);
    const { bytesRead } = await handle.read(magic, 0, magic.byteLength, 0);
    if (bytesRead !== ELF_MAGIC.byteLength || !magic.equals(ELF_MAGIC)) {
      throw new Error(`${label} must be a native ELF executable`);
    }
  } finally {
    await handle.close();
  }
}

async function validateCanonicalDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory()) throw new Error("registered process cwd must be a directory");
  if (posix.normalize(await realpath(path)) !== path) {
    throw new Error("registered process cwd must be canonical and non-symlink");
  }
}

function parseDescriptor(value: unknown): RegisteredProcessDescriptor {
  if (!isRecord(value) || !hasExactKeys(value, [
    "name",
    "binary",
    "args",
    "cwd",
    "timeout_ms",
    "max_output_bytes",
  ])) {
    throw new Error("registered process descriptor has an invalid schema");
  }

  if (typeof value.name !== "string" || !COMMAND_NAME.test(value.name)) {
    throw new Error("registered process name is invalid");
  }
  if (!Array.isArray(value.args) || value.args.length > MAX_ARGUMENTS) {
    throw new Error("registered process args exceed the bounded registry contract");
  }
  const args = value.args.map((argument) => {
    if (
      typeof argument !== "string"
      || argument.includes("\0")
      || new TextEncoder().encode(argument).byteLength > MAX_ARGUMENT_BYTES
    ) {
      throw new Error("registered process argument is invalid");
    }
    return argument;
  });

  if (
    !Number.isInteger(value.timeout_ms)
    || (value.timeout_ms as number) < MIN_TIMEOUT_MS
    || (value.timeout_ms as number) > MAX_TIMEOUT_MS
  ) {
    throw new Error("registered process timeout_ms is outside the bounded range");
  }
  if (
    !Number.isInteger(value.max_output_bytes)
    || (value.max_output_bytes as number) < 1
    || (value.max_output_bytes as number) > MAX_OUTPUT_BYTES_LIMIT
  ) {
    throw new Error("registered process max_output_bytes is outside the bounded range");
  }

  return {
    name: value.name,
    binary: validateAbsolutePath(value.binary, "registered process binary"),
    args,
    cwd: validateAbsolutePath(value.cwd, "registered process cwd"),
    timeout_ms: value.timeout_ms as number,
    max_output_bytes: value.max_output_bytes as number,
  };
}

export async function loadRegisteredProcessRegistry(
  configuredPath: string,
  writableFilesystemRoot?: string | null,
): Promise<RegisteredProcessRegistry> {
  const registryPath = validateAbsolutePath(configuredPath, "registered process registry");
  const writableRoot = writableFilesystemRoot
    ? validateAbsolutePath(writableFilesystemRoot, "writable filesystem root")
    : null;
  if (writableRoot && pathIsSameOrWithin(writableRoot, registryPath)) {
    throw new Error("registered process registry must be outside the writable filesystem root");
  }

  let handle;
  try {
    handle = await open(registryPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    throw new Error("registered process registry is unavailable");
  }

  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 2 || stat.size > MAX_REGISTRY_BYTES) {
      throw new Error("registered process registry must be a bounded regular file");
    }
    if (posix.normalize(await realpath(registryPath)) !== registryPath) {
      throw new Error("registered process registry must be canonical and non-symlink");
    }

    const raw = await handle.readFile({ encoding: "utf8" });
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("registered process registry must contain valid JSON");
    }
    if (
      !isRecord(parsed)
      || !hasExactKeys(parsed, ["version", "commands"])
      || parsed.version !== 1
      || !Array.isArray(parsed.commands)
      || parsed.commands.length === 0
      || parsed.commands.length > MAX_COMMANDS
    ) {
      throw new Error("registered process registry has an invalid schema");
    }

    const commands = new Map<string, RegisteredProcessDescriptor>();
    for (const item of parsed.commands) {
      const descriptor = parseDescriptor(item);
      if (commands.has(descriptor.name)) {
        throw new Error(`duplicate registered process name: ${descriptor.name}`);
      }
      if (writableRoot && pathIsSameOrWithin(writableRoot, descriptor.binary)) {
        throw new Error("registered process binary must be outside the writable filesystem root");
      }
      if (writableRoot && pathIsSameOrWithin(writableRoot, descriptor.cwd)) {
        throw new Error("registered process cwd must be outside the writable filesystem root");
      }
      await validateCanonicalNativeExecutable(descriptor.binary, "registered process binary");
      await validateCanonicalDirectory(descriptor.cwd);
      commands.set(descriptor.name, descriptor);
    }

    return { version: 1, commands, source: registryPath };
  } finally {
    await handle.close();
  }
}

function minimalProcessEnvironment(): NodeJS.ProcessEnv {
  return {
    LANG: "C",
    LC_ALL: "C",
    PATH: "/nonexistent",
  };
}

function killProcessGroup(child: ReturnType<typeof spawn>): void {
  const pid = child.pid;
  if (pid !== undefined) {
    try {
      process.kill(-pid, "SIGKILL");
      return;
    } catch {
      // Fall back to the direct child if the process group disappeared or was
      // never established. The default Linux/Android path uses a detached
      // helper as group leader, so this is fail-closed cleanup only.
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // The child may already be terminal.
  }
}

export async function runRegisteredProcess(
  registry: RegisteredProcessRegistry,
  name: string,
  options: RegisteredProcessExecutionOptions,
): Promise<RegisteredProcessResult> {
  const descriptor = registry.commands.get(name);
  if (!descriptor) return { ok: false, error: "unregistered_process" };
  if (options.signal?.aborted) return { ok: false, error: "process_cancelled" };

  let helperBin: string;
  try {
    helperBin = validateAbsolutePath(options.helperBin, "registered process helper");
    await validateCanonicalNativeExecutable(helperBin, "registered process helper");
  } catch {
    return { ok: false, error: "process_unavailable" };
  }

  const helperArguments = [
    "--binary",
    descriptor.binary,
    "--cwd",
    descriptor.cwd,
    "--",
    ...descriptor.args,
  ];

  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(helperBin, helperArguments, {
        env: minimalProcessEnvironment(),
        shell: false,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      resolve({ ok: false, error: "process_unavailable" });
      return;
    }

    let settled = false;
    let terminationError: RegisteredProcessResult["error"] | null = null;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;

    const abortListener = () => terminate("process_cancelled");

    const finish = (result: RegisteredProcessResult) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abortListener);
      resolve(result);
    };

    const terminate = (error: RegisteredProcessResult["error"]) => {
      if (settled || terminationError !== null) return;
      terminationError = error;
      killProcessGroup(child);
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      if (terminationError !== null) return;
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes + stderrBytes > descriptor.max_output_bytes) {
        terminate("process_output_too_large");
        return;
      }
      stdout.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (terminationError !== null) return;
      stderrBytes += chunk.byteLength;
      if (stdoutBytes + stderrBytes > descriptor.max_output_bytes) {
        terminate("process_output_too_large");
        return;
      }
      stderr.push(chunk);
    });

    child.on("error", () => finish({ ok: false, error: "process_unavailable" }));
    child.on("close", (code) => {
      if (settled) return;
      if (terminationError !== null) {
        finish({ ok: false, error: terminationError });
        return;
      }
      const result = {
        exit_code: code ?? -1,
        stdout: Buffer.concat(stdout, stdoutBytes).toString("utf8"),
        stderr: Buffer.concat(stderr, stderrBytes).toString("utf8"),
      };
      finish(code === 0
        ? { ok: true, ...result }
        : { ok: false, error: "process_failed", ...result });
    });

    options.signal?.addEventListener("abort", abortListener, { once: true });
    if (options.signal?.aborted) {
      terminate("process_cancelled");
    }

    timer = setTimeout(() => {
      terminate("process_timeout");
    }, descriptor.timeout_ms);
  });
}
