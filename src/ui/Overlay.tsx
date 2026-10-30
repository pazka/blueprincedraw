import { formatBytes } from "../lib/images.ts";
import type { ImportProgress } from "../types.ts";

export function ProgressOverlay({
  title,
  progress,
  note,
  onDismiss,
}: {
  title: string;
  progress: ImportProgress;
  note?: string;
  onDismiss?: () => void;
}) {
  const readPct = progress.bytesTotal
    ? Math.min(100, (progress.bytesRead / progress.bytesTotal) * 100)
    : 0;
  const saved =
    progress.originalBytes > 0 && progress.storedBytes > 0
      ? Math.max(0, 100 - (progress.storedBytes / progress.originalBytes) * 100)
      : 0;

  return (
    <div className="bpd-overlay">
      <div className="bpd-panel">
        <h2>{title}</h2>

        <div className="bpd-bar">
          <div className="bpd-bar-fill" style={{ width: `${readPct}%` }} />
        </div>
        <div className="bpd-row">
          <span>Read</span>
          <span>
            {formatBytes(progress.bytesRead)} / {formatBytes(progress.bytesTotal)}
          </span>
        </div>
        <div className="bpd-row">
          <span>Elements</span>
          <span>{progress.elements.toLocaleString()}</span>
        </div>
        <div className="bpd-row">
          <span>Images stored</span>
          <span>{progress.filesDone.toLocaleString()}</span>
        </div>
        <div className="bpd-row">
          <span>Image payload</span>
          <span>
            {formatBytes(progress.originalBytes)} &rarr; {formatBytes(progress.storedBytes)}
            {saved > 1 ? ` (−${saved.toFixed(0)}%)` : ""}
          </span>
        </div>

        {note ? <p className="bpd-note">{note}</p> : null}
        {progress.phase === "error" ? (
          <p className="bpd-error">{progress.message}</p>
        ) : null}
        {onDismiss ? (
          <button className="bpd-button" onClick={onDismiss}>
            Close
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function BusyOverlay({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="bpd-overlay">
      <div className="bpd-panel">
        <h2>{title}</h2>
        <div className="bpd-bar">
          <div className="bpd-bar-indeterminate" />
        </div>
        {detail ? <p className="bpd-note">{detail}</p> : null}
      </div>
    </div>
  );
}
