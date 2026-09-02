import {
  MAX_RESOLVED_STEP_PAYLOAD_BYTES,
  WorkflowResultReadError,
  WorkflowResultReferenceError,
  resolveResultReferences,
  validateResultReferencePayload,
  type WorkflowResultReference,
} from "./result-reference";
import {
  WorkflowExecutionError,
  WorkflowPayloadError,
  executeWorkflow,
  type WorkflowGatewayConfig,
  type WorkflowResult,
} from "./workflow-handler";

export const MAX_WORKFLOW_OUTPUTS = 32;
export const MAX_WORKFLOW_OUTPUT_BYTES = 128 * 1024;

const SAFE_OUTPUT_NAME = /^[A-Za-z0-9._:-]{1,64}$/;
const encoder = new TextEncoder();

export interface DeclaredWorkflowDefinition {
  steps: unknown;
  outputs: Record<string, WorkflowResultReference>;
}

export interface WorkflowResultWithOutputs extends WorkflowResult {
  outputs: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function own(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function parseOutputReference(
  name: string,
  raw: unknown,
  stepIds: ReadonlySet<string>,
): WorkflowResultReference {
  if (!isRecord(raw)) {
    throw new WorkflowPayloadError(
      `workflow output ${name} must be an exact result reference object`,
    );
  }
  try {
    const count = validateResultReferencePayload(raw, stepIds);
    if (count !== 1 || !own(raw, "$from") || !own(raw, "path") || Object.keys(raw).length !== 2) {
      throw new WorkflowPayloadError(
        `workflow output ${name} must contain exactly one $from/path reference`,
      );
    }
  } catch (error) {
    if (error instanceof WorkflowResultReferenceError) {
      throw new WorkflowPayloadError(`workflow output ${name}: ${error.message}`);
    }
    throw error;
  }
  return { $from: raw.$from as string, path: raw.path as string };
}

export function parseDeclaredWorkflow(rawPayload: string): DeclaredWorkflowDefinition {
  let value: unknown;
  try {
    value = JSON.parse(rawPayload);
  } catch {
    throw new WorkflowPayloadError("workflow payload must be valid JSON");
  }
  if (!isRecord(value)) {
    throw new WorkflowPayloadError("workflow payload must be a JSON object");
  }
  for (const key of Object.keys(value)) {
    if (key !== "steps" && key !== "outputs") {
      throw new WorkflowPayloadError(`unsupported workflow field: ${key}`);
    }
  }

  const stepIds = new Set<string>();
  if (Array.isArray(value.steps)) {
    for (const step of value.steps) {
      if (isRecord(step) && typeof step.id === "string") stepIds.add(step.id);
    }
  }

  const outputsRaw = value.outputs ?? {};
  if (!isRecord(outputsRaw)) {
    throw new WorkflowPayloadError("workflow.outputs must be a JSON object");
  }
  const entries = Object.entries(outputsRaw);
  if (entries.length > MAX_WORKFLOW_OUTPUTS) {
    throw new WorkflowPayloadError(
      `workflow supports at most ${MAX_WORKFLOW_OUTPUTS} declared outputs`,
    );
  }

  const outputs: Record<string, WorkflowResultReference> = {};
  for (const [name, reference] of entries) {
    if (!SAFE_OUTPUT_NAME.test(name)) {
      throw new WorkflowPayloadError(`workflow output name ${name} is invalid`);
    }
    outputs[name] = parseOutputReference(name, reference, stepIds);
  }

  return { steps: value.steps, outputs };
}

function completedStepTaskIds(result: WorkflowResult): Map<string, number> {
  return new Map(result.steps.map((step) => [step.id, step.task_id] as const));
}

async function resolveDeclaredOutputs(
  declarations: Record<string, WorkflowResultReference>,
  result: WorkflowResult,
  config: WorkflowGatewayConfig,
): Promise<Record<string, unknown>> {
  if (Object.keys(declarations).length === 0) return {};
  let resolved: unknown;
  try {
    resolved = await resolveResultReferences(declarations, completedStepTaskIds(result), {
      origin: config.resultOrigin ?? "http://127.0.0.1:7331",
      requestTimeoutMs: config.requestTimeoutMs,
      fetchImpl: config.resultFetchImpl,
    });
  } catch (error) {
    if (error instanceof WorkflowResultReferenceError) {
      throw new WorkflowPayloadError(`workflow output declaration: ${error.message}`);
    }
    if (error instanceof WorkflowResultReadError) {
      throw new WorkflowExecutionError(`workflow output resolution: ${error.message}`);
    }
    throw error;
  }
  if (!isRecord(resolved)) {
    throw new WorkflowExecutionError("resolved workflow outputs must be a JSON object");
  }
  const bytes = encoder.encode(JSON.stringify(resolved)).byteLength;
  if (bytes > MAX_WORKFLOW_OUTPUT_BYTES) {
    throw new WorkflowExecutionError("resolved workflow outputs exceed 128 KiB");
  }
  return resolved;
}

export async function executeWorkflowWithDeclaredOutputs(
  workflowTaskId: number,
  rawPayload: string,
  config: WorkflowGatewayConfig,
): Promise<WorkflowResultWithOutputs> {
  const declared = parseDeclaredWorkflow(rawPayload);
  const base = await executeWorkflow(
    workflowTaskId,
    JSON.stringify({ steps: declared.steps }),
    config,
  );
  const outputs = await resolveDeclaredOutputs(declared.outputs, base, config);
  const result: WorkflowResultWithOutputs = { ...base, outputs };
  if (encoder.encode(JSON.stringify(result)).byteLength > MAX_RESOLVED_STEP_PAYLOAD_BYTES) {
    throw new WorkflowExecutionError("workflow result projection exceeds 256 KiB");
  }
  return result;
}
