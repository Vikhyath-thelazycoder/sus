import { Annotation, END, START, StateGraph } from "@langchain/langgraph";

/**
 * P1 platform check (T-1.7): a minimal two-node LangGraph used to measure bundle size and CPU on Workers.
 * P4 replaces these nodes with the real pipeline (guard → rewrite → retrieve → rerank → generate → validate).
 * Nodes stay plain functions so the graph can be removed if it doesn't fit the free plan.
 */
const State = Annotation.Root({
  question: Annotation<string>,
  normalized: Annotation<string>,
  answer: Annotation<string>,
});
type GraphState = typeof State.State;

export function normalizeQuestion(state: GraphState): Partial<GraphState> {
  return { normalized: state.question.normalize("NFKC").trim().replace(/\s+/g, " ") };
}

export function echoAnswer(state: GraphState): Partial<GraphState> {
  return { answer: `received: ${state.normalized}` };
}

export const spikeGraph = new StateGraph(State)
  .addNode("normalize", normalizeQuestion)
  .addNode("respond", echoAnswer)
  .addEdge(START, "normalize")
  .addEdge("normalize", "respond")
  .addEdge("respond", END)
  .compile();
