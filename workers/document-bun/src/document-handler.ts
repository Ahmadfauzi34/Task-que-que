import {
  DocumentPayloadError,
  processDocument,
  writeDocumentResultAtomic,
} from "./processor";
import type { WorkerHandler } from "./registry";

export const documentProcessHandler: WorkerHandler = {
  taskName: "document.process",
  taskType: "cpu",

  async handle(task, context) {
    const result = await processDocument(task.task_id, task.payload);
    await writeDocumentResultAtomic(context.outputDir, result);
  },

  classifyError(error) {
    return error instanceof DocumentPayloadError ? "invalid_payload" : "processing_failed";
  },
};
