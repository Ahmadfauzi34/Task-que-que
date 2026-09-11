import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import { posix } from "node:path";

import { GATEWAY_VERSION, type GatewayDependencies } from "./app";

const MAX_GIT_OUTPUT_BYTES = 256 * 1024;
const MAX_LOG_COMMITS = 32;
const MAX_REFS = 128;
const HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export type GitMetadataOperation =
  | "probe"
  | "head-sha"
  | "head-branch"
  | "log"
  | "refs";

export interface GitMetadataCommand {
  binary: string;
  repository: string;
  operation: GitMetadataOperation;
  timeoutMs: number;
}

export interface GitMetadataResult {
  ok: boolean;
  stdout?: string;
  error?: string;
}

export type GitMetadataRunner = (
  command: GitMetadataCommand,
) => Promise<GitMetadataResult>;

interface GitAwareDependencies extends GatewayDependencies {
  gitMetadataRunImpl?: GitMetadataRunner;
}

interface ValidatedGitProvider {
  binary: string;
  repository: string;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(`${JSON.stringify(value)}\n`, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-gateway-version": GATEWAY_VERSION,
    },
  });
}

function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse({ error: { code, message } }, status);
}

function safeGitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      key.startsWith("GIT_")
      || key === "PAGER"
      || key === "LESS"
      || key === "LV"
    ) {
      continue;
    }
    env[key] = value;
  }

  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_ATTR_NOSYSTEM = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_PAGER = "cat";
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_NO_REPLACE_OBJECTS = "1";
  env.PAGER = "cat";
  env.LC_ALL = "C";
  env.LANG = "C";
  return env;
}

function operationArgs(operation: GitMetadataOperation): string[] {
  switch (operation) {
    case "probe":
      return ["rev-parse", "--show-toplevel"];
    case "head-sha":
      return ["rev-parse", "--verify", "HEAD"];
    case "head-branch":
      return ["symbolic-ref", "--quiet", "--short", "HEAD"];
    case "log":
      return [
        "log",
        `--max-count=${MAX_LOG_COMMITS}`,
        "--no-decorate",
        "--no-show-signature",
        "--pretty=format:%H%x09%ct%x09%P",
      ];
    case "refs":
      return [
        "for-each-ref",
        `--count=${MAX_REFS}`,
        "--sort=refname",
        "--format=%(refname)%09%(objectname)%09%(objecttype)",
        "refs/heads",
        "refs/tags",
      ];
  }
}

export const defaultGitMetadataRunner: GitMetadataRunner = async (
  command,
) => new Promise((resolve) => {
  const args = [
    "--no-pager",
    "--no-optional-locks",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.untrackedCache=false",
    "-c",
    "color.ui=false",
    "-c",
    "log.showSignature=false",
    "-C",
    command.repository,
    ...operationArgs(command.operation),
  ];

  let child;
  try {
    child = spawn(command.binary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: safeGitEnvironment(),
    });
  } catch {
    resolve({ ok: false, error: "git_process_unavailable" });
    return;
  }

  let settled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const stdout: Buffer[] = [];

  const finish = (result: GitMetadataResult) => {
    if (settled) return;
    settled = true;
    if (timer !== null) clearTimeout(timer);
    resolve(result);
  };

  const overflow = () => {
    child.kill("SIGKILL");
    finish({ ok: false, error: "git_output_too_large" });
  };

  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.byteLength;
    if (stdoutBytes > MAX_GIT_OUTPUT_BYTES) {
      overflow();
      return;
    }
    stdout.push(chunk);
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.byteLength;
    if (stderrBytes > MAX_GIT_OUTPUT_BYTES) overflow();
  });

  child.on("error", () => finish({ ok: false, error: "git_process_unavailable" }));
  child.on("close", (code) => {
    if (code !== 0) {
      finish({ ok: false, error: "git_command_failed" });
      return;
    }
    finish({
      ok: true,
      stdout: Buffer.concat(stdout, stdoutBytes).toString("utf8"),
    });
  });

  timer = setTimeout(() => {
    child.kill("SIGKILL");
    finish({ ok: false, error: "git_process_timeout" });
  }, command.timeoutMs);
});

async function validateConfiguredGitProvider(
  dependencies: GatewayDependencies,
): Promise<ValidatedGitProvider | null> {
  const repository = dependencies.config.gitRepository;
  const binary = dependencies.config.gitBin;
  if (!repository || !binary) return null;
  if (/\r|\n/.test(repository) || /\r|\n/.test(binary)) return null;

  const gitDir = posix.join(repository, ".git");
  try {
    const [repositoryStat, gitDirStat, binaryStat] = await Promise.all([
      lstat(repository),
      lstat(gitDir),
      lstat(binary),
    ]);
    if (!repositoryStat.isDirectory() || !gitDirStat.isDirectory() || !binaryStat.isFile()) {
      return null;
    }
    await access(binary, fsConstants.X_OK);

    const [repositoryReal, gitDirReal, binaryReal] = await Promise.all([
      realpath(repository),
      realpath(gitDir),
      realpath(binary),
    ]);
    if (
      posix.normalize(repositoryReal) !== repository
      || posix.normalize(gitDirReal) !== gitDir
      || posix.normalize(binaryReal) !== binary
    ) {
      return null;
    }

    return { repository, binary };
  } catch {
    return null;
  }
}

async function invokeGit(
  dependencies: GatewayDependencies,
  operation: GitMetadataOperation,
): Promise<GitMetadataResult> {
  const provider = await validateConfiguredGitProvider(dependencies);
  if (!provider) return { ok: false, error: "git_provider_unavailable" };

  const runner = (dependencies as GitAwareDependencies).gitMetadataRunImpl
    ?? defaultGitMetadataRunner;
  try {
    return await runner({
      ...provider,
      operation,
      timeoutMs: dependencies.config.upstreamTimeoutMs,
    });
  } catch {
    return { ok: false, error: "git_process_unavailable" };
  }
}

