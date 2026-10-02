/**
 * Child runner for the durable backend chaos test (spawned by
 * test/durableBackend.test.ts, not a test itself): starts one durable task
 * whose faux model calls the real `bash` tool with a long sleep, so the
 * parent can SIGKILL this process mid-tool-call.
 *
 * Usage: tsx test/durable-crash-child.ts <databasePath> <piDir> <taskId>
 */

import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { runDurableTask } from "../src/subagent/durable.js";

const [databasePath, piDir, taskId] = process.argv.slice(2);
if (!databasePath || !piDir || !taskId) {
  console.error("usage: durable-crash-child.ts <databasePath> <piDir> <taskId>");
  process.exit(1);
}

const models = createModels();
const faux = fauxProvider();
models.setProvider(faux.provider);
// First and only step: call bash with a long sleep, so SIGKILL lands
// mid-tool-call. `bash` is not replay-safe, so the resuming process tells
// the model the call was interrupted instead of rerunning the sleep.
faux.setResponses([
  fauxAssistantMessage(
    [fauxToolCall("bash", { command: "sleep 30" })],
    { stopReason: "toolUse" },
  ),
]);

void runDurableTask({
  piDir,
  taskId,
  task: "Run the long sleep.",
  databasePath,
  models: () => models,
  onSubmitted: (conversationId) => {
    // The parent waits for this marker: the submission is durably admitted
    // and the bash tool call is in flight.
    console.log(`M2 child: submitted ${conversationId}`);
  },
}).catch((error) => {
  console.error("M2 child failed:", error);
  process.exit(1);
});

// The in-flight bash tool keeps the process alive until the parent kills it.
setTimeout(() => process.exit(3), 60_000).unref();
