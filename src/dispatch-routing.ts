import type { JevRouter } from "./jev-router.js";
import { finalizeRoutedTasks, type PreparedTask, type ResolvedTask } from "./policy.js";
import type { RoutingModelCandidate, RoutingPurpose, RoutingToolCandidate } from "./routing-types.js";

/** Frozen catalog projection: no tool schema, executable, path or credential crosses the selector. */
export interface RoutingCatalog {
  readonly models: readonly RoutingModelCandidate[];
  readonly tools: readonly RoutingToolCandidate[];
}

/**
 * Resolve every worker before allowing a launch. Selection is ordered deliberately: a failed
 * earlier worker does not initiate further paid requests. Each task keeps its original deadline.
 * The injected owner assertion runs after every await, including a successful but cancelled call.
 */
export async function routePreparedTasks(
  prepared: readonly PreparedTask[],
  catalog: RoutingCatalog,
  router: Pick<JevRouter, "select">,
  options: { purpose: RoutingPurpose; signal: AbortSignal; assertOwner(): void },
): Promise<ResolvedTask[]> {
  const decisions = [];
  for (let index = 0; index < prepared.length; index++) {
    options.assertOwner();
    const task = prepared[index]!;
    if (task.deadline !== undefined && Date.now() >= task.deadline) {
      throw new Error(`Task ${index + 1}: timeout before Jev selection; no child was started.`);
    }
    const names = new Set(task.candidateTools);
    const result = await router.select({
      task: task.task,
      models: catalog.models,
      tools: catalog.tools.filter((tool) => names.has(tool.name)),
      constraints: {
        profile: task.profile,
        requestedThinking: task.requestedThinking,
        structuredOutput: task.outputSchema !== undefined,
      },
    }, { purpose: options.purpose, taskIndex: index, deadline: task.deadline, signal: options.signal });
    options.assertOwner();
    if (!result.ok) throw new Error(`Task ${index + 1}: Jev ${result.code}: ${result.message}`);
    if (result.persistenceErrors?.length) {
      throw new Error(`Task ${index + 1}: routing receipts could not be persisted; no child was started.`);
    }
    decisions.push(result.decision);
  }
  const finalized = finalizeRoutedTasks(prepared, decisions, catalog.models);
  if (!finalized.ok) throw new Error(finalized.error);
  // An earlier parallel task may have expired while a later task was being selected.
  for (let index = 0; index < finalized.tasks.length; index++) {
    const deadline = finalized.tasks[index]!.deadline;
    if (deadline !== undefined && Date.now() >= deadline) throw new Error(`Task ${index + 1}: timeout during routing; no child was started.`);
  }
  options.assertOwner();
  return finalized.tasks;
}
