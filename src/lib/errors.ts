export class CliUsageError extends Error {
  override readonly name = 'CliUsageError';
}

export class ToolCallError extends Error {
  override readonly name = 'ToolCallError';
  readonly structuredContent: Record<string, unknown>;
  readonly jsonOutput?: unknown;

  constructor(structuredContent: Record<string, unknown>, fallbackMessage: string, jsonOutput?: unknown) {
    super(typeof structuredContent.message === 'string' ? structuredContent.message : fallbackMessage);
    this.structuredContent = structuredContent;
    this.jsonOutput = jsonOutput;
  }

  get code(): string {
    return typeof this.structuredContent.code === 'string' ? this.structuredContent.code : 'tool_error';
  }

  get details(): Record<string, unknown> | undefined {
    const details = this.structuredContent.details;
    return details !== null && typeof details === 'object' && !Array.isArray(details)
      ? (details as Record<string, unknown>)
      : undefined;
  }
}
