export interface EditorHost {
  workspaceRoot: string;
  /** Text of a file: open-buffer content if open (unsaved edits included), else disk. Throws if missing. */
  readFile(relPath: string): Promise<string>;
  /** Called by the MCP write tools AFTER TrueForge approved the call. Looks up the user's per-hunk decision recorded
   *  for (relPath, sha256(proposedContent)); applies ONLY accepted hunks via WorkspaceEdit + save; records an undo
   *  checkpoint. If no recorded decision exists, it MUST open the review UI itself and wait (never write silently). */
  applyProposal(relPath: string, proposedContent: string, isNewFile: boolean): Promise<ApplyResult>;
  /** Runs a shell command in the workspace (cwd = root), streams output to an Anvil terminal/output channel,
   *  kills it on cancellation, 120 s cap. */
  runCommand(command: string, signal?: AbortSignal): Promise<{ exitCode: number | null; output: string; timedOut: boolean }>;
  /** Log a context/tool event so the panel can show it (e.g. "retrieve_context chose X because Y"). */
  emit(event: { kind: string; title: string; detail?: string; data?: unknown }): void;
}
export interface ApplyResult { applied: boolean; acceptedHunks: number; rejectedHunks: number; summary: string; }

export interface ContextItem { path: string; startLine: number; endLine: number; tokens: number; score: number;
  reason: string;            // human-readable WHY, e.g. "BM25 match on 'command','cli' + defines AppGroup"
  source: 'mention-file' | 'mention-symbol' | 'retrieval' | 'graph-neighbor' | 'test-sibling' | 'docs-sibling' | 'selection'; }
export interface ContextPack { query: string; budgetTokens: number; usedTokens: number; items: ContextItem[];
  excluded: { path: string; reason: string; tokens: number }[]; rendered: string; }
