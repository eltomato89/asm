/**
 * Strips terminal control sequences and control characters from server-supplied text before printing
 * (ESC/CSI/OSC sequences, C0 except \t, DEL, C1).
 */
export function stripControl(s: string): string {
  return s
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '') // CSI
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '') // OSC
    .replace(/\x1b[@-_]/g, '') // other two-byte escapes
    .replace(/[\x00-\x08\x0a-\x1f\x7f-\x9f]/g, '');
}
