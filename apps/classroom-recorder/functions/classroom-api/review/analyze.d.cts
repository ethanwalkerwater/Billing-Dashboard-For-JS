interface TranscriptLine {
  speaker: string;
  start: number;
  end: number;
  text: string;
}
export function parseTranscript(text: string): TranscriptLine[];
export function batches(lines: TranscriptLine[], names: string[]): string[];
export function decode(content: string, lines: TranscriptLine[], allowed: Set<number>): {evidence: (TranscriptLine & {line: number})[]}[];
