import { CliUsageError, ToolCallError } from './errors.ts';

type ErrorOutput = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
};

export function reportCommandError(error: unknown, json: boolean, output: ErrorOutput): 1 | 2 {
  if (error instanceof ToolCallError) {
    if (json) {
      output.stdout(
        `${JSON.stringify(error.jsonOutput === undefined ? error.structuredContent : error.jsonOutput)}\n`,
      );
    }
    output.stderr(`${error.code}: ${error.message}\n`);
    const topupUrl = error.details?.topup_url;
    if (typeof topupUrl === 'string') output.stderr(`Top up: ${topupUrl}\n`);
    return 1;
  }
  if (error instanceof CliUsageError) {
    output.stderr(`Error: ${error.message}\n`);
    return 2;
  }
  output.stderr(`Error: ${error instanceof Error ? error.message : 'Unexpected error occurred'}\n`);
  return 1;
}
