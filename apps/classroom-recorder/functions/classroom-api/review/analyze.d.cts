interface TranscriptLine {
  speaker: string;
  start: number;
  end: number;
  text: string;
}
export function parseTranscript(text: string): TranscriptLine[];
export function batches(lines: TranscriptLine[], names: string[]): string[];
export function decode(content: string, lines: TranscriptLine[], allowed: Set<number>): {priority: string; category: string; evidence: (TranscriptLine & {line: number})[]}[];
export function analyze(doc: {transcript: string; teacherName?: string; student?: string}): Promise<{
  findings: ReturnType<typeof decode>;
  usage: {model: string; input: number; output: number; calls: number; lines: number; urgentChecked: number};
}>;
