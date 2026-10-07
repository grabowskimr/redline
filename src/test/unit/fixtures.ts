import { SerialRange } from '../../model/review';
export function range(startLine: number, endLine = startLine): SerialRange {
  return { startLine, startChar: 0, endLine, endChar: 0 };
}