export async function gitMetadataAvailable(
  dependencies: GatewayDependencies,
): Promise<boolean> {
  const provider = await validateConfiguredGitProvider(dependencies);
  if (!provider) return false;

  const runner = (dependencies as GitAwareDependencies).gitMetadataRunImpl
    ?? defaultGitMetadataRunner;
  let result: GitMetadataResult;
  try {
    result = await runner({
      ...provider,
      operation: "probe",
      timeoutMs: dependencies.config.upstreamTimeoutMs,
    });
  } catch {
    return false;
  }
  return result.ok && result.stdout?.trim() === provider.repository;
}

function mapGitFailure(result: GitMetadataResult): Response {
  switch (result.error) {
    case "git_provider_unavailable":
    case "git_process_unavailable":
      return errorResponse(503, "git_provider_unavailable", "Git metadata provider is unavailable");
    case "git_process_timeout":
      return errorResponse(504, "git_provider_timeout", "Git metadata provider timed out");
    case "git_output_too_large":
      return errorResponse(502, "git_output_too_large", "Git metadata output exceeded the bounded provider limit");
    default:
      return errorResponse(502, "git_command_failed", "Git metadata provider could not produce a valid result");
  }
}

function parseHash(value: string): string | null {
  const normalized = value.trim();
  return HASH.test(normalized) ? normalized : null;
}

function parseLog(stdout: string): Record<string, unknown>[] | null {
  if (stdout.length === 0) return [];
  const commits: Record<string, unknown>[] = [];
  for (const line of stdout.split("\n")) {
    if (line.length === 0) continue;
    const fields = line.split("\t");
    if (fields.length !== 3) return null;
    const [id, unixTimeText, parentsText] = fields;
    if (!id || !HASH.test(id) || !/^[0-9]+$/.test(unixTimeText ?? "")) return null;
    const parents = parentsText === ""
      ? []
      : (parentsText ?? "").split(" ");
    if (parents.some((parent) => !HASH.test(parent))) return null;
    commits.push({
      id,
      unix_time: Number(unixTimeText),
      parents,
    });
  }
  return commits.length <= MAX_LOG_COMMITS ? commits : null;
}

function parseRefs(stdout: string): Record<string, unknown>[] | null {
  if (stdout.length === 0) return [];
  const refs: Record<string, unknown>[] = [];
  for (const line of stdout.split("\n")) {
    if (line.length === 0) continue;
    const fields = line.split("\t");
    if (fields.length !== 3) return null;
    const [name, target, objectType] = fields;
    if (
      !name
      || (!name.startsWith("refs/heads/") && !name.startsWith("refs/tags/"))
      || !target
      || !HASH.test(target)
      || !objectType
      || !["commit", "tag", "tree", "blob"].includes(objectType)
    ) {
      return null;
    }
    refs.push({ name, target, object_type: objectType });
  }
  return refs.length <= MAX_REFS ? refs : null;
}

async function handleHead(dependencies: GatewayDependencies): Promise<Response> {
  const [shaResult, branchResult] = await Promise.all([
    invokeGit(dependencies, "head-sha"),
    invokeGit(dependencies, "head-branch"),
  ]);

  const head = shaResult.ok && shaResult.stdout !== undefined
    ? parseHash(shaResult.stdout)
    : null;
  const branch = branchResult.ok && branchResult.stdout !== undefined
    ? branchResult.stdout.trim()
    : null;

  if (head === null && branch === null) {
    return mapGitFailure(shaResult.error === "git_command_failed" ? branchResult : shaResult);
  }
  if (branch !== null && (branch.length === 0 || branch.length > 1_024 || /[\r\n\0]/.test(branch))) {
    return errorResponse(502, "invalid_git_response", "Git metadata provider returned an invalid branch name");
  }

  return jsonResponse({
    head,
    branch,
    detached: head !== null && branch === null,
  });
}

async function handleLog(dependencies: GatewayDependencies): Promise<Response> {
  const result = await invokeGit(dependencies, "log");
  if (!result.ok || result.stdout === undefined) return mapGitFailure(result);
  const commits = parseLog(result.stdout);
  return commits === null
    ? errorResponse(502, "invalid_git_response", "Git metadata provider returned an invalid log projection")
    : jsonResponse({ commits });
}

async function handleRefs(dependencies: GatewayDependencies): Promise<Response> {
  const result = await invokeGit(dependencies, "refs");
  if (!result.ok || result.stdout === undefined) return mapGitFailure(result);
  const refs = parseRefs(result.stdout);
  return refs === null
    ? errorResponse(502, "invalid_git_response", "Git metadata provider returned an invalid refs projection")
    : jsonResponse({ refs });
}

export async function handleGitMetadataRequest(
  request: Request,
  dependencies: GatewayDependencies,
): Promise<Response | null> {
  const url = new URL(request.url);
  const operation = url.pathname === "/v1/git/head"
    ? "head"
    : url.pathname === "/v1/git/log"
      ? "log"
      : url.pathname === "/v1/git/refs"
        ? "refs"
        : null;
  if (!operation) return null;

  if (request.method !== "GET") {
    return errorResponse(405, "method_not_allowed", "GET required");
  }
  if (url.search || url.hash) {
    return errorResponse(400, "unsupported_git_query", "Git metadata routes do not accept query parameters");
  }

  if (operation === "head") return handleHead(dependencies);
  if (operation === "log") return handleLog(dependencies);
  return handleRefs(dependencies);
}
